"""Concurrent buyers racing for the last stock and the last slot places.

Two layers are exercised:
- the database layer, with 25 simultaneous transactions through the same `Database` code the
  API uses (users created directly in Postgres so the race is not limited by signup quotas);
- the HTTP layer, with real Supabase sessions hitting the ASGI app concurrently.
"""

import asyncio
import json
import uuid
from typing import Any

import httpx2 as httpx
import psycopg
import pytest
from fastapi.testclient import TestClient

from app.core.auth import Principal
from app.core.config import Settings
from app.core.db import Database
from app.core.errors import ApiError
from app.main import create_app
from tests.integration.conftest import DATABASE_URL, OutletFixture, User, new_key

pytestmark = pytest.mark.integration

RACERS = 25


@pytest.fixture
def anyio_backend() -> str:
    return "asyncio"


def make_users(sql: psycopg.Connection[dict[str, Any]], count: int) -> list[Principal]:
    principals = []
    with sql.transaction():
        for _ in range(count):
            user_id = uuid.uuid4()
            sql.execute(
                "insert into auth.users (instance_id, id, aud, role, email, raw_user_meta_data,"
                " raw_app_meta_data, created_at, updated_at) values"
                " ('00000000-0000-0000-0000-000000000000', %s, 'authenticated', 'authenticated',"
                " %s, '{\"full_name\":\"Race Test\"}', '{}', now(), now())",
                (user_id, f"race-{user_id.hex[:12]}@campuscart.test"),
            )
            principals.append(
                Principal(user_id=user_id, claims={"sub": str(user_id), "role": "authenticated"})
            )
    return principals


async def race(
    db: Database,
    principals: list[Principal],
    outlet: OutletFixture,
    item: uuid.UUID,
    slot: uuid.UUID,
) -> list[str]:
    async def attempt(principal: Principal) -> str:
        try:
            async with db.user_transaction(principal) as conn:
                await conn.execute(
                    "select app.create_order(%s, %s, %s::jsonb, %s, 'race')",
                    (
                        outlet.id,
                        slot,
                        json.dumps([{"menu_item_id": str(item), "quantity": 1}]),
                        new_key(),
                    ),
                )
            return "ok"
        except ApiError as exc:
            return str((exc.details or {}).get("reason"))

    return await asyncio.gather(*(attempt(p) for p in principals))


def state(sql: psycopg.Connection[dict[str, Any]], outlet: OutletFixture) -> dict[str, int]:
    row = sql.execute(
        """
        select (select quantity_available from public.inventory
                 where menu_item_id = %(chai)s) as stock,
               (select reserved_count from public.pickup_slots
                 where id = %(slot)s) as slot_reserved,
               (select reserved_count from public.pickup_slots
                 where id = %(small)s) as small_reserved,
               (select count(*) from public.orders where outlet_id = %(outlet)s) as orders,
               (select coalesce(-sum(delta), 0) from public.inventory_movements
                 where menu_item_id = %(chai)s and reason = 'order_reserved') as reserved_in_ledger
        """,
        {
            "chai": outlet.chai_id,
            "slot": outlet.slot_id,
            "small": outlet.small_slot_id,
            "outlet": outlet.id,
        },
    ).fetchone()
    assert row is not None
    return {k: int(v) for k, v in row.items()}


@pytest.mark.anyio
async def test_last_stock_is_never_oversold(
    sql: psycopg.Connection[dict[str, Any]], outlet: OutletFixture
) -> None:
    sql.execute(
        "update public.inventory set quantity_available = 5 where menu_item_id = %s",
        (outlet.chai_id,),
    )
    principals = make_users(sql, RACERS)
    db = Database(DATABASE_URL or "", min_size=RACERS, max_size=RACERS)
    await db.open()
    try:
        results = await race(db, principals, outlet, outlet.chai_id, outlet.slot_id)
    finally:
        await db.close()

    assert results.count("ok") == 5, results
    assert set(results) == {"ok", "insufficient_stock"}, results
    after = state(sql, outlet)
    assert after["stock"] == 0
    assert after["orders"] == 5, "losers left no order rows behind"
    assert after["slot_reserved"] == 5, "losers left no slot reservations behind"
    assert after["reserved_in_ledger"] == 5, "the stock ledger matches what was sold"


@pytest.mark.anyio
async def test_last_slot_places_are_never_overbooked(
    sql: psycopg.Connection[dict[str, Any]], outlet: OutletFixture
) -> None:
    principals = make_users(sql, RACERS)
    db = Database(DATABASE_URL or "", min_size=RACERS, max_size=RACERS)
    await db.open()
    try:
        # Untracked item, so the slot (capacity 2) is the only scarce resource.
        results = await race(db, principals, outlet, outlet.sandwich_id, outlet.small_slot_id)
    finally:
        await db.close()

    assert results.count("ok") == 2, results
    assert set(results) == {"ok", "slot_full"}, results
    after = state(sql, outlet)
    assert after["small_reserved"] == 2
    assert after["orders"] == 2


@pytest.mark.anyio
async def test_http_buyers_race_for_the_last_two(
    settings: Settings,
    api: TestClient,  # ensures nothing else holds the session app open in a conflicting way
    outlet: OutletFixture,
    students: list[User],
    sql: psycopg.Connection[dict[str, Any]],
) -> None:
    sql.execute(
        "update public.inventory set quantity_available = 2 where menu_item_id = %s",
        (outlet.chai_id,),
    )
    app = create_app(settings)
    async with app.router.lifespan_context(app):
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://api.test") as client:
            responses = await asyncio.gather(
                *(
                    client.post(
                        "/api/v1/orders",
                        headers={**student.headers, "Idempotency-Key": new_key()},
                        json={
                            "outlet_id": str(outlet.id),
                            "pickup_slot_id": str(outlet.slot_id),
                            "items": [{"menu_item_id": str(outlet.chai_id), "quantity": 1}],
                        },
                    )
                    for student in students
                )
            )

    codes = sorted(r.status_code for r in responses)
    assert codes == [201, 201, 409, 409, 409, 409], [r.text for r in responses]
    losers = [r.json()["error"]["details"]["reason"] for r in responses if r.status_code == 409]
    assert set(losers) == {"insufficient_stock"}
    assert state(sql, outlet)["stock"] == 0
