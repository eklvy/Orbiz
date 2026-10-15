"""Specials (menu, cart and order agree on the server price), polls, reviews, the leaderboard
and "popular with your classmates" (k ≥ 5) over HTTP against the real database."""

from datetime import UTC, datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo

import psycopg
import pytest
from fastapi.testclient import TestClient

from tests.integration.conftest import OutletFixture, User, confirm_payment, new_key

pytestmark = pytest.mark.integration


def today() -> str:
    return datetime.now(ZoneInfo("Asia/Kolkata")).date().isoformat()


def paid_order(
    api: TestClient,
    sql: psycopg.Connection[dict[str, Any]],
    outlet: OutletFixture,
    student: User,
    item: Any,
    quantity: int = 1,
) -> dict[str, Any]:
    response = api.post(
        "/api/v1/orders",
        headers={**student.headers, "Idempotency-Key": new_key()},
        json={
            "outlet_id": str(outlet.id),
            "pickup_slot_id": str(outlet.slot_id),
            "items": [{"menu_item_id": str(item), "quantity": quantity}],
        },
    )
    assert response.status_code == 201, response.text
    order: dict[str, Any] = response.json()
    confirm_payment(sql, order["id"])
    return order


def test_special_price_is_the_same_on_menu_cart_and_order(
    api: TestClient,
    outlet: OutletFixture,
    manager: User,
    students: list[User],
    sql: psycopg.Connection[dict[str, Any]],
) -> None:
    saved = api.put(
        f"/api/v1/manage/outlets/{outlet.id}/specials",
        headers=manager.headers,
        json={
            "menu_item_id": str(outlet.sandwich_id),
            "special_date": today(),
            "discount_percent": 15,
            "portions": 3,
        },
    )
    assert saved.status_code == 200, saved.text
    assert saved.json()[0]["special_price_paise"] == 5950  # ₹70 less 15%
    student = students[0]
    assert (
        api.put(
            f"/api/v1/manage/outlets/{outlet.id}/specials",
            headers=student.headers,
            json={
                "menu_item_id": str(outlet.sandwich_id),
                "special_date": today(),
                "discount_percent": 90,
                "portions": 3,
            },
        ).status_code
        == 403
    )

    menu = api.get(f"/api/v1/outlets/{outlet.id}/menu").json()
    sandwich = next(i for i in menu["uncategorized"] if i["id"] == str(outlet.sandwich_id))
    assert sandwich["special"]["unit_price_paise"] == 5950
    api.put(
        f"/api/v1/cart/items/{outlet.sandwich_id}",
        headers=student.headers,
        json={"quantity": 2, "replace_cart": True},
    )
    cart = api.get("/api/v1/cart", headers=student.headers).json()
    assert cart["subtotal_paise"] == 11900
    order = paid_order(api, sql, outlet, student, outlet.sandwich_id, quantity=2)
    assert order["total_paise"] == 11900, "the order charges the price the cart showed"
    too_many = api.post(
        "/api/v1/orders",
        headers={**students[1].headers, "Idempotency-Key": new_key()},
        json={
            "outlet_id": str(outlet.id),
            "pickup_slot_id": str(outlet.slot_id),
            "items": [{"menu_item_id": str(outlet.sandwich_id), "quantity": 2}],
        },
    )
    assert too_many.status_code == 409
    assert too_many.json()["error"]["details"]["reason"] == "special_portions_left"


