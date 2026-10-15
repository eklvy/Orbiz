"""D-19 over HTTP: a ready order nobody collects becomes a no-show (no refund), packaged items go
back into stock, the prepared food is sold to another student as a deal (exactly one buyer wins
a race), and the counter sees the new owner once their payment is verified."""

import asyncio
from typing import Any

import httpx2 as httpx
import psycopg
import pytest
from fastapi.testclient import TestClient

from app.core.config import Settings
from app.main import create_app
from tests.integration.conftest import OutletFixture, User, confirm_payment, new_key

pytestmark = pytest.mark.integration


@pytest.fixture
def anyio_backend() -> str:
    return "asyncio"


def ready_order(
    api: TestClient,
    sql: psycopg.Connection[dict[str, Any]],
    outlet: OutletFixture,
    student: User,
    kitchen: User,
) -> str:
    """Chai (packaged) + 2 sandwiches, paid, taken to ready_for_pickup by the kitchen."""
    response = api.post(
        "/api/v1/orders",
        headers={**student.headers, "Idempotency-Key": new_key()},
        json={
            "outlet_id": str(outlet.id),
            "pickup_slot_id": str(outlet.slot_id),
            "items": [
                {"menu_item_id": str(outlet.chai_id), "quantity": 1},
                {"menu_item_id": str(outlet.sandwich_id), "quantity": 2},
            ],
        },
    )
    assert response.status_code == 201, response.text
    order_id: str = response.json()["id"]
    confirm_payment(sql, order_id)
    for step in ("confirmed", "preparing", "ready_for_pickup"):
        moved = api.post(
            f"/api/v1/staff/orders/{order_id}/transition",
            headers=kitchen.headers,
            json={"to_status": step},
        )
        assert moved.status_code == 200, moved.text
    return order_id


def make_overdue(sql: psycopg.Connection[dict[str, Any]], order_id: str) -> None:
    """Moves the order's ready time and slot into the past, then runs the no-show job as the
    system role (pg_cron may also get there first; either way the outcome is the same)."""
    with sql.transaction():
        sql.execute(
            "update public.orders set ready_at = now() - interval '50 minutes' where id = %s",
            (order_id,),
        )
        sql.execute(
            "update public.pickup_slots set starts_at = now() - interval '45 minutes',"
            " ends_at = now() - interval '30 minutes'"
            " where id = (select pickup_slot_id from public.orders where id = %s)",
            (order_id,),
        )
    with sql.transaction():
        sql.execute("select set_config('role', 'service_role', true)")
        sql.execute("select app.process_no_shows()")


def stock(sql: psycopg.Connection[dict[str, Any]], item: Any) -> int:
    row = sql.execute(
        "select quantity_available from public.inventory where menu_item_id = %s", (item,)
    ).fetchone()
    assert row is not None
    quantity: int = row["quantity_available"]
    return quantity


