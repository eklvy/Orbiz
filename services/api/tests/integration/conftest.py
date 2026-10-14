"""Shared fixtures for integration tests against the local Supabase stack.

Users are created once per session through real GoTrue signups (Supabase Auth rate-limits
signups, so tests share them). Each test that needs ordering data gets its own freshly
created outlet, so tests never interfere through shared stock or slots.
"""

import os
import uuid
from collections.abc import Iterator
from dataclasses import dataclass
from typing import Any

import httpx2 as httpx
import psycopg
import pytest
from fastapi.testclient import TestClient
from psycopg.rows import dict_row

from app.core.config import Environment, Settings
from app.main import create_app

SUPABASE_URL = os.environ.get("CAMPUSCART_SUPABASE_URL")
DATABASE_URL = os.environ.get("CAMPUSCART_DATABASE_URL")
ANON_KEY = os.environ.get("TEST_SUPABASE_ANON_KEY")
MAILPIT_URL = os.environ.get("TEST_MAILPIT_URL")
# Shared password of the fictional dev accounts in supabase/seeds/01_dev_identity.sql.
SEED_PASSWORD = os.environ.get("TEST_SEED_PASSWORD", "DevOnly-CampusCart-2026")
TEST_PASSWORD = "Integration-Test-1"  # noqa: S105 — throwaway, local test accounts only

ENV_READY = bool(SUPABASE_URL and DATABASE_URL and ANON_KEY)


def pytest_collection_modifyitems(config: pytest.Config, items: list[pytest.Item]) -> None:
    if ENV_READY:
        return
    skip = pytest.mark.skip(reason="local Supabase env not set (source scripts/supabase-env.sh)")
    for item in items:
        if "integration" in item.keywords:
            item.add_marker(skip)


@dataclass(frozen=True)
class User:
    id: uuid.UUID
    email: str
    token: str

    @property
    def headers(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self.token}"}


@dataclass(frozen=True)
class OutletFixture:
    id: uuid.UUID
    slug: str
    chai_id: uuid.UUID  # tracked, 10 in stock, ₹20, prep 2 min
    sandwich_id: uuid.UUID  # untracked, ₹70, prep 4 min
    slot_id: uuid.UUID  # +1h, capacity 50
    small_slot_id: uuid.UUID  # +2h, capacity 2


@pytest.fixture(scope="session")
def gotrue() -> Iterator[httpx.Client]:
    with httpx.Client(
        base_url=f"{SUPABASE_URL}/auth/v1", headers={"apikey": ANON_KEY or ""}, timeout=10
    ) as client:
        yield client


@pytest.fixture(scope="session")
def settings() -> Settings:
    return Settings(
        environment=Environment.TEST, supabase_url=SUPABASE_URL, database_url=DATABASE_URL
    )


@pytest.fixture(scope="session")
def api(settings: Settings) -> Iterator[TestClient]:
    with TestClient(create_app(settings)) as client:
        yield client


@pytest.fixture(scope="session")
def sql() -> Iterator[psycopg.Connection[dict[str, Any]]]:
    """Privileged connection for test setup and for asserting on raw database state."""
    with psycopg.connect(DATABASE_URL or "", autocommit=True, row_factory=dict_row) as conn:
        yield conn


def sign_up(gotrue: httpx.Client, **metadata: Any) -> User:
    email = f"it-{uuid.uuid4().hex[:12]}@campuscart.test"
    response = gotrue.post(
        "/signup", json={"email": email, "password": TEST_PASSWORD, "data": metadata}
    )
    assert response.status_code == 200, response.text
    body = response.json()
    return User(id=uuid.UUID(body["user"]["id"]), email=email, token=body["access_token"])


def sign_in(gotrue: httpx.Client, email: str, password: str) -> dict[str, Any]:
    response = gotrue.post(
        "/token", params={"grant_type": "password"}, json={"email": email, "password": password}
    )
    assert response.status_code == 200, response.text
    session: dict[str, Any] = response.json()
    return session


@pytest.fixture(scope="session")
def students(gotrue: httpx.Client) -> list[User]:
    return [sign_up(gotrue, full_name=f"IT Student {i}") for i in range(6)]


@pytest.fixture(scope="session")
def kitchen(gotrue: httpx.Client) -> User:
    return sign_up(gotrue, full_name="IT Kitchen Staff")


@pytest.fixture(scope="session")
def manager(gotrue: httpx.Client) -> User:
    return sign_up(gotrue, full_name="IT Manager")


@pytest.fixture
def outlet(
    sql: psycopg.Connection[dict[str, Any]], kitchen: User, manager: User
) -> Iterator[OutletFixture]:
    """A fresh open outlet (fictional test data) staffed by the session kitchen/manager users."""
    outlet_id, chai, sandwich, slot, small_slot = (uuid.uuid4() for _ in range(5))
    slug = f"it-{outlet_id.hex[:10]}"
    with sql.transaction():
        sql.execute(
            "insert into public.outlets (id, slug, name, status, token_prefix)"
            " values (%s, %s, %s, 'open', 'T')",
            (outlet_id, slug, f"IT Outlet {slug}"),
        )
        sql.execute(
            "insert into public.menu_items (id, outlet_id, name, price_paise, prep_minutes,"
            " track_quantity, diet) values (%s, %s, 'Test Chai', 2000, 2, true, 'veg'),"
            " (%s, %s, 'Test Sandwich', 7000, 4, false, 'egg')",
            (chai, outlet_id, sandwich, outlet_id),
        )
        sql.execute(
            "insert into public.inventory (menu_item_id, quantity_available, low_stock_threshold)"
            " values (%s, 10, 2)",
            (chai,),
        )
        sql.execute(
            "insert into public.pickup_slots (id, outlet_id, starts_at, ends_at, capacity) values"
            " (%s, %s, now() + interval '1 hour', now() + interval '75 minutes', 50),"
            " (%s, %s, now() + interval '2 hours', now() + interval '135 minutes', 2)",
            (slot, outlet_id, small_slot, outlet_id),
        )
        sql.execute(
            "insert into public.outlet_staff (outlet_id, user_id, role) values"
            " (%s, %s, 'kitchen_staff'), (%s, %s, 'manager')",
            (outlet_id, kitchen.id, outlet_id, manager.id),
        )
    yield OutletFixture(outlet_id, slug, chai, sandwich, slot, small_slot)
    # Orders are retained by design (financial history), so the outlet can't be deleted;
    # deactivating hides it from the public catalogue of the shared dev database.
    sql.execute("update public.outlets set is_active = false where id = %s", (outlet_id,))


def confirm_payment(sql: psycopg.Connection[dict[str, Any]], order_id: uuid.UUID | str) -> None:
    """Stand-in for a provider-verified payment (the Phase 5 webhook path). Runs as the
    server's system role exactly as the payment service will; tests only."""
    with sql.transaction():
        sql.execute("select set_config('role', 'service_role', true)")
        sql.execute(
            "select app.confirm_order_payment(%s, %s)", (order_id, f"test-payment:{order_id}")
        )


def new_key() -> str:
    return f"it-{uuid.uuid4().hex}"
