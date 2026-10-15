"""Payments and wallet over HTTP against the real database. Razorpay's REST API is replaced at the
HTTP boundary (a mock transport); signatures are real HMACs made with local test secrets, so the
verification code is exercised exactly as in production. Nothing here talks to Razorpay."""

import json
import uuid
from collections.abc import Iterator
from typing import Any

import httpx2 as httpx
import psycopg
import pytest
from fastapi.testclient import TestClient
from pydantic import SecretStr

from app.core.config import Settings
from app.main import create_app
from app.modules.payments.provider import hmac_sha256_hex
from tests.integration.conftest import OutletFixture, User, new_key, sign_up

pytestmark = pytest.mark.integration

KEY_SECRET = "local-test-key-secret"  # noqa: S105 — not a real credential
WEBHOOK_SECRET = "local-test-webhook-secret"  # noqa: S105 — not a real credential


@pytest.fixture
def provider_calls() -> list[dict[str, Any]]:
    return []


@pytest.fixture
def pay_api(settings: Settings, provider_calls: list[dict[str, Any]]) -> Iterator[TestClient]:
    def razorpay(request: httpx.Request) -> httpx.Response:
        assert request.url.path.endswith("/orders")
        assert request.headers["authorization"].startswith("Basic ")
        body = json.loads(request.content)
        provider_calls.append(body)
        return httpx.Response(
            200,
            json={
                "id": f"order_{uuid.uuid4().hex[:14]}",
                "amount": body["amount"],
                "status": "created",
            },
        )

    configured = settings.model_copy(
        update={
            "razorpay_key_id": "rzp_test_local",
            "razorpay_key_secret": SecretStr(KEY_SECRET),
            "razorpay_webhook_secret": SecretStr(WEBHOOK_SECRET),
        }
    )
    with TestClient(create_app(configured, http_transport=httpx.MockTransport(razorpay))) as client:
        yield client


def unpaid_order(api: TestClient, student: User, outlet: OutletFixture) -> dict[str, Any]:
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
    order: dict[str, Any] = response.json()
    return order


def webhook(
    api: TestClient, body: dict[str, Any], *, event_id: str, secret: str = WEBHOOK_SECRET
) -> Any:
    raw = json.dumps(body).encode()
    return api.post(
        "/api/v1/payments/razorpay/webhook",
        content=raw,
        headers={
            "Content-Type": "application/json",
            "X-Razorpay-Signature": hmac_sha256_hex(secret, raw),
            "X-Razorpay-Event-Id": event_id,
        },
    )


def test_without_razorpay_online_payment_is_honestly_unavailable(
    api: TestClient, outlet: OutletFixture, students: list[User]
) -> None:
    assert api.get("/api/v1/payments/config").json() == {
        "razorpay_enabled": False,
        "razorpay_key_id": None,
    }
    order = unpaid_order(api, students[0], outlet)
    response = api.post(
        "/api/v1/payments/razorpay/checkout",
        headers=students[0].headers,
        json={"purpose": "order", "order_id": order["id"]},
    )
    assert response.status_code == 503
    assert response.json()["error"]["details"]["reason"] == "payments_unavailable"


