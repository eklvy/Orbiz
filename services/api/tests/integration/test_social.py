"""Group orders, party bookings and bill splits over HTTP against the real database."""

from datetime import UTC, datetime, timedelta
from typing import Any

import httpx2 as httpx
import psycopg
import pytest
from fastapi.testclient import TestClient

from tests.integration.conftest import OutletFixture, User, sign_up

pytestmark = pytest.mark.integration


def fund(sql: psycopg.Connection[dict[str, Any]], user: User, paise: int = 200000) -> None:
    """Credits a wallet through the same system path a verified top-up takes (test-only)."""
    ref = f"it-social-{user.id}"
    with sql.transaction():
        sql.execute("select set_config('role', 'service_role', true)")
        sql.execute(
            "select app.register_payment(%s, 'wallet_topup', null, %s, %s)", (user.id, paise, ref)
        )
        sql.execute("select app.capture_payment(%s, %s, %s)", (ref, f"pay-{ref}", paise))


def balance(api: TestClient, user: User) -> int:
    value: int = api.get("/api/v1/wallet", headers=user.headers).json()["balance_paise"]
    return value


@pytest.fixture
def trio(gotrue: httpx.Client, sql: psycopg.Connection[dict[str, Any]]) -> list[User]:
    people = [
        sign_up(gotrue, full_name=name) for name in ("Group Host", "Group Friend", "Group Third")
    ]
    for person in people:
        fund(sql, person)
    return people


def test_group_order_split_by_dish_and_paid_by_everyone(
    api: TestClient, outlet: OutletFixture, trio: list[User], students: list[User]
) -> None:
    host, friend, third = trio
    created = api.post(
        "/api/v1/groups",
        headers=host.headers,
        json={"outlet_id": str(outlet.id), "pickup_slot_id": str(outlet.slot_id)},
    )
    assert created.status_code == 201, created.text
    group = created.json()
    code = group["invite_code"]
    assert api.get(f"/api/v1/groups/{group['id']}", headers=students[0].headers).status_code == 404

    for person in (friend, third):
        joined = api.post(
            "/api/v1/groups/join", headers=person.headers, json={"code": code.lower()}
        )
        assert joined.status_code == 200, joined.text
    view = api.get(f"/api/v1/groups/{group['id']}", headers=friend.headers).json()
    assert {m["full_name"] for m in view["members"]} == {
        "Group Host",
        "Group Friend",
        "Group Third",
    }

    mine = api.put(
        f"/api/v1/groups/{group['id']}/items",
        headers=friend.headers,
        json={"member_id": str(friend.id), "menu_item_id": str(outlet.sandwich_id), "quantity": 1},
    )
    assert mine.status_code == 200
    not_mine = api.put(
        f"/api/v1/groups/{group['id']}/items",
        headers=friend.headers,
        json={"member_id": str(third.id), "menu_item_id": str(outlet.chai_id), "quantity": 1},
    )
    assert not_mine.status_code == 403
    for member, item in ((third.id, outlet.chai_id), (host.id, outlet.sandwich_id)):
        api.put(
            f"/api/v1/groups/{group['id']}/items",
            headers=host.headers,
            json={"member_id": str(member), "menu_item_id": str(item), "quantity": 1},
        )
    assert (
        api.post(f"/api/v1/groups/{group['id']}/checkout", headers=friend.headers).status_code
        == 403
    )
    locked = api.post(f"/api/v1/groups/{group['id']}/checkout", headers=host.headers).json()
    assert locked["status"] == "locked" and locked["total_paise"] == 16000
    shares = {m["full_name"]: m["share_paise"] for m in locked["members"]}
    assert shares == {"Group Host": 7000, "Group Friend": 7000, "Group Third": 2000}

    for person in (host, friend):
        api.post(f"/api/v1/groups/{group['id']}/pay", headers=person.headers)
    waiting = api.get(f"/api/v1/groups/{group['id']}", headers=host.headers).json()
    assert waiting["order_status"] == "payment_pending"
    done = api.post(f"/api/v1/groups/{group['id']}/pay", headers=third.headers).json()
    assert (done["status"], done["order_status"]) == ("paid", "placed")
    assert done["token_label"]
    response = api.get(f"/api/v1/orders/{done['order_id']}", headers=friend.headers)
    assert response.status_code == 200, response.text
    order = response.json()
    assert order["status"] == "placed" and order["pickup_code"] is None, "only the host collects"
    assert [balance(api, p) for p in trio] == [193000, 193000, 198000]


def test_party_booking_and_bill_split(
    api: TestClient, outlet: OutletFixture, manager: User, trio: list[User]
) -> None:
    host, friend, _ = trio
    too_soon = api.post(
        "/api/v1/parties",
        headers=host.headers,
        json={
            "outlet_id": str(outlet.id),
            "event_name": "Hack night",
            "event_at": (datetime.now(UTC) + timedelta(hours=3)).isoformat(),
            "headcount": 20,
            "items": [{"menu_item_id": str(outlet.sandwich_id), "quantity": 20}],
        },
    )
    assert too_soon.status_code == 422
    booked = api.post(
        "/api/v1/parties",
        headers=host.headers,
        json={
            "outlet_id": str(outlet.id),
            "event_name": "Hack night",
            "event_at": (datetime.now(UTC) + timedelta(days=3)).isoformat(),
            "headcount": 20,
            "items": [{"menu_item_id": str(outlet.sandwich_id), "quantity": 20}],
        },
    )
    assert booked.status_code == 201, booked.text
    party = booked.json()
    assert party["total_paise"] == 140000 and party["status"] == "requested"
    assert api.post(f"/api/v1/parties/{party['id']}/pay", headers=host.headers).status_code == 409
    desk = api.get(f"/api/v1/manage/outlets/{outlet.id}/parties", headers=manager.headers).json()
    assert next(p for p in desk if p["id"] == party["id"])["customer_name"] == "Group Host"
    accepted = api.post(
        f"/api/v1/manage/parties/{party['id']}/decision",
        headers=manager.headers,
        json={"accept": True, "note": "We'll set up at 7"},
    )
    assert accepted.json()["status"] == "accepted"
    paid = api.post(f"/api/v1/parties/{party['id']}/pay", headers=host.headers).json()
    assert paid["status"] == "paid" and balance(api, host) == 200000 - 140000
    cancelled = api.post(f"/api/v1/parties/{party['id']}/cancel", headers=host.headers).json()
    assert cancelled["status"] == "cancelled" and balance(api, host) == 200000

    split = api.post(
        "/api/v1/splits",
        headers=host.headers,
        json={
            "title": "Auto to the station",
            "total_paise": 15000,
            "shares": [{"email": friend.email.upper(), "amount_paise": 5000}],
        },
    )
    assert split.status_code == 201, split.text
    s = split.json()
    assert s["shares"] == [
        {
            "user_id": str(friend.id),
            "full_name": "Group Friend",
            "amount_paise": 5000,
            "paid": False,
        }
    ]
    settled = api.post(f"/api/v1/splits/{s['id']}/settle", headers=friend.headers).json()
    assert settled["settled_at"] is not None
    assert (balance(api, host), balance(api, friend)) == (205000, 195000)
    unknown = api.post(
        "/api/v1/splits",
        headers=host.headers,
        json={
            "title": "Ghost",
            "total_paise": 1000,
            "shares": [{"email": "ghost-nobody@campuscart.test", "amount_paise": 500}],
        },
    )
    assert unknown.status_code == 422