def test_poll_vote_and_publish(
    api: TestClient, outlet: OutletFixture, manager: User, students: list[User]
) -> None:
    created = api.post(
        f"/api/v1/manage/outlets/{outlet.id}/polls",
        headers=manager.headers,
        json={
            "question": "Tomorrow's special?",
            "menu_item_ids": [str(outlet.chai_id), str(outlet.sandwich_id)],
            "closes_at": (datetime.now(UTC) + timedelta(hours=2)).isoformat(),
            "special_date": (datetime.now(ZoneInfo("Asia/Kolkata")) + timedelta(days=1))
            .date()
            .isoformat(),
            "special_discount_percent": 20,
            "special_portions": 25,
        },
    )
    assert created.status_code == 201, created.text
    poll = created.json()
    sandwich_option = next(
        o for o in poll["options"] if o["menu_item_id"] == str(outlet.sandwich_id)
    )
    for student in students[:3]:
        voted = api.post(
            f"/api/v1/polls/{poll['id']}/vote",
            headers=student.headers,
            json={"option_id": sandwich_option["id"]},
        )
        assert voted.status_code == 200, voted.text
    twice = api.post(
        f"/api/v1/polls/{poll['id']}/vote",
        headers=students[0].headers,
        json={"option_id": sandwich_option["id"]},
    )
    assert twice.status_code == 409
    public = api.get(f"/api/v1/outlets/{outlet.id}/polls").json()
    live = next(p for p in public if p["id"] == poll["id"])
    assert live["total_votes"] == 3
    assert next(o for o in live["options"] if o["id"] == sandwich_option["id"])["percent"] == 100
    mine = api.get(f"/api/v1/outlets/{outlet.id}/polls/my-votes", headers=students[0].headers)
    assert mine.json() == [{"poll_id": poll["id"], "option_id": sandwich_option["id"]}]

    published = api.post(
        f"/api/v1/manage/polls/{poll['id']}/publish", headers=manager.headers, json={}
    )
    assert published.status_code == 200, published.text
    assert published.json()["winner_option_id"] == sandwich_option["id"]
    specials = api.get(f"/api/v1/outlets/{outlet.id}/specials").json()
    assert any(
        s["menu_item_id"] == str(outlet.sandwich_id)
        and s["discount_percent"] == 20
        and s["portions_total"] == 25
        for s in specials
    )


def test_review_reply_and_leaderboard(
    api: TestClient,
    outlet: OutletFixture,
    kitchen: User,
    students: list[User],
    sql: psycopg.Connection[dict[str, Any]],
) -> None:
    student = students[2]
    order = paid_order(api, sql, outlet, student, outlet.chai_id)
    early = api.post(
        f"/api/v1/orders/{order['id']}/review",
        headers=student.headers,
        json={"taste": 5, "hygiene": 5, "speed": 5, "value": 5},
    )
    assert early.status_code == 409
    for step in ("confirmed", "preparing", "ready_for_pickup"):
        api.post(
            f"/api/v1/staff/orders/{order['id']}/transition",
            headers=kitchen.headers,
            json={"to_status": step},
        )
    code = api.get(f"/api/v1/orders/{order['id']}", headers=student.headers).json()["pickup_code"]
    api.post(
        f"/api/v1/staff/orders/{order['id']}/verify-pickup",
        headers=kitchen.headers,
        json={"code": code},
    )
    before = api.get("/api/v1/loyalty", headers=student.headers).json()["balance_points"]
    review = api.post(
        f"/api/v1/orders/{order['id']}/review",
        headers=student.headers,
        json={"taste": 4, "hygiene": 5, "speed": 3, "value": 4, "comment": "Strong chai"},
    )
    assert review.status_code == 201, review.text
    assert "user_id" not in review.json()
    after = api.get("/api/v1/loyalty", headers=student.headers).json()["balance_points"]
    assert after - before == 15

    waiting = api.get(f"/api/v1/outlets/{outlet.id}/reviews", params={"needs_reply": True}).json()
    assert [r["id"] for r in waiting] == [review.json()["id"]]
    stranger = api.post(
        f"/api/v1/staff/reviews/{review.json()['id']}/reply",
        headers=students[3].headers,
        json={"reply": "Not my outlet"},
    )
    assert stranger.status_code == 404
    replied = api.post(
        f"/api/v1/staff/reviews/{review.json()['id']}/reply",
        headers=kitchen.headers,
        json={"reply": "Thanks! Come back tomorrow."},
    )
    assert replied.json()["reply"] == "Thanks! Come back tomorrow."
    assert (
        api.get(f"/api/v1/outlets/{outlet.id}/reviews", params={"needs_reply": True}).json() == []
    )
    board = api.get("/api/v1/ratings").json()
    mine = next(r for r in board if r["outlet_id"] == str(outlet.id))
    assert (mine["review_count"], mine["overall"]) == (1, 4.0)


def test_popular_needs_at_least_five_students(
    api: TestClient,
    outlet: OutletFixture,
    students: list[User],
    sql: psycopg.Connection[dict[str, Any]],
) -> None:
    def chai_listed() -> bool:
        items = api.get("/api/v1/popular", headers=students[0].headers, params={"limit": 20}).json()
        return any(i["menu_item_id"] == str(outlet.chai_id) for i in items)

    for student in students[:4]:
        paid_order(api, sql, outlet, student, outlet.chai_id)
    assert not chai_listed(), "four students is below the privacy threshold"
    paid_order(api, sql, outlet, students[4], outlet.chai_id)
    assert chai_listed(), "five different students make it popular"
