"""The pg_cron job really expires unpaid reservations (not just the function in isolation).

Waits for the next scheduled run, so this test can take up to ~70 seconds.
"""

import time
from typing import Any

import psycopg
import pytest
from fastapi.testclient import TestClient

from tests.integration.conftest import OutletFixture, User, new_key

pytestmark = pytest.mark.integration


def test_cron_job_expires_overdue_reservation(
    api: TestClient,
    outlet: OutletFixture,
    students: list[User],
    sql: psycopg.Connection[dict[str, Any]],
) -> None:
    created = api.post(
        "/api/v1/orders",
        headers={**students[1].headers, "Idempotency-Key": new_key()},
        json={
            "outlet_id": str(outlet.id),
            "pickup_slot_id": str(outlet.small_slot_id),
            "items": [{"menu_item_id": str(outlet.chai_id), "quantity": 3}],
        },
    )
    assert created.status_code == 201, created.text
    order_id = created.json()["id"]
    # Simulate the TTL elapsing instead of waiting 10 minutes.
    sql.execute(
        "update public.orders set reservation_expires_at = now() - interval '1 second'"
        " where id = %s",
        (order_id,),
    )

    deadline = time.monotonic() + 75
    row: dict[str, Any] | None = None
    while time.monotonic() < deadline:
        row = sql.execute(
            """
            select o.status::text as status, o.cancelled_by::text as cancelled_by,
                   (select quantity_available from public.inventory
                     where menu_item_id = %s) as stock,
                   (select reserved_count from public.pickup_slots where id = %s) as reserved
            from public.orders o where o.id = %s
            """,
            (outlet.chai_id, outlet.small_slot_id, order_id),
        ).fetchone()
        if row and row["status"] == "cancelled":
            break
        time.sleep(2)

    assert row is not None and row["status"] == "cancelled", f"cron did not expire the order: {row}"
    assert row["cancelled_by"] == "system"
    assert row["stock"] == 10, "reserved stock was released"
    assert row["reserved"] == 0, "the pickup slot place was released"
