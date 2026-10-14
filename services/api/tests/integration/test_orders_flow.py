"""The full ordering flow through the HTTP API, plus manager operations."""

from typing import Any

import psycopg
import pytest
from fastapi.testclient import TestClient

from tests.integration.conftest import OutletFixture, User, confirm_payment, new_key

pytestmark = pytest.mark.integration


def place(
    api: TestClient,
    student: User,
    outlet: OutletFixture,
    items: list[dict[str, Any]],
    *,
    slot: Any = None,
    key: str | None = None,
) -> Any:
    return api.post(
        "/api/v1/orders",
        headers={**student.headers, "Idempotency-Key": key or new_key()},
        json={
            "outlet_id": str(outlet.id),
            "pickup_slot_id": str(slot or outlet.slot_id),
            "items": items,
        },
    )


def test_student_to_kitchen_to_pickup(
    api: TestClient,
    outlet: OutletFixture,
    students: list[User],
    kitchen: User,
    sql: psycopg.Connection[dict[str, Any]],
) -> None:
    student = students[1]
    lines = [
        {"menu_item_id": str(outlet.chai_id), "quantity": 2},
        {"menu_item_id": str(outlet.sandwich_id), "quantity": 1},
    ]

    created = place(api, student, outlet, lines)
    assert created.status_code == 201, created.text
    order = created.json()
    assert order["status"] == "payment_pending"
    assert order["payment_status"] == "unpaid"
    assert order["total_paise"] == 2 * 2000 + 7000, "totals are computed by the server"
    assert order["token_label"] is None, "no token until paid"
    assert order["reservation_expires_at"] is not None
    assert [e["event_type"] for e in order["events"]] == ["created"]

    # The kitchen cannot act on an unpaid order.
    early = api.post(
        f"/api/v1/staff/orders/{order['id']}/transition",
        headers=kitchen.headers,
        json={"to_status": "confirmed"},
    )
    assert early.status_code == 409

    confirm_payment(sql, order["id"])  # stand-in for the Phase 5 verified-payment webhook

    mine = api.get(f"/api/v1/orders/{order['id']}", headers=student.headers).json()
    assert mine["status"] == "placed"
    assert mine["token_label"].startswith("T-")
    assert mine["pickup_code"] and len(mine["pickup_code"]) == 6
    assert mine["queue_position"] == 0

    queue = api.get(f"/api/v1/staff/outlets/{outlet.id}/orders", headers=kitchen.headers)
    assert queue.status_code == 200, queue.text
    queued = next(o for o in queue.json() if o["id"] == order["id"])
    assert queued["pickup_code"] is None, "staff never see the pickup code"

    for target in ("confirmed", "preparing", "ready_for_pickup"):
        step = api.post(
            f"/api/v1/staff/orders/{order['id']}/transition",
            headers=kitchen.headers,
            json={"to_status": target},
        )
        assert step.status_code == 200, step.text
        assert step.json()["status"] == target

    wrong = api.post(
        f"/api/v1/staff/orders/{order['id']}/verify-pickup",
        headers=kitchen.headers,
        json={"code": "ZZZZZZ"},
    )
    assert wrong.status_code == 422
    assert wrong.json()["error"]["details"]["reason"] == "invalid_pickup_code"
    attempts = sql.execute(
        "select failed_attempts from public.order_pickup_codes where order_id = %s", (order["id"],)
    ).fetchone()
    assert attempts is not None and attempts["failed_attempts"] == 1, (
        "the failed attempt was committed"
    )

    done = api.post(
        f"/api/v1/staff/orders/{order['id']}/verify-pickup",
        headers=kitchen.headers,
        json={"code": mine["pickup_code"]},
    )
    assert done.status_code == 200, done.text
    final = done.json()
    assert final["status"] == "completed"
    assert [e["to_status"] for e in final["events"]] == [
        "payment_pending",
        "placed",
        "confirmed",
        "preparing",
        "ready_for_pickup",
        "completed",
    ]

    history = api.get("/api/v1/orders", headers=student.headers).json()
    assert history["items"][0]["id"] == order["id"]


def test_idempotency_over_http(
    api: TestClient, outlet: OutletFixture, students: list[User]
) -> None:
    student = students[2]
    key = new_key()
    lines = [{"menu_item_id": str(outlet.chai_id), "quantity": 1}]
    first = place(api, student, outlet, lines, key=key)
    retry = place(api, student, outlet, lines, key=key)
    assert first.status_code == retry.status_code == 201
    assert first.json()["id"] == retry.json()["id"]

    reused = place(
        api, student, outlet, [{"menu_item_id": str(outlet.chai_id), "quantity": 3}], key=key
    )
    assert reused.status_code == 409
    assert reused.json()["error"]["details"]["reason"] == "idempotency_key_reused"

    missing = api.post(
        "/api/v1/orders",
        headers=student.headers,
        json={"outlet_id": str(outlet.id), "pickup_slot_id": str(outlet.slot_id), "items": lines},
    )
    assert missing.status_code == 422, "an Idempotency-Key header is required"


