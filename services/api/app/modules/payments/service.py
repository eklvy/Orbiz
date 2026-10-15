"""Online payments (Razorpay) and the wallet. Money moves only inside app.* SQL functions."""

import json
import logging
from typing import Any
from uuid import UUID

from app.core.auth import Principal
from app.core.db import Connection, Database
from app.core.errors import ApiError
from app.modules.payments.provider import Razorpay
from app.modules.payments.schemas import (
    Checkout,
    CheckoutRequest,
    CheckoutVerification,
    PaymentResult,
    Wallet,
    WalletEntry,
)

logger = logging.getLogger(__name__)


async def start_checkout(
    db: Database, principal: Principal, provider: Razorpay, request: CheckoutRequest
) -> Checkout:
    if request.purpose == "order":
        if request.order_id is None or request.amount_paise is not None:
            raise ApiError(422, "validation_error", "Give order_id (and no amount) to pay an order")
        async with db.user_transaction(principal) as conn:
            cur = await conn.execute(
                "select app.order_payment_amount(%s) as amount", (request.order_id,)
            )
            row = await cur.fetchone()
            assert row is not None  # noqa: S101
            amount: int = row["amount"]
        receipt = f"order:{request.order_id}"
    else:
        if request.amount_paise is None or request.order_id is not None:
            raise ApiError(422, "validation_error", "Give amount_paise (and no order) to top up")
        amount = request.amount_paise
        receipt = f"topup:{principal.user_id}"

    # Provider call outside any database transaction (no locks held across the network).
    provider_order_id = await provider.create_order(
        amount, receipt, {"purpose": request.purpose, "user_id": str(principal.user_id)}
    )
    async with db.system_transaction() as conn:
        cur = await conn.execute(
            "select app.register_payment(%s, %s::public.payment_purpose, %s, %s, %s) as id",
            (principal.user_id, request.purpose, request.order_id, amount, provider_order_id),
        )
        row = await cur.fetchone()
        assert row is not None  # noqa: S101
    return Checkout(
        payment_id=row["id"],
        key_id=provider.key_id,
        provider_order_id=provider_order_id,
        amount_paise=amount,
        currency="INR",
    )


async def _payment(conn: Connection, provider_order_id: str) -> dict[str, Any] | None:
    cur = await conn.execute(
        "select id as payment_id, purpose::text as purpose, order_id, status::text as status,"
        " outcome, amount_paise, user_id from public.payments where provider_order_id = %s",
        (provider_order_id,),
    )
    return await cur.fetchone()


async def verify_checkout(
    db: Database, principal: Principal, provider: Razorpay, body: CheckoutVerification
) -> PaymentResult:
    """Razorpay Checkout's success callback. The signature proves Razorpay authorised this
    payment for our provider order; the amount is the one we fixed when creating it."""
    if not provider.checkout_signature_valid(
        body.razorpay_order_id, body.razorpay_payment_id, body.razorpay_signature
    ):
        raise ApiError(
            422,
            "validation_error",
            "Payment could not be verified",
            {"reason": "invalid_signature"},
        )
    async with db.user_transaction(principal) as conn:  # RLS: own payments only
        mine = await _payment(conn, body.razorpay_order_id)
    if mine is None:
        raise ApiError(404, "not_found", "Payment not found", {"reason": "payment_not_found"})
    async with db.system_transaction() as conn:
        await conn.execute(
            "select app.capture_payment(%s, %s, %s)",
            (body.razorpay_order_id, body.razorpay_payment_id, mine["amount_paise"]),
        )
        result = await _payment(conn, body.razorpay_order_id)
    return PaymentResult.model_validate(result)


async def handle_webhook(
    db: Database, provider: Razorpay, raw: bytes, signature: str | None, event_id: str | None
) -> str:
    """Signed, idempotent webhook. Returns a short outcome for logs (never trusts the body
    before the signature checks out)."""
    if not signature or not provider.webhook_signature_valid(raw, signature):
        raise ApiError(
            401, "unauthenticated", "Invalid webhook signature", {"reason": "invalid_signature"}
        )
    try:
        payload: dict[str, Any] = json.loads(raw)
    except ValueError as exc:
        raise ApiError(422, "validation_error", "Invalid webhook body") from exc
    event = str(payload.get("event", ""))
    entity = (((payload.get("payload") or {}).get("payment") or {}).get("entity")) or {}
    order_id, payment_id, amount = entity.get("order_id"), entity.get("id"), entity.get("amount")
    if not isinstance(order_id, str) or not isinstance(payment_id, str):
        return "ignored"
    async with db.system_transaction() as conn:
        cur = await conn.execute(
            "select app.claim_webhook_event(%s, %s) as fresh",
            (event_id or f"{event}:{payment_id}", event),
        )
        row = await cur.fetchone()
        if row is None or not row["fresh"]:
            return "duplicate"
        if await _payment(conn, order_id) is None:
            logger.info("webhook for unknown provider order ignored")
            return "unknown_order"
        if event in ("payment.captured", "order.paid") and isinstance(amount, int):
            cur = await conn.execute(
                "select app.capture_payment(%s, %s, %s) as outcome", (order_id, payment_id, amount)
            )
            outcome = await cur.fetchone()
            return str(outcome["outcome"]) if outcome else "captured"
        if event == "payment.failed":
            reason = str(entity.get("error_description") or "Payment failed")
            await conn.execute("select app.fail_payment(%s, %s)", (order_id, reason))
            return "failed"
    return "ignored"


async def wallet(
    conn: Connection, principal: Principal, *, limit: int, cursor: int | None
) -> Wallet:
    cur = await conn.execute(
        "select balance_paise from public.wallet_accounts where user_id = %s",
        (principal.user_id,),
    )
    row = await cur.fetchone()
    cur = await conn.execute(
        "select id, kind::text as kind, amount_paise, balance_after_paise, order_id, note,"
        " created_at from public.wallet_ledger"
        " where user_id = %s and (%s::bigint is null or id < %s)"
        " order by id desc limit %s",
        (principal.user_id, cursor, cursor, limit + 1),
    )
    rows = await cur.fetchall()
    entries = [WalletEntry.model_validate(r) for r in rows[:limit]]
    return Wallet(
        balance_paise=row["balance_paise"] if row else 0,
        entries=entries,
        next_cursor=entries[-1].id if len(rows) > limit else None,
    )


async def pay_with_wallet(conn: Connection, order_id: UUID) -> None:
    await conn.execute("select app.pay_order_with_wallet(%s)", (order_id,))