@pytest.mark.anyio
async def test_no_show_then_deal_sold_to_one_student(
    settings: Settings,
    api: TestClient,
    outlet: OutletFixture,
    students: list[User],
    kitchen: User,
    sql: psycopg.Connection[dict[str, Any]],
) -> None:
    sql.execute("update public.menu_items set is_packaged = true where id = %s", (outlet.chai_id,))
    owner, buyers = students[0], students[1:]
    order_id = ready_order(api, sql, outlet, owner, kitchen)
    assert stock(sql, outlet.chai_id) == 9

    # The counter sees who is collecting and the pickup deadline.
    queue = api.get(f"/api/v1/staff/outlets/{outlet.id}/orders", headers=kitchen.headers).json()
    entry = next(o for o in queue if o["id"] == order_id)
    assert entry["customer_name"] == "IT Student 0"
    assert entry["pickup_deadline"] is not None
    assert entry["pickup_code"] is None
    source_token = entry["token_label"]

    make_overdue(sql, order_id)

    order = api.get(f"/api/v1/orders/{order_id}", headers=owner.headers).json()
    assert order["status"] == "no_show"
    assert order["refund_status"] == "none"
    assert order["pickup_deadline"] is None
    assert any(e["event_type"] == "no_show" for e in order["events"])
    assert stock(sql, outlet.chai_id) == 10, "the packaged chai went back on the shelf"

    refund = api.post(
        f"/api/v1/orders/{order_id}/refund-request",
        headers=owner.headers,
        json={"reason": "I was stuck in a lab"},
    )
    assert refund.status_code == 409
    assert refund.json()["error"]["details"]["reason"] == "no_show_not_refundable"

    # The deal is public (no sign-in needed), priced by the server at 50% of what was paid.
    deals = api.get(f"/api/v1/outlets/{outlet.id}/deals").json()
    assert len(deals) == 1
    deal = deals[0]
    assert (deal["original_price_paise"], deal["price_paise"], deal["discount_percent"]) == (
        14000,
        7000,
        50,
    )
    assert [(i["item_name"], i["quantity"]) for i in deal["items"]] == [("Test Sandwich", 2)]

    own = api.post(
        f"/api/v1/deals/{deal['id']}/claim",
        headers={**owner.headers, "Idempotency-Key": new_key()},
    )
    assert own.status_code == 409
    assert own.json()["error"]["details"]["reason"] == "own_deal"

    # Five students race for the one deal: exactly one gets it.
    app = create_app(settings)
    async with app.router.lifespan_context(app):
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://api.test") as client:
            responses = await asyncio.gather(
                *(
                    client.post(
                        f"/api/v1/deals/{deal['id']}/claim",
                        headers={**buyer.headers, "Idempotency-Key": new_key()},
                    )
                    for buyer in buyers
                )
            )
    codes = sorted(r.status_code for r in responses)
    assert codes == [201, 409, 409, 409, 409], [r.text for r in responses]
    assert {r.json()["error"]["details"]["reason"] for r in responses if r.status_code == 409} == {
        "deal_unavailable"
    }
    winner_index = next(i for i, r in enumerate(responses) if r.status_code == 201)
    winner, deal_order = buyers[winner_index], responses[winner_index].json()
    assert deal_order["status"] == "payment_pending"
    assert deal_order["total_paise"] == 7000
    assert deal_order["pickup_slot"] is None
    assert deal_order["source_deal_id"] == deal["id"]
    assert api.get(f"/api/v1/outlets/{outlet.id}/deals").json() == [], "no longer on sale"

    confirm_payment(sql, deal_order["id"])
    paid = api.get(f"/api/v1/orders/{deal_order['id']}", headers=winner.headers).json()
    assert paid["status"] == "ready_for_pickup"
    assert paid["token_label"] and paid["token_label"] != source_token
    assert paid["pickup_code"]

    # The counter now shows the new owner, linked to the original token.
    queue = api.get(f"/api/v1/staff/outlets/{outlet.id}/orders", headers=kitchen.headers).json()
    resold = next(o for o in queue if o["id"] == deal_order["id"])
    assert resold["customer_name"] == f"IT Student {winner_index + 1}"
    assert resold["deal_source_token"] == source_token
    staff_deals = api.get(f"/api/v1/staff/outlets/{outlet.id}/deals", headers=kitchen.headers)
    assert staff_deals.status_code == 200
    assert staff_deals.json()[0]["status"] == "sold"
    assert staff_deals.json()[0]["buyer_token"] == paid["token_label"]

    collected = api.post(
        f"/api/v1/staff/orders/{deal_order['id']}/verify-pickup",
        headers=kitchen.headers,
        json={"code": paid["pickup_code"]},
    )
    assert collected.status_code == 200, collected.text
    assert collected.json()["status"] == "completed"


def test_deal_withdrawal_and_access(
    api: TestClient,
    outlet: OutletFixture,
    students: list[User],
    kitchen: User,
    sql: psycopg.Connection[dict[str, Any]],
) -> None:
    order_id = ready_order(api, sql, outlet, students[0], kitchen)
    make_overdue(sql, order_id)
    deal = api.get(f"/api/v1/outlets/{outlet.id}/deals").json()[0]

    student_view = api.get(f"/api/v1/staff/outlets/{outlet.id}/deals", headers=students[1].headers)
    assert student_view.status_code == 403
    by_student = api.post(
        f"/api/v1/staff/deals/{deal['id']}/withdraw",
        headers=students[1].headers,
        json={"reason": "mine now"},
    )
    assert by_student.status_code == 404
    no_reason = api.post(
        f"/api/v1/staff/deals/{deal['id']}/withdraw", headers=kitchen.headers, json={"reason": ""}
    )
    assert no_reason.status_code == 422
    withdrawn = api.post(
        f"/api/v1/staff/deals/{deal['id']}/withdraw",
        headers=kitchen.headers,
        json={"reason": "Given away at closing"},
    )
    assert withdrawn.status_code == 204, withdrawn.text
    assert api.get(f"/api/v1/outlets/{outlet.id}/deals").json() == []
    claim = api.post(
        f"/api/v1/deals/{deal['id']}/claim",
        headers={**students[2].headers, "Idempotency-Key": new_key()},
    )
    assert claim.status_code == 409
