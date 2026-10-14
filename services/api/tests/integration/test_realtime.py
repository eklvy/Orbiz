"""Realtime delivery through Supabase Realtime (postgres_changes under RLS): authorization
isolation and measured end-to-end latency.

Latency is measured two ways and reported:
- request→event: from just before the API call that commits the change, until the event
  arrives on the subscribed client (single clock; an upper bound that includes API time);
- commit→event: from Postgres' commit_timestamp to arrival (Docker VM vs host clocks, so it
  can carry a small skew).
The acceptance target is p95 < 2 s for request→event.
"""

import asyncio
import json
import statistics
import time
import uuid
from datetime import datetime
from typing import Any

import httpx2 as httpx
import psycopg
import pytest
import websockets

from app.core.config import Settings
from app.main import create_app
from tests.integration.conftest import (
    ANON_KEY,
    SUPABASE_URL,
    OutletFixture,
    User,
    confirm_payment,
    new_key,
)

pytestmark = pytest.mark.integration


@pytest.fixture
def anyio_backend() -> str:
    return "asyncio"


class RealtimeClient:
    """Minimal Supabase Realtime (Phoenix channels) client for postgres_changes."""

    def __init__(self, token: str) -> None:
        self.token = token
        self.events: asyncio.Queue[tuple[float, dict[str, Any]]] = asyncio.Queue()
        self._ws: Any = None
        self._tasks: list[asyncio.Task[None]] = []
        self._ref = 0

    async def __aenter__(self) -> "RealtimeClient":
        ws_url = (SUPABASE_URL or "").replace("http", "ws", 1)
        self._ws = await websockets.connect(
            f"{ws_url}/realtime/v1/websocket?apikey={ANON_KEY}&vsn=1.0.0"
        )
        return self

    async def __aexit__(self, *exc: object) -> None:
        for task in self._tasks:
            task.cancel()
        await self._ws.close()

    def _next_ref(self) -> str:
        self._ref += 1
        return str(self._ref)

    async def subscribe(self, table: str, row_filter: str | None = None) -> None:
        change: dict[str, Any] = {"event": "*", "schema": "public", "table": table}
        if row_filter:
            change["filter"] = row_filter
        ref = self._next_ref()
        topic = f"realtime:it-{uuid.uuid4().hex[:8]}"
        await self._ws.send(
            json.dumps(
                {
                    "topic": topic,
                    "event": "phx_join",
                    "payload": {
                        "config": {
                            "broadcast": {"self": False},
                            "presence": {"key": ""},
                            "postgres_changes": [change],
                            "private": False,
                        },
                        "access_token": self.token,
                    },
                    "ref": ref,
                    "join_ref": ref,
                }
            )
        )
        # Wait until Realtime confirms the Postgres subscription is live.
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            message = json.loads(await asyncio.wait_for(self._ws.recv(), timeout=15))
            if message.get("event") == "phx_reply" and message["payload"].get("status") != "ok":
                raise AssertionError(f"subscription rejected: {message}")
            if (
                message.get("event") == "system"
                and message["payload"].get("extension") == "postgres_changes"
            ):
                assert message["payload"].get("status") == "ok", message
                break
        else:
            raise AssertionError("Realtime did not confirm the subscription")
        if not self._tasks:
            self._tasks = [
                asyncio.create_task(self._reader()),
                asyncio.create_task(self._heartbeat()),
            ]

    async def _reader(self) -> None:
        async for raw in self._ws:
            message = json.loads(raw)
            if message.get("event") == "postgres_changes":
                await self.events.put((time.time(), message["payload"]["data"]))

    async def _heartbeat(self) -> None:
        while True:
            await asyncio.sleep(20)
            await self._ws.send(
                json.dumps(
                    {
                        "topic": "phoenix",
                        "event": "heartbeat",
                        "payload": {},
                        "ref": self._next_ref(),
                    }
                )
            )

    async def wait_for(self, predicate: Any, within: float = 10) -> tuple[float, dict[str, Any]]:
        deadline = time.monotonic() + within
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise AssertionError("expected Realtime event did not arrive")
            received_at, data = await asyncio.wait_for(self.events.get(), timeout=remaining)
            if predicate(data):
                return received_at, data

    def drain(self) -> list[dict[str, Any]]:
        drained = []
        while not self.events.empty():
            drained.append(self.events.get_nowait()[1])
        return drained


