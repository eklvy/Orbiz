from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Header, Query, status

from app.api.deps import CurrentPrincipal, Db
from app.modules.orders import service
from app.modules.orders.schemas import (
    CancelRequest,
    OrderCreate,
    OrderDetail,
    OrderPage,
    TransitionRule,
)
from app.modules.refunds import service as refunds
from app.modules.refunds.schemas import RefundRequestCreate

router = APIRouter(prefix="/orders", tags=["orders"])

# Shared with the deals router (buying a deal also creates an order).
IdempotencyKey = Annotated[
    str,
    Header(
        alias="Idempotency-Key",
        min_length=8,
        max_length=100,
        description="Unique per checkout attempt; retries with the same key return the same order.",
    ),
]


@router.get("/transitions", response_model=list[TransitionRule])
async def list_transitions(db: Db) -> list[TransitionRule]:
    """The order state machine: every legal transition and who may perform it."""
    async with db.anon_transaction() as conn:
        return await service.list_transition_rules(conn)


@router.post("", response_model=OrderDetail, status_code=status.HTTP_201_CREATED)
async def create_order(
    body: OrderCreate, idempotency_key: IdempotencyKey, principal: CurrentPrincipal, db: Db
) -> OrderDetail:
    """Atomically validates the outlet, items, stock and slot, reserves stock and pickup capacity,
    and creates an unpaid order whose reservation expires if payment is not completed."""
    async with db.user_transaction(principal) as conn:
        return await service.create_order(conn, body, idempotency_key)


@router.get("", response_model=OrderPage)
async def list_my_orders(
    principal: CurrentPrincipal,
    db: Db,
    limit: Annotated[int, Query(ge=1, le=50)] = 20,
    cursor: str | None = None,
) -> OrderPage:
    async with db.user_transaction(principal) as conn:
        return await service.list_my_orders(conn, principal, limit=limit, cursor=cursor)


@router.get("/{order_id}", response_model=OrderDetail)
async def get_order(order_id: UUID, principal: CurrentPrincipal, db: Db) -> OrderDetail:
    async with db.user_transaction(principal) as conn:
        return await service.get_order(conn, order_id)


@router.post("/{order_id}/cancel", response_model=OrderDetail)
async def cancel_order(
    order_id: UUID, body: CancelRequest, principal: CurrentPrincipal, db: Db
) -> OrderDetail:
    """Student cancellation (allowed while unpaid, or paid but not yet accepted)."""
    async with db.user_transaction(principal) as conn:
        return await service.transition(conn, order_id, "cancelled", body.reason)


@router.post(
    "/{order_id}/refund-request", response_model=OrderDetail, status_code=status.HTTP_201_CREATED
)
async def request_refund(
    order_id: UUID, body: RefundRequestCreate, principal: CurrentPrincipal, db: Db
) -> OrderDetail:
    """Ask the outlet for a refund on a collected order (within 24 hours). The outlet's manager
    decides. Uncollected (no-show) orders are not refundable."""
    async with db.user_transaction(principal) as conn:
        return await refunds.request_refund(conn, order_id, body.reason)
