"""Loyalty, vouchers and budget over HTTP against the real database."""

from typing import Any

import httpx2 as httpx
import psycopg
import pytest
from fastapi.testclient import TestClient

from tests.integration.conftest import OutletFixture, User, new_key, sign_up

pytestmark = pytest.mark.integration


def fund(sql: psycopg.Connection[dict[str, Any]], user: User, paise: int, ref: str) -> None:
    """Credits the wallet through the same system path a verified top-up takes (test-only)."""
    with sql.transaction():
        sql.execute("select set_config('role', 'service_role', true)")
        sql.execute(
            "select app.register_payment(%s, 'wallet_topup', null, %s, %s)", (user.id, paise, ref)
        )
        sql.execute("select app.capture_payment(%s, %s, %s)", (ref, f"pay-{ref}", paise))


def order(api: TestClient, user: User, outlet: OutletFixture, quantity: int = 1) -> dict[str, Any]:
    response = api.post(
        "/api/v1/orders",
        headers={**user.headers, "Idempotency-Key": new_key()},
        json={
            "outlet_id": str(outlet.id),
            "pickup_slot_id": str(outlet.slot_id),
            "items": [{"menu_item_id": str(outlet.sandwich_id), "quantity": quantity}],
        },
    )
    assert response.status_code == 201, response.text
    body: dict[str, Any] = response.json()
    return body


def test_points_vouchers_and_budget(
    api: TestClient,
    outlet: OutletFixture,
    gotrue: httpx.Client,
    sql: psycopg.Connection[dict[str, Any]],
) -> None:
    student = sign_up(gotrue, full_name="IT Rewards Student")
    empty = api.get("/api/v1/loyalty", headers=student.headers).json()
    assert (empty["balance_points"], empty["tier"], empty["points_to_next_tier"]) == (
        0,
        "silver",
        1000,
    )
    assert empty["rules"]["topup_bonus_min_paise"] == 99900

    fund(sql, student, 99900, f"it-topup-{student.id}")
    first = order(api, student, outlet, quantity=2)  # ₹140
    paid = api.post(f"/api/v1/orders/{first['id']}/pay-with-wallet", headers=student.headers).json()
    assert paid["loyalty_points"] == 14
    loyalty = api.get("/api/v1/loyalty", headers=student.headers).json()
    assert loyalty["balance_points"] == 64  # 50 top-up bonus + 14
    assert [e["reason"] for e in loyalty["entries"]] == ["order_paid", "topup_bonus"]

    short = api.post("/api/v1/loyalty/vouchers", headers=student.headers)
    assert short.status_code == 409
    assert short.json()["error"]["details"]["reason"] == "not_enough_points"

    with sql.transaction():  # test-only top-up of points, as a review would award
        sql.execute("select private.loyalty_post(%s, 100, 'review')", (student.id,))
    voucher = api.post("/api/v1/loyalty/vouchers", headers=student.headers)
    assert voucher.status_code == 201
    code = voucher.json()["code"]

    second = order(api, student, outlet)  # ₹70
    applied = api.post(
        f"/api/v1/orders/{second['id']}/voucher", headers=student.headers, json={"code": code}
    )
    assert applied.status_code == 200, applied.text
    assert (applied.json()["discount_paise"], applied.json()["total_paise"]) == (1000, 6000)
    api.post(f"/api/v1/orders/{second['id']}/pay-with-wallet", headers=student.headers)

    no_budget = api.get("/api/v1/budget", headers=student.headers).json()
    assert no_budget["month_spent_paise"] == 20000  # ₹140 + ₹60 actually paid
    assert no_budget["month_status"] is None
    bad = api.put("/api/v1/budget", headers=student.headers, json={"monthly_limit_paise": 50})
    assert bad.status_code == 422
    near = api.put(
        "/api/v1/budget",
        headers=student.headers,
        json={"monthly_limit_paise": 22000, "warn_at_percent": 80},
    ).json()
    assert near["month_status"] == "near"
    categories = {c["category"]: c["paise"] for c in near["by_category"]}
    assert categories == {"Other": 21000, "Voucher discounts": -1000}
    over = api.put(
        "/api/v1/budget", headers=student.headers, json={"monthly_limit_paise": 15000}
    ).json()
    assert over["month_status"] == "over"
    assert api.delete("/api/v1/budget", headers=student.headers).status_code == 204
