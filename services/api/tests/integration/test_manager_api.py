"""Manager console endpoints against the real stack: settings, hours, menu editing with live
student menus, today's counts, slots, staff by email, the refunds desk, and the daily summary.
Every endpoint is also checked against callers who must not use it."""

from typing import Any

import psycopg
import pytest
from fastapi.testclient import TestClient

from tests.integration.conftest import OutletFixture, User, confirm_payment, new_key

pytestmark = pytest.mark.integration


def paid_order(
    api: TestClient, sql: psycopg.Connection[dict[str, Any]], outlet: OutletFixture, student: User
) -> str:
    response = api.post(
        "/api/v1/orders",
        headers={**student.headers, "Idempotency-Key": new_key()},
        json={
            "outlet_id": str(outlet.id),
            "pickup_slot_id": str(outlet.slot_id),
            "items": [{"menu_item_id": str(outlet.sandwich_id), "quantity": 1}],
        },
    )
    assert response.status_code == 201, response.text
    order_id: str = response.json()["id"]
    confirm_payment(sql, order_id)
    return order_id


def collect(api: TestClient, kitchen: User, student: User, order_id: str) -> None:
    for step in ("confirmed", "preparing", "ready_for_pickup"):
        moved = api.post(
            f"/api/v1/staff/orders/{order_id}/transition",
            headers=kitchen.headers,
            json={"to_status": step},
        )
        assert moved.status_code == 200, moved.text
    code = api.get(f"/api/v1/orders/{order_id}", headers=student.headers).json()["pickup_code"]
    done = api.post(
        f"/api/v1/staff/orders/{order_id}/verify-pickup",
        headers=kitchen.headers,
        json={"code": code},
    )
    assert done.status_code == 200, done.text


def test_outlet_settings_and_hours(
    api: TestClient, outlet: OutletFixture, manager: User, kitchen: User, students: list[User]
) -> None:
    mine = api.get("/api/v1/manage/outlets", headers=manager.headers).json()
    assert str(outlet.id) in [o["id"] for o in mine]
    managed = next(o for o in mine if o["id"] == str(outlet.id))
    assert (managed["no_show_grace_minutes"], managed["no_show_deal_discount_percent"]) == (15, 50)
    assert managed["deal_ttl_minutes"] == 30

    assert api.get("/api/v1/manage/outlets", headers=kitchen.headers).json() == []
    assert (
        api.get(f"/api/v1/manage/outlets/{outlet.id}", headers=kitchen.headers).status_code == 403
    )
    assert (
        api.get(f"/api/v1/manage/outlets/{outlet.id}", headers=students[0].headers).status_code
        == 403
    )

    updated = api.patch(
        f"/api/v1/manage/outlets/{outlet.id}/settings",
        headers=manager.headers,
        json={"no_show_grace_minutes": 20, "location": "Block C, ground floor"},
    )
    assert updated.status_code == 200, updated.text
    assert updated.json()["no_show_grace_minutes"] == 20
    assert updated.json()["location"] == "Block C, ground floor"
    assert updated.json()["no_show_deal_discount_percent"] == 50, "unchanged fields stay"

    too_generous = api.patch(
        f"/api/v1/manage/outlets/{outlet.id}/settings",
        headers=manager.headers,
        json={"no_show_deal_discount_percent": 100},
    )
    assert too_generous.status_code == 422
    by_kitchen = api.patch(
        f"/api/v1/manage/outlets/{outlet.id}/settings",
        headers=kitchen.headers,
        json={"no_show_grace_minutes": 90},
    )
    assert by_kitchen.status_code == 403

    hours = api.put(
        f"/api/v1/manage/outlets/{outlet.id}/hours",
        headers=manager.headers,
        json={"hours": [{"day_of_week": 1, "opens_at": "08:00", "closes_at": "15:30"}]},
    )
    assert hours.status_code == 200, hours.text
    public = api.get(f"/api/v1/outlets/{outlet.slug}").json()
    assert public["hours"] == [{"day_of_week": 1, "opens_at": "08:00:00", "closes_at": "15:30:00"}]
    overlap = api.put(
        f"/api/v1/manage/outlets/{outlet.id}/hours",
        headers=manager.headers,
        json={
            "hours": [
                {"day_of_week": 2, "opens_at": "08:00", "closes_at": "12:00"},
                {"day_of_week": 2, "opens_at": "11:00", "closes_at": "13:00"},
            ]
        },
    )
    assert overlap.status_code == 422
    assert overlap.json()["error"]["details"]["reason"] == "overlapping_hours"


