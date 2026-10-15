"""End-to-end identity flows against the local Supabase stack (real GoTrue + Postgres).

Run with the stack up (`pnpm db:start && pnpm db:reset`) and env exported by
`scripts/supabase-env.sh`. Skipped automatically when that env is absent.
"""

import time
import uuid
from typing import Any

import httpx2 as httpx
import pytest
from fastapi.testclient import TestClient

from app.core.auth import Principal
from app.core.db import Database
from tests.integration.conftest import (
    ANON_KEY,
    DATABASE_URL,
    MAILPIT_URL,
    SEED_PASSWORD,
    TEST_PASSWORD,
    sign_in,
)

pytestmark = pytest.mark.integration

NORTH_CAFE_ID = "00000000-0000-4000-b000-000000000001"


def bearer(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def sign_up(gotrue: httpx.Client, **metadata: Any) -> tuple[str, dict[str, Any]]:
    email = f"it-{uuid.uuid4().hex[:12]}@campuscart.test"
    response = gotrue.post(
        "/signup", json={"email": email, "password": TEST_PASSWORD, "data": metadata}
    )
    assert response.status_code == 200, response.text
    return email, response.json()


def test_readiness_reports_database_ok(api: TestClient) -> None:
    response = api.get("/api/v1/health/ready")
    assert response.status_code == 200, response.text
    assert response.json() == {"status": "ready", "database": "ok"}


def test_signup_creates_profile_visible_through_api(gotrue: httpx.Client, api: TestClient) -> None:
    roll = f"IT-{uuid.uuid4().hex[:8]}"
    email, session = sign_up(
        gotrue,
        full_name="Integration Student",
        roll_number=roll,
        department="CSE",
        year_of_study="3",
    )

    response = api.get("/api/v1/me", headers=bearer(session["access_token"]))
    assert response.status_code == 200, response.text
    me = response.json()
    assert me["email"] == email
    assert me["full_name"] == "Integration Student"
    assert me["roll_number"] == roll
    assert me["customer_type"] == "student"
    assert me["year_of_study"] == 3
    assert me["platform_roles"] == []
    assert me["outlet_roles"] == []


def test_profile_update_allows_only_editable_fields(gotrue: httpx.Client, api: TestClient) -> None:
    _, session = sign_up(gotrue, full_name="Before")
    headers = bearer(session["access_token"])

    ok = api.patch(
        "/api/v1/me", headers=headers, json={"full_name": "  After  ", "hostel_room": "H-7"}
    )
    assert ok.status_code == 200, ok.text
    assert ok.json()["full_name"] == "After"
    assert ok.json()["hostel_room"] == "H-7"

    for body in (
        {"roll_number": "HACK-1"},
        {"customer_type": "faculty"},
        {"year_of_study": 9},
        {"full_name": ""},
        {"full_name": None},
    ):
        rejected = api.patch("/api/v1/me", headers=headers, json=body)
        assert rejected.status_code == 422, (body, rejected.text)
        assert rejected.json()["error"]["code"] == "validation_error"


def test_duplicate_roll_number_signup_is_rejected(gotrue: httpx.Client) -> None:
    roll = f"DUP-{uuid.uuid4().hex[:8]}"
    sign_up(gotrue, full_name="First", roll_number=roll)
    response = gotrue.post(
        "/signup",
        json={
            "email": f"it-{uuid.uuid4().hex[:12]}@campuscart.test",
            "password": TEST_PASSWORD,
            "data": {"full_name": "Second", "roll_number": roll.lower()},
        },
    )
    assert response.status_code >= 400


def test_seeded_manager_sees_outlet_role(gotrue: httpx.Client, api: TestClient) -> None:
    session = sign_in(gotrue, "manager.north@campuscart.test", SEED_PASSWORD)
    me = api.get("/api/v1/me", headers=bearer(session["access_token"])).json()
    assert me["outlet_roles"] == [
        {
            "outlet_id": NORTH_CAFE_ID,
            "outlet_slug": "dev-north-cafe",
            "outlet_name": "Dev Sample North Café",
            "outlet_timezone": "Asia/Kolkata",
            "role": "manager",
        }
    ]
    assert me["platform_roles"] == []


def test_seeded_admin_has_admin_role(gotrue: httpx.Client, api: TestClient) -> None:
    session = sign_in(gotrue, "admin@campuscart.test", SEED_PASSWORD)
    me = api.get("/api/v1/me", headers=bearer(session["access_token"])).json()
    assert me["platform_roles"] == ["admin"]


def test_real_tokens_from_supabase_are_verified_and_tampering_rejected(
    gotrue: httpx.Client, api: TestClient
) -> None:
    session = sign_in(gotrue, "student.one@campuscart.test", SEED_PASSWORD)
    token = session["access_token"]
    assert api.get("/api/v1/me", headers=bearer(token)).status_code == 200

    tampered = token[:-4] + ("AAAA" if not token.endswith("AAAA") else "BBBB")
    assert api.get("/api/v1/me", headers=bearer(tampered)).status_code == 401
    # The project's anon key is a JWT but not a user session.
    assert api.get("/api/v1/me", headers=bearer(ANON_KEY or "")).status_code == 401
    assert api.get("/api/v1/me").status_code == 401


@pytest.fixture
def anyio_backend() -> str:
    return "asyncio"


@pytest.mark.anyio
async def test_api_database_session_is_subject_to_rls(gotrue: httpx.Client) -> None:
    """The API's DB connection adopts the caller's identity: a student sees one profile."""
    session = sign_in(gotrue, "student.one@campuscart.test", SEED_PASSWORD)
    principal = Principal(
        user_id=uuid.UUID(session["user"]["id"]),
        claims={"sub": session["user"]["id"], "role": "authenticated"},
    )
    db = Database(DATABASE_URL or "", min_size=1, max_size=1)
    await db.open()
    try:
        async with db.user_transaction(principal) as conn:
            cur = await conn.execute("select count(*) as n from public.profiles")
            row = await cur.fetchone()
            assert row is not None and row["n"] == 1
            cur = await conn.execute("select current_user as u")
            row = await cur.fetchone()
            assert row is not None and row["u"] == "authenticated"
        # The role is transaction-local: the pooled connection is privileged again afterwards.
        async with db.pool.connection() as conn:
            cur = await conn.execute("select current_user as u")
            row = await cur.fetchone()
            assert row is not None and row["u"] != "authenticated"
    finally:
        await db.close()


def test_logout_revokes_refresh_token(gotrue: httpx.Client) -> None:
    session = sign_in(gotrue, "student.two@campuscart.test", SEED_PASSWORD)
    logout = gotrue.post("/logout", headers=bearer(session["access_token"]))
    assert logout.status_code == 204, logout.text

    refresh = gotrue.post(
        "/token",
        params={"grant_type": "refresh_token"},
        json={"refresh_token": session["refresh_token"]},
    )
    assert refresh.status_code >= 400, "refresh token must not work after logout"


@pytest.mark.skipif(not MAILPIT_URL, reason="TEST_MAILPIT_URL not set")
def test_password_recovery_sends_email(gotrue: httpx.Client) -> None:
    email, _ = sign_up(gotrue, full_name="Forgetful Student")
    response = gotrue.post("/recover", json={"email": email})
    assert response.status_code == 200, response.text

    deadline = time.monotonic() + 10
    with httpx.Client(base_url=MAILPIT_URL or "", timeout=5) as mailpit:
        while time.monotonic() < deadline:
            found = mailpit.get("/api/v1/search", params={"query": f"to:{email}"}).json()
            if found.get("messages_count", found.get("total", 0)):
                return
            time.sleep(0.5)
    pytest.fail(f"no recovery email for {email} reached the local mail catcher")