def test_client_supplied_prices_are_rejected(
    api: TestClient, outlet: OutletFixture, students: list[User]
) -> None:
    response = api.post(
        "/api/v1/orders",
        headers={**students[2].headers, "Idempotency-Key": new_key()},
        json={
            "outlet_id": str(outlet.id),
            "pickup_slot_id": str(outlet.slot_id),
            "items": [{"menu_item_id": str(outlet.chai_id), "quantity": 1, "price_paise": 1}],
            "total_paise": 1,
        },
    )
    assert response.status_code == 422


def test_business_rule_errors_are_reported_with_reasons(
    api: TestClient, outlet: OutletFixture, students: list[User], manager: User
) -> None:
    student = students[3]
    over_stock = place(
        api, student, outlet, [{"menu_item_id": str(outlet.chai_id), "quantity": 11}]
    )
    assert over_stock.status_code == 409, "only 10 in stock"
    assert over_stock.json()["error"]["details"]["reason"] == "insufficient_stock"
    over_limit = place(
        api, student, outlet, [{"menu_item_id": str(outlet.chai_id), "quantity": 21}]
    )
    assert over_limit.status_code == 422, "more than 20 per line is invalid input"

    closed = api.post(
        f"/api/v1/manage/outlets/{outlet.id}/status",
        headers=manager.headers,
        json={"status": "closed", "reason": "Deep cleaning"},
    )
    assert closed.status_code == 204, closed.text
    blocked = place(
        api, student, outlet, [{"menu_item_id": str(outlet.sandwich_id), "quantity": 1}]
    )
    assert blocked.status_code == 409
    assert blocked.json()["error"]["details"]["reason"] == "outlet_not_accepting_orders"
    assert "Deep cleaning" in blocked.json()["error"]["message"]


def test_cancellation_releases_stock(
    api: TestClient,
    outlet: OutletFixture,
    students: list[User],
    sql: psycopg.Connection[dict[str, Any]],
) -> None:
    student = students[4]
    order = place(
        api, student, outlet, [{"menu_item_id": str(outlet.chai_id), "quantity": 4}]
    ).json()

    def stock() -> int:
        row = sql.execute(
            "select quantity_available from public.inventory where menu_item_id = %s",
            (outlet.chai_id,),
        ).fetchone()
        assert row is not None
        return int(row["quantity_available"])

    assert stock() == 6

    cancelled = api.post(f"/api/v1/orders/{order['id']}/cancel", headers=student.headers, json={})
    assert cancelled.status_code == 200, cancelled.text
    assert cancelled.json()["status"] == "cancelled"
    assert cancelled.json()["refund_status"] == "none"
    assert stock() == 10

    again = api.post(f"/api/v1/orders/{order['id']}/cancel", headers=student.headers, json={})
    assert again.status_code == 409
    assert again.json()["error"]["details"]["reason"] == "invalid_transition"


def test_other_users_cannot_see_or_touch_an_order(
    api: TestClient, outlet: OutletFixture, students: list[User]
) -> None:
    owner, other = students[5], students[0]
    order = place(
        api, owner, outlet, [{"menu_item_id": str(outlet.sandwich_id), "quantity": 1}]
    ).json()
    assert api.get(f"/api/v1/orders/{order['id']}", headers=other.headers).status_code == 404
    assert (
        api.post(f"/api/v1/orders/{order['id']}/cancel", headers=other.headers, json={}).status_code
        == 404
    )
    staff_try = api.post(
        f"/api/v1/staff/orders/{order['id']}/transition",
        headers=other.headers,
        json={"to_status": "confirmed"},
    )
    assert staff_try.status_code == 404
    assert (
        api.get(f"/api/v1/staff/outlets/{outlet.id}/orders", headers=other.headers).status_code
        == 403
    )


def test_manager_operations_and_their_authorization(
    api: TestClient, outlet: OutletFixture, manager: User, kitchen: User, students: list[User]
) -> None:
    restock = api.post(
        f"/api/v1/manage/menu-items/{outlet.chai_id}/stock-adjustments",
        headers=manager.headers,
        json={"delta": 5, "reason": "restock", "note": "Morning delivery"},
    )
    assert restock.status_code == 200, restock.text
    assert restock.json()["quantity_available"] == 15

    for user in (kitchen, students[0]):
        denied = api.post(
            f"/api/v1/manage/menu-items/{outlet.chai_id}/stock-adjustments",
            headers=user.headers,
            json={"delta": 5, "reason": "restock"},
        )
        assert denied.status_code == 403

    sold_out = api.put(
        f"/api/v1/manage/menu-items/{outlet.sandwich_id}/availability",
        headers=manager.headers,
        json={"manual_status": "sold_out"},
    )
    assert sold_out.status_code == 204
    menu = api.get(f"/api/v1/outlets/{outlet.id}/menu").json()["uncategorized"]
    assert {i["name"]: i["stock_status"] for i in menu}["Test Sandwich"] == "sold_out"

    on_break = api.post(
        f"/api/v1/manage/outlets/{outlet.id}/status",
        headers=manager.headers,
        json={"status": "on_break", "reason": "Tea break", "break_minutes": 10},
    )
    assert on_break.status_code == 204
    detail = api.get(f"/api/v1/outlets/{outlet.id}").json()
    assert detail["status"] == "on_break"
    assert detail["accepting_orders"] is False
    assert detail["status_reason"] == "Tea break"