def test_menu_editing_reaches_students_and_counts_today(
    api: TestClient,
    outlet: OutletFixture,
    manager: User,
    kitchen: User,
    students: list[User],
    sql: psycopg.Connection[dict[str, Any]],
) -> None:
    category = api.post(
        f"/api/v1/manage/outlets/{outlet.id}/categories",
        headers=manager.headers,
        json={"name": "Drinks", "sort_order": 1},
    )
    assert category.status_code == 201, category.text
    created = api.post(
        f"/api/v1/manage/outlets/{outlet.id}/menu-items",
        headers=manager.headers,
        json={
            "category_id": category.json()["id"],
            "name": "Bottled Water",
            "price_paise": 2000,
            "diet": "veg",
            "prep_minutes": 0,
            "is_packaged": True,
        },
    )
    assert created.status_code == 201, created.text
    item = created.json()
    assert item["is_packaged"] is True
    assert item["stock_status"] == "available"

    denied = api.post(
        f"/api/v1/manage/outlets/{outlet.id}/menu-items",
        headers=kitchen.headers,
        json={"name": "Sneaky", "price_paise": 100},
    )
    assert denied.status_code == 403
    floats = api.post(
        f"/api/v1/manage/outlets/{outlet.id}/menu-items",
        headers=manager.headers,
        json={"name": "Float Price", "price_paise": 19.99},
    )
    assert floats.status_code == 422, "money is integer paise only"

    menu = api.get(f"/api/v1/outlets/{outlet.id}/menu").json()
    drinks = next(c for c in menu["categories"] if c["name"] == "Drinks")
    assert [i["name"] for i in drinks["items"]] == ["Bottled Water"]

    repriced = api.put(
        f"/api/v1/manage/menu-items/{item['id']}",
        headers=manager.headers,
        json={
            **{k: item[k] for k in ("category_id", "name", "diet", "is_packaged")},
            "price_paise": 2500,
            "prep_minutes": 0,
        },
    )
    assert repriced.status_code == 200, repriced.text
    menu = api.get(f"/api/v1/outlets/{outlet.id}/menu").json()
    water = next(i for c in menu["categories"] for i in c["items"] if i["id"] == item["id"])
    assert water["price_paise"] == 2500

    archived = api.put(
        f"/api/v1/manage/menu-items/{item['id']}",
        headers=manager.headers,
        json={"name": "Bottled Water", "price_paise": 2500, "is_active": False},
    )
    assert archived.status_code == 200
    menu = api.get(f"/api/v1/outlets/{outlet.id}/menu").json()
    assert item["id"] not in [i["id"] for c in menu["categories"] for i in c["items"]]

    paid_order(api, sql, outlet, students[0])
    paid_order(api, sql, outlet, students[1])
    manager_menu = api.get(f"/api/v1/manage/outlets/{outlet.id}/menu", headers=manager.headers)
    assert manager_menu.status_code == 200
    sandwich = next(i for i in manager_menu.json()["items"] if i["id"] == str(outlet.sandwich_id))
    assert (sandwich["today_orders"], sandwich["today_quantity"]) == (2, 2)
    assert item["id"] in [i["id"] for i in manager_menu.json()["items"]], "archived items listed"

    summary = api.get(f"/api/v1/manage/outlets/{outlet.id}/summary", headers=manager.headers)
    assert summary.status_code == 200
    assert summary.json()["paid_orders"] == 2
    assert summary.json()["gross_paid_paise"] == 14000
    assert summary.json()["orders_by_status"] == {"placed": 2}


def test_slots_and_staff(
    api: TestClient,
    outlet: OutletFixture,
    manager: User,
    kitchen: User,
    students: list[User],
    sql: psycopg.Connection[dict[str, Any]],
) -> None:
    paid_order(api, sql, outlet, students[0])
    slots = api.get(f"/api/v1/manage/outlets/{outlet.id}/pickup-slots", headers=manager.headers)
    assert slots.status_code == 200
    booked = next(s for s in slots.json() if s["id"] == str(outlet.slot_id))
    assert booked["reserved_count"] == 1

    shrink = api.patch(
        f"/api/v1/manage/pickup-slots/{outlet.slot_id}",
        headers=manager.headers,
        json={"capacity": 0},
    )
    assert shrink.status_code == 409
    assert shrink.json()["error"]["details"]["reason"] == "capacity_below_reserved"
    stopped = api.patch(
        f"/api/v1/manage/pickup-slots/{outlet.slot_id}",
        headers=manager.headers,
        json={"is_active": False},
    )
    assert stopped.status_code == 200
    assert stopped.json()["is_active"] is False
    public_slots = api.get(f"/api/v1/outlets/{outlet.id}/pickup-slots").json()
    assert str(outlet.slot_id) not in [s["id"] for s in public_slots]
    by_kitchen = api.patch(
        f"/api/v1/manage/pickup-slots/{outlet.slot_id}",
        headers=kitchen.headers,
        json={"is_active": True},
    )
    assert by_kitchen.status_code == 403

    newcomer = students[5]
    assert (
        api.get(f"/api/v1/staff/outlets/{outlet.id}/orders", headers=newcomer.headers).status_code
        == 403
    )
    added = api.post(
        f"/api/v1/manage/outlets/{outlet.id}/staff",
        headers=manager.headers,
        json={"email": newcomer.email.upper()},
    )
    assert added.status_code == 201, added.text
    assert newcomer.email in [m["email"] for m in added.json()]
    assert (
        api.get(f"/api/v1/staff/outlets/{outlet.id}/orders", headers=newcomer.headers).status_code
        == 200
    )
    as_manager = api.post(
        f"/api/v1/manage/outlets/{outlet.id}/staff",
        headers=manager.headers,
        json={"email": students[4].email, "role": "manager"},
    )
    assert as_manager.status_code == 403
    unknown = api.post(
        f"/api/v1/manage/outlets/{outlet.id}/staff",
        headers=manager.headers,
        json={"email": "nobody-here@campuscart.test"},
    )
    assert unknown.status_code == 404
    listed_by_kitchen = api.get(
        f"/api/v1/manage/outlets/{outlet.id}/staff", headers=kitchen.headers
    )
    assert listed_by_kitchen.status_code == 403

    removed = api.delete(
        f"/api/v1/manage/outlets/{outlet.id}/staff/{newcomer.id}", headers=manager.headers
    )
    assert removed.status_code == 204
    assert (
        api.get(f"/api/v1/staff/outlets/{outlet.id}/orders", headers=newcomer.headers).status_code
        == 403
    )