def test_card_payment_with_verified_signature_pays_the_order(
    pay_api: TestClient,
    outlet: OutletFixture,
    students: list[User],
    provider_calls: list[dict[str, Any]],
) -> None:
    student, other = students[0], students[1]
    assert pay_api.get("/api/v1/payments/config").json()["razorpay_key_id"] == "rzp_test_local"
    order = unpaid_order(pay_api, student, outlet)

    tampered = pay_api.post(
        "/api/v1/payments/razorpay/checkout",
        headers=student.headers,
        json={"purpose": "order", "order_id": order["id"], "amount_paise": 100},
    )
    assert tampered.status_code == 422, "clients can't set an order's amount"
    stranger = pay_api.post(
        "/api/v1/payments/razorpay/checkout",
        headers=other.headers,
        json={"purpose": "order", "order_id": order["id"]},
    )
    assert stranger.status_code == 404

    checkout = pay_api.post(
        "/api/v1/payments/razorpay/checkout",
        headers=student.headers,
        json={"purpose": "order", "order_id": order["id"]},
    )
    assert checkout.status_code == 201, checkout.text
    c = checkout.json()
    assert c["amount_paise"] == 7000 and c["key_id"] == "rzp_test_local"
    assert provider_calls[-1]["amount"] == 7000, "the server sent the server-computed amount"

    payment_id = f"pay_{uuid.uuid4().hex[:14]}"
    bad = pay_api.post(
        "/api/v1/payments/razorpay/verify",
        headers=student.headers,
        json={
            "razorpay_order_id": c["provider_order_id"],
            "razorpay_payment_id": payment_id,
            "razorpay_signature": hmac_sha256_hex("wrong-secret", b"x"),
        },
    )
    assert bad.status_code == 422
    assert bad.json()["error"]["details"]["reason"] == "invalid_signature"
    assert (
        pay_api.get(f"/api/v1/orders/{order['id']}", headers=student.headers).json()["status"]
        == "payment_pending"
    )

    signature = hmac_sha256_hex(KEY_SECRET, f"{c['provider_order_id']}|{payment_id}".encode())
    body = {
        "razorpay_order_id": c["provider_order_id"],
        "razorpay_payment_id": payment_id,
        "razorpay_signature": signature,
    }
    assert (
        pay_api.post(
            "/api/v1/payments/razorpay/verify", headers=other.headers, json=body
        ).status_code
        == 404
    ), "someone else can't claim this payment"
    verified = pay_api.post("/api/v1/payments/razorpay/verify", headers=student.headers, json=body)
    assert verified.status_code == 200, verified.text
    assert verified.json()["outcome"] == "order_paid"
    again = pay_api.post("/api/v1/payments/razorpay/verify", headers=student.headers, json=body)
    assert again.json()["outcome"] == "order_paid", "verifying twice is harmless"
    paid = pay_api.get(f"/api/v1/orders/{order['id']}", headers=student.headers).json()
    assert (paid["status"], paid["payment_status"]) == ("placed", "paid")
    assert paid["token_label"]


def test_topup_by_signed_webhook_then_pay_from_wallet(
    pay_api: TestClient,
    outlet: OutletFixture,
    gotrue: httpx.Client,
    sql: psycopg.Connection[dict[str, Any]],
) -> None:
    student = sign_up(gotrue, full_name="IT Wallet Student")
    empty = pay_api.get("/api/v1/wallet", headers=student.headers).json()
    assert empty == {"balance_paise": 0, "entries": [], "next_cursor": None}

    order = unpaid_order(pay_api, student, outlet)
    broke = pay_api.post(f"/api/v1/orders/{order['id']}/pay-with-wallet", headers=student.headers)
    assert broke.status_code == 409
    assert broke.json()["error"]["details"]["reason"] == "insufficient_wallet_balance"

    too_small = pay_api.post(
        "/api/v1/payments/razorpay/checkout",
        headers=student.headers,
        json={"purpose": "wallet_topup", "amount_paise": 1000},
    )
    assert too_small.status_code == 422
    checkout = pay_api.post(
        "/api/v1/payments/razorpay/checkout",
        headers=student.headers,
        json={"purpose": "wallet_topup", "amount_paise": 99900},
    ).json()

    event = {
        "event": "payment.captured",
        "payload": {
            "payment": {
                "entity": {
                    "id": f"pay_{uuid.uuid4().hex[:14]}",
                    "order_id": checkout["provider_order_id"],
                    "amount": 99900,
                    "status": "captured",
                }
            }
        },
    }
    forged = webhook(pay_api, event, event_id="evt_forged", secret="attacker-secret")  # noqa: S106 — deliberately wrong
    assert forged.status_code == 401
    assert pay_api.get("/api/v1/wallet", headers=student.headers).json()["balance_paise"] == 0

    event_id = f"evt_{uuid.uuid4().hex[:12]}"
    first = webhook(pay_api, event, event_id=event_id)
    assert first.status_code == 200, first.text
    assert first.json() == {"status": "wallet_credited"}
    assert webhook(pay_api, event, event_id=event_id).json() == {"status": "duplicate"}
    assert pay_api.get("/api/v1/wallet", headers=student.headers).json()["balance_paise"] == 99900

    paid = pay_api.post(f"/api/v1/orders/{order['id']}/pay-with-wallet", headers=student.headers)
    assert paid.status_code == 200, paid.text
    assert paid.json()["payment_status"] == "paid"
    retry = pay_api.post(f"/api/v1/orders/{order['id']}/pay-with-wallet", headers=student.headers)
    assert retry.status_code == 200, "paying again is a no-op, not a second debit"
    wallet = pay_api.get("/api/v1/wallet", headers=student.headers).json()
    assert wallet["balance_paise"] == 92900
    assert [e["kind"] for e in wallet["entries"]] == ["order_payment", "topup"]
    ledger_sum = sql.execute(
        "select sum(amount_paise)::int as s from public.wallet_ledger where user_id = %s",
        (student.id,),
    ).fetchone()
    assert ledger_sum is not None and ledger_sum["s"] == wallet["balance_paise"]
