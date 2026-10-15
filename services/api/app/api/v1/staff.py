from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Query, status

from app.api.deps import CurrentPrincipal, Db
from app.core.errors import ApiError
from app.modules.deals import service as deals
from app.modules.deals.schemas import StaffDeal, WithdrawRequest
from app.modules.orders import service
from app.modules.orders.schemas import (
    OrderDetail,
    OrderStatus,
    PickupVerifyRequest,
    StaffOrder,
    TransitionRequest,
)

router = APIRouter(prefix="/staff", tags=["kitchen"])


@router.get("/outlets/{outlet_id}/orders", response_model=list[StaffOrder])
async def outlet_queue(
    outlet_id: UUID,
    principal: CurrentPrincipal,
    db: Db,
    order_status: Annotated[list[OrderStatus] | None, Query(alias="status")] = None,
) -> list[StaffOrder]:
    """The outlet's order queue (active orders by default), ordered by pickup slot, with each
    customer's name. Deal orders have no slot and are ordered by when they became ready."""
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


@router.get("/outlets/{outlet_id}/deals", response_model=list[StaffDeal])
async def outlet_deals(outlet_id: UUID, principal: CurrentPrincipal, db: Db) -> list[StaffDeal]:
    """Surplus deals from uncollected orders listed in the last 24 hours (D-19)."""
    async with db.user_transaction(principal) as conn:
        return await deals.staff_deals(conn, outlet_id)


@router.post("/deals/{deal_id}/withdraw", status_code=status.HTTP_204_NO_CONTENT)
async def withdraw_deal(
    deal_id: UUID, body: WithdrawRequest, principal: CurrentPrincipal, db: Db
) -> None:
    """Take a deal off sale (e.g. the food was given away)."""
    async with db.user_transaction(principal) as conn:
        await deals.withdraw_deal(conn, deal_id, body.reason)