def test_refunds_desk(
    api: TestClient,
    outlet: OutletFixture,
    manager: User,
    kitchen: User,
    students: list[User],
    sql: psycopg.Connection[dict[str, Any]],
) -> None:
    first = paid_order(api, sql, outlet, students[0])
    second = paid_order(api, sql, outlet, students[1])
    collect(api, kitchen, students[0], first)
    collect(api, kitchen, students[1], second)

    asked = api.post(
        f"/api/v1/orders/{first}/refund-request",
        headers=students[0].headers,
        json={"reason": "Sandwich was cold"},
    )
    assert asked.status_code == 201, asked.text
    assert asked.json()["refund_request"]["status"] == "pending"
    api.post(
        f"/api/v1/orders/{second}/refund-request",
        headers=students[1].headers,
        json={"reason": "Wrong filling"},
    )
    stranger = api.post(
        f"/api/v1/orders/{first}/refund-request",
        headers=students[2].headers,
        json={"reason": "Not mine at all"},
    )
    assert stranger.status_code == 404

    # A paid order the kitchen rejects is owed a refund without any request.
    rejected = paid_order(api, sql, outlet, students[2])
    api.post(
        f"/api/v1/staff/orders/{rejected}/transition",
        headers=kitchen.headers,
        json={"to_status": "rejected", "reason": "Out of bread"},
    )

    assert (
        api.get(f"/api/v1/manage/outlets/{outlet.id}/refunds", headers=kitchen.headers).status_code
        == 403
    )
    desk = api.get(f"/api/v1/manage/outlets/{outlet.id}/refunds", headers=manager.headers).json()
    assert [p["order_id"] for p in desk["pending"]] == [first, second]
    assert desk["pending"][0]["customer_name"] == "IT Student 0"
    assert [o["order_id"] for o in desk["owed"]] == [rejected]
    assert desk["median_resolution_minutes_7d"] is None

    request_id = desk["pending"][0]["id"]
    no_note = api.post(
        f"/api/v1/manage/refund-requests/{request_id}/decision",
        headers=manager.headers,
        json={"decision": "decline"},
    )
    assert no_note.status_code == 422
    declined = api.post(
        f"/api/v1/manage/refund-requests/{request_id}/decision",
        headers=manager.headers,
        json={"decision": "decline", "note": "Kitchen log shows it left hot"},
    )
    assert declined.status_code == 204
    student_view = api.get(f"/api/v1/orders/{first}", headers=students[0].headers).json()
    assert student_view["refund_request"]["status"] == "declined"
    assert student_view["refund_request"]["decision_note"] == "Kitchen log shows it left hot"
    assert student_view["refund_status"] == "none"

    approved = api.post(
        f"/api/v1/manage/outlets/{outlet.id}/refunds/approve-all", headers=manager.headers
    )
    assert approved.json() == {"approved": 1}
    assert (
        api.get(f"/api/v1/orders/{second}", headers=students[1].headers).json()["refund_status"]
        == "required"
    )

    desk = api.get(f"/api/v1/manage/outlets/{outlet.id}/refunds", headers=manager.headers).json()
    assert desk["pending"] == []
    assert {d["status"] for d in desk["decided"]} == {"approved", "declined"}
    assert desk["median_resolution_minutes_7d"] is not None
    summary = api.get(f"/api/v1/manage/outlets/{outlet.id}/summary", headers=manager.headers)
    assert summary.json()["refunds_owed_paise"] == 14000  # the approved one + the rejected one