def p95(values: list[float]) -> float:
    return statistics.quantiles(values, n=20, method="inclusive")[18]


@pytest.mark.anyio
async def test_realtime_isolation_and_latency(
    settings: Settings,
    outlet: OutletFixture,
    students: list[User],
    kitchen: User,
    sql: psycopg.Connection[dict[str, Any]],
) -> None:
    owner, bystander = students[0], students[3]
    app = create_app(settings)
    async with (
        app.router.lifespan_context(app),
        httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://api.test"
        ) as api,
        RealtimeClient(owner.token) as owner_rt,
        RealtimeClient(bystander.token) as bystander_rt,
        RealtimeClient(kitchen.token) as kitchen_rt,
    ):
        await owner_rt.subscribe("orders")
        await bystander_rt.subscribe("orders")
        await kitchen_rt.subscribe("orders", f"outlet_id=eq.{outlet.id}")

        # Staff see new orders for their outlet appear live.
        sent = time.time()
        created = await api.post(
            "/api/v1/orders",
            headers={**owner.headers, "Idempotency-Key": new_key()},
            json={
                "outlet_id": str(outlet.id),
                "pickup_slot_id": str(outlet.slot_id),
                "items": [{"menu_item_id": str(outlet.sandwich_id), "quantity": 1}],
            },
        )
        assert created.status_code == 201, created.text
        first_id = created.json()["id"]
        arrived, _ = await kitchen_rt.wait_for(
            lambda d: d["type"] == "INSERT" and d["record"]["id"] == first_id
        )
        print(f"\nkitchen saw the new order after {(arrived - sent) * 1000:.0f} ms")

        # Ten paid orders x three kitchen transitions = 30 latency samples on the student side.
        # Each order is paid right away, as at a real checkout (a student may hold at most
        # three unpaid orders).
        confirm_payment(sql, first_id)
        order_ids = [first_id]
        for _ in range(9):
            response = await api.post(
                "/api/v1/orders",
                headers={**owner.headers, "Idempotency-Key": new_key()},
                json={
                    "outlet_id": str(outlet.id),
                    "pickup_slot_id": str(outlet.slot_id),
                    "items": [{"menu_item_id": str(outlet.sandwich_id), "quantity": 1}],
                },
            )
            assert response.status_code == 201, response.text
            order_ids.append(response.json()["id"])
            confirm_payment(sql, order_ids[-1])
        await asyncio.sleep(1)
        owner_rt.drain()

        request_to_event: list[float] = []
        commit_to_event: list[float] = []
        for order_id in order_ids:
            for target in ("confirmed", "preparing", "ready_for_pickup"):
                sent = time.time()
                step = await api.post(
                    f"/api/v1/staff/orders/{order_id}/transition",
                    headers=kitchen.headers,
                    json={"to_status": target},
                )
                assert step.status_code == 200, step.text
                received_at, data = await owner_rt.wait_for(
                    lambda d, oid=order_id, st=target: (
                        d["type"] == "UPDATE"
                        and d["record"]["id"] == oid
                        and d["record"]["status"] == st
                    )
                )
                request_to_event.append(received_at - sent)
                committed = datetime.fromisoformat(data["commit_timestamp"].replace("Z", "+00:00"))
                commit_to_event.append(received_at - committed.timestamp())

        await asyncio.sleep(1)
        leaked = [d for d in bystander_rt.drain() if d.get("record", {}).get("id") in order_ids]

    assert leaked == [], "another student must never receive someone else's order events"

    summary = {
        "samples": len(request_to_event),
        "request_to_event_ms": {
            "p50": round(statistics.median(request_to_event) * 1000),
            "p95": round(p95(request_to_event) * 1000),
            "max": round(max(request_to_event) * 1000),
        },
        "commit_to_event_ms": {
            "p50": round(statistics.median(commit_to_event) * 1000),
            "p95": round(p95(commit_to_event) * 1000),
        },
    }
    print(f"realtime latency: {json.dumps(summary)}")
    assert len(request_to_event) == 30
    assert p95(request_to_event) < 2.0, summary
