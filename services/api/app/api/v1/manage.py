from uuid import UUID

from fastapi import APIRouter, status

from app.api.deps import CurrentPrincipal, Db
from app.modules.outlet_ops import service
from app.modules.outlet_ops.service import (
    AvailabilityUpdate,
    OutletStatusUpdate,
    SlotGeneration,
    SlotsGenerated,
    StockAdjustment,
    StockLevel,
    StockTracking,
)

router = APIRouter(prefix="/manage", tags=["management"])


@router.post("/outlets/{outlet_id}/status", status_code=status.HTTP_204_NO_CONTENT)
async def set_outlet_status(
    outlet_id: UUID, body: OutletStatusUpdate, principal: CurrentPrincipal, db: Db
) -> None:
    """Open / take a break / close. New orders are blocked unless the outlet is open."""
    async with db.user_transaction(principal) as conn:
        await service.set_outlet_status(conn, outlet_id, body)


@router.post("/menu-items/{menu_item_id}/stock-adjustments", response_model=StockLevel)
async def adjust_stock(
    menu_item_id: UUID, body: StockAdjustment, principal: CurrentPrincipal, db: Db
) -> StockLevel:
    async with db.user_transaction(principal) as conn:
        return await service.adjust_stock(conn, menu_item_id, body)


@router.put("/menu-items/{menu_item_id}/stock-tracking", status_code=status.HTTP_204_NO_CONTENT)
async def set_stock_tracking(
    menu_item_id: UUID, body: StockTracking, principal: CurrentPrincipal, db: Db
) -> None:
    async with db.user_transaction(principal) as conn:
        await service.set_stock_tracking(conn, menu_item_id, body)


@router.put("/menu-items/{menu_item_id}/availability", status_code=status.HTTP_204_NO_CONTENT)
async def set_availability(
    menu_item_id: UUID, body: AvailabilityUpdate, principal: CurrentPrincipal, db: Db
) -> None:
    """Manual Available / Low / Sold Out (sold out always wins over tracked quantity)."""
    async with db.user_transaction(principal) as conn:
        await service.set_availability(conn, menu_item_id, body)


@router.post("/outlets/{outlet_id}/pickup-slots/generate", response_model=SlotsGenerated)
async def generate_slots(
    outlet_id: UUID, body: SlotGeneration, principal: CurrentPrincipal, db: Db
) -> SlotsGenerated:
    async with db.user_transaction(principal) as conn:
        return await service.generate_slots(conn, outlet_id, body)
