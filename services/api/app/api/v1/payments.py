from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Header, Query, Request, status

from app.api.deps import CurrentPrincipal, Db
from app.core.config import Settings, app_settings
from app.modules.orders import service as orders
from app.modules.orders.schemas import OrderDetail
from app.modules.payments import service
from app.modules.payments.provider import Razorpay, get_razorpay
from app.modules.payments.schemas import (
    Checkout,
    CheckoutRequest,
    CheckoutVerification,
    PaymentResult,
    PaymentsConfig,
    Wallet,
)

router = APIRouter(tags=["payments"])
Provider = Annotated[Razorpay, Depends(get_razorpay)]


@router.get("/payments/config", response_model=PaymentsConfig)
async def payments_config(settings: Annotated[Settings, Depends(app_settings)]) -> PaymentsConfig:
    """Whether online (Razorpay) payment is available on this server, and its public key id."""
    return PaymentsConfig(
        razorpay_enabled=settings.payments_enabled,
        razorpay_key_id=settings.razorpay_key_id if settings.payments_enabled else None,
    )


@router.post(
    "/payments/razorpay/checkout", response_model=Checkout, status_code=status.HTTP_201_CREATED
)
async def start_checkout(
    body: CheckoutRequest, principal: CurrentPrincipal, db: Db, provider: Provider
) -> Checkout:
    """Creates a Razorpay order for an unpaid order (amount from the server) or a wallet top-up,
    for Razorpay Checkout in the browser."""
    return await service.start_checkout(db, principal, provider, body)


@router.post("/payments/razorpay/verify", response_model=PaymentResult)
async def verify_checkout(
    body: CheckoutVerification, principal: CurrentPrincipal, db: Db, provider: Provider
) -> PaymentResult:
    """Checkout success callback: verifies Razorpay's signature, then records the capture (pays
    the order or credits the wallet). Safe to call again; the webhook does the same."""
    return await service.verify_checkout(db, principal, provider, body)


@router.post("/payments/razorpay/webhook", include_in_schema=False)
async def razorpay_webhook(
    request: Request,
    db: Db,
    provider: Provider,
    signature: Annotated[str | None, Header(alias="X-Razorpay-Signature")] = None,
    event_id: Annotated[str | None, Header(alias="X-Razorpay-Event-Id")] = None,
) -> dict[str, str]:
    """Razorpay → server. Verified by HMAC over the raw body; each event is processed once."""
    outcome = await service.handle_webhook(db, provider, await request.body(), signature, event_id)
    return {"status": outcome}


@router.get("/wallet", response_model=Wallet)
async def get_wallet(
    principal: CurrentPrincipal,
    db: Db,
    limit: Annotated[int, Query(ge=1, le=50)] = 20,
    cursor: int | None = None,
) -> Wallet:
    async with db.user_transaction(principal) as conn:
        return await service.wallet(conn, principal, limit=limit, cursor=cursor)


@router.post("/orders/{order_id}/pay-with-wallet", response_model=OrderDetail)
async def pay_with_wallet(order_id: UUID, principal: CurrentPrincipal, db: Db) -> OrderDetail:
    """Pays an unpaid order from the wallet in one transaction. Retrying is safe."""
    async with db.user_transaction(principal) as conn:
        await service.pay_with_wallet(conn, order_id)
        return await orders.get_order(conn, order_id)
