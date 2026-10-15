"""Notification Center over HTTP, and one pass of the Expo push sender against a mocked Expo
endpoint (nothing is sent to Expo)."""

import json
from typing import Any

import httpx2 as httpx
import psycopg
import pytest
from fastapi.testclient import TestClient

from app.core.config import Settings
from app.core.db import Database
from app.modules.notifications.service import send_pending_pushes
from tests.integration.conftest import OutletFixture, User, confirm_payment, new_key, sign_up

pytestmark = pytest.mark.integration


@pytest.fixture
def anyio_backend() -> str:
    return "asyncio"


def test_order_events_reach_the_notification_center(
    api: TestClient,
    outlet: OutletFixture,
    kitchen: User,
    gotrue: httpx.Client,
    sql: psycopg.Connection[dict[str, Any]],
) -> None:
    student = sign_up(gotrue, full_name="IT Notified Student")
    other = sign_up(gotrue, full_name="IT Other Student")
    assert api.get("/api/v1/notifications", headers=student.headers).json() == {
        "items": [],
        "unread_count": 0,
        "next_cursor": None,
    }
    order = api.post(
        "/api/v1/orders",
        headers={**student.headers, "Idempotency-Key": new_key()},
        json={
            "outlet_id": str(outlet.id),
            "pickup_slot_id": str(outlet.slot_id),
            "items": [{"menu_item_id": str(outlet.sandwich_id), "quantity": 1}],
        },
    ).json()
    confirm_payment(sql, order["id"])
    for step in ("confirmed", "preparing", "ready_for_pickup"):
        api.post(
            f"/api/v1/staff/orders/{order['id']}/transition",
            headers=kitchen.headers,
            json={"to_status": step},
        )

    page = api.get("/api/v1/notifications", headers=student.headers).json()
    token = page["items"][0]["title"].split(" ")[0]
    assert {n["title"] for n in page["items"]} == {
        f"Order {token} placed",
        f"{token} is being prepared",
        f"{token} is ready for pickup",
        "You earned 7 points",
    }
    assert page["unread_count"] == 4
    assert all(n["data"].get("order_id") == order["id"] for n in page["items"])
    only_loyalty = api.get(
        "/api/v1/notifications", headers=student.headers, params={"category": "loyalty"}
    ).json()
    assert [n["title"] for n in only_loyalty["items"]] == ["You earned 7 points"]
    assert api.get("/api/v1/notifications", headers=other.headers).json()["items"] == []

    first = page["items"][0]["id"]
    marked = api.post(
        "/api/v1/notifications/read", headers=other.headers, json={"ids": [first]}
    ).json()
    assert marked == {"marked": 0}, "nobody else can touch them"
    assert api.post(
        "/api/v1/notifications/read", headers=student.headers, json={"ids": [first]}
    ).json() == {"marked": 1}
    assert api.post("/api/v1/notifications/read", headers=student.headers, json={}).json() == {
        "marked": 3
    }
    assert api.get("/api/v1/notifications", headers=student.headers).json()["unread_count"] == 0


@pytest.mark.anyio
async def test_push_sender_posts_pending_notifications_to_expo(
    settings: Settings,
    api: TestClient,
    outlet: OutletFixture,
    gotrue: httpx.Client,
    sql: psycopg.Connection[dict[str, Any]],
) -> None:
    student = sign_up(gotrue, full_name="IT Push Student")
    token = f"ExponentPushToken[it{student.id.hex[:16]}]"
    registered = api.post(
        "/api/v1/notifications/push-tokens",
        headers=student.headers,
        json={"token": token, "platform": "android"},
    )
    assert registered.status_code == 204
    order = api.post(
        "/api/v1/orders",
        headers={**student.headers, "Idempotency-Key": new_key()},
        json={
            "outlet_id": str(outlet.id),
            "pickup_slot_id": str(outlet.slot_id),
            "items": [{"menu_item_id": str(outlet.sandwich_id), "quantity": 1}],
        },
    ).json()
    confirm_payment(sql, order["id"])

    sent: list[dict[str, Any]] = []

    def expo(request: httpx.Request) -> httpx.Response:
        sent.extend(json.loads(request.content))
        return httpx.Response(200, json={"data": []})

    assert settings.database_url is not None
    db = Database(settings.database_url.get_secret_value(), min_size=1, max_size=2)
    await db.open()
    try:
        async with httpx.AsyncClient(transport=httpx.MockTransport(expo)) as client:
            await send_pending_pushes(db, client, "https://expo.test/push")
            mine = [m for m in sent if m["to"] == token]
            assert {m["title"] for m in mine} >= {"You earned 7 points"}
            assert any(
                m["title"].endswith(" placed") and m["data"]["order_id"] == order["id"]
                for m in mine
            )
            before = len(sent)
            await send_pending_pushes(db, client, "https://expo.test/push")
            assert [m for m in sent[before:] if m["to"] == token] == [], "each is pushed once"
    finally:
        await db.close()
