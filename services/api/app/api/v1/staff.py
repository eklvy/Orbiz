from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Query

from app.api.deps import CurrentPrincipal, Db
from app.core.errors import ApiError
from app.modules.orders import service
from app.modules.orders.schemas import (
    Order,
    OrderDetail,
    OrderStatus,
    PickupVerifyRequest,
    TransitionRequest,
)

router = APIRouter(prefix="/staff", tags=["kitchen"])


@router.get("/outlets/{outlet_id}/orders", response_model=list[Order])
async def outlet_queue(
    outlet_id: UUID,
    principal: CurrentPrincipal,
    db: Db,
    order_status: Annotated[list[OrderStatus] | None, Query(alias="status")] = None,
) -> list[Order]:
    """The outlet's order queue (active orders by default), ordered by pickup slot."""
    async with db.user_transaction(principal) as conn:
        return await service.outlet_queue(conn, outlet_id, order_status)


@router.post("/orders/{order_id}/transition", response_model=OrderDetail)
async def transition_order(
    order_id: UUID, body: TransitionRequest, principal: CurrentPrincipal, db: Db
) -> OrderDetail:
    async with db.user_transaction(principal) as conn:
        return await service.transition(conn, order_id, body.to_status, body.reason)


@router.post("/orders/{order_id}/verify-pickup", response_model=OrderDetail)
async def verify_pickup(
    order_id: UUID, body: PickupVerifyRequest, principal: CurrentPrincipal, db: Db
) -> OrderDetail:
    """Completes the order if the student's pickup code matches. Wrong attempts are counted
    (and committed) before the error is returned; 5 wrong attempts lock the code."""
    async with db.user_transaction(principal) as conn:
        result = await service.verify_pickup(conn, order_id, body.code)
    if result == "invalid_code":
        raise ApiError(
            422, "validation_error", "Pickup code does not match", {"reason": "invalid_pickup_code"}
        )
    if result == "locked":
        raise ApiError(
            429,
            "rate_limited",
            "Too many wrong codes for this order",
            {"reason": "pickup_code_locked"},
        )
    async with db.user_transaction(principal) as conn:
        return await service.get_order(conn, order_id)
