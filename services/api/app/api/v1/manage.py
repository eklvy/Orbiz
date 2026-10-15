from datetime import date
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Query, status

from app.api.deps import CurrentPrincipal, Db
from app.modules.management import service as management
from app.modules.management.schemas import (
    CategoryInput,
    ManagedOutlet,
    ManagerCategory,
    ManagerMenu,
    ManagerMenuItem,
    ManagerSlot,
    MenuItemInput,
    OpeningHoursUpdate,
    OutletSettingsUpdate,
    OutletSummary,
    SlotUpdate,
    StaffAdd,
    StaffMember,
)
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
from app.modules.refunds import service as refunds
from app.modules.refunds.schemas import ApprovedCount, RefundDecision, RefundDesk

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


# --- Outlets (Phase 4) ---------------------------------------------------------------------------


@router.get("/outlets", response_model=list[ManagedOutlet])
async def list_managed_outlets(principal: CurrentPrincipal, db: Db) -> list[ManagedOutlet]:
    """Outlets the caller manages (admins: all), with settings, hours and live load."""
    async with db.user_transaction(principal) as conn:
        return await management.list_managed_outlets(conn)


@router.get("/outlets/{outlet_id}", response_model=ManagedOutlet)
async def get_managed_outlet(outlet_id: UUID, principal: CurrentPrincipal, db: Db) -> ManagedOutlet:
    async with db.user_transaction(principal) as conn:
        return await management.get_managed_outlet(conn, outlet_id)


@router.patch("/outlets/{outlet_id}/settings", response_model=ManagedOutlet)
async def update_outlet_settings(
    outlet_id: UUID, body: OutletSettingsUpdate, principal: CurrentPrincipal, db: Db
) -> ManagedOutlet:
    """Descriptive fields, slot defaults, reservation hold, kitchen concurrency, and the
    no-show policy (grace minutes, deal discount, deal listing time)."""
    async with db.user_transaction(principal) as conn:
        return await management.update_settings(conn, outlet_id, body)


@router.put("/outlets/{outlet_id}/hours", response_model=ManagedOutlet)
async def set_outlet_hours(
    outlet_id: UUID, body: OpeningHoursUpdate, principal: CurrentPrincipal, db: Db
) -> ManagedOutlet:
    """Replaces the weekly schedule. Applies to slots generated afterwards."""
    async with db.user_transaction(principal) as conn:
        return await management.set_hours(conn, outlet_id, body)


@router.get("/outlets/{outlet_id}/summary", response_model=OutletSummary)
async def outlet_summary(outlet_id: UUID, principal: CurrentPrincipal, db: Db) -> OutletSummary:
    async with db.user_transaction(principal) as conn:
        return await management.summary(conn, outlet_id)


# --- Menu --------------------------------------------------------------------------------------


@router.get("/outlets/{outlet_id}/menu", response_model=ManagerMenu)
async def manager_menu(outlet_id: UUID, principal: CurrentPrincipal, db: Db) -> ManagerMenu:
    """Every item (including archived) with stock detail and today's order counts."""
    async with db.user_transaction(principal) as conn:
        return await management.get_menu(conn, outlet_id)


@router.post(
    "/outlets/{outlet_id}/menu-items",
    response_model=ManagerMenuItem,
    status_code=status.HTTP_201_CREATED,
)
async def create_menu_item(
    outlet_id: UUID, body: MenuItemInput, principal: CurrentPrincipal, db: Db
) -> ManagerMenuItem:
    async with db.user_transaction(principal) as conn:
        return await management.save_item(conn, outlet_id, None, body)


@router.put("/menu-items/{menu_item_id}", response_model=ManagerMenuItem)
async def update_menu_item(
    menu_item_id: UUID, body: MenuItemInput, principal: CurrentPrincipal, db: Db
) -> ManagerMenuItem:
    """Replaces the item's editable fields. Existing orders keep the price they were placed at."""
    async with db.user_transaction(principal) as conn:
        outlet_id = await management.item_outlet(conn, menu_item_id)
        return await management.save_item(conn, outlet_id, menu_item_id, body)


@router.post(
    "/outlets/{outlet_id}/categories",
    response_model=ManagerCategory,
    status_code=status.HTTP_201_CREATED,
)
async def create_category(
    outlet_id: UUID, body: CategoryInput, principal: CurrentPrincipal, db: Db
) -> ManagerCategory:
    async with db.user_transaction(principal) as conn:
        return await management.save_category(conn, outlet_id, None, body)


@router.put("/categories/{category_id}", response_model=ManagerCategory)
async def update_category(
    category_id: UUID, body: CategoryInput, principal: CurrentPrincipal, db: Db
) -> ManagerCategory:
    async with db.user_transaction(principal) as conn:
        outlet_id = await management.category_outlet(conn, category_id)
        return await management.save_category(conn, outlet_id, category_id, body)


@router.delete("/categories/{category_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_category(category_id: UUID, principal: CurrentPrincipal, db: Db) -> None:
    """Its items become uncategorised; none are deleted."""
    async with db.user_transaction(principal) as conn:
        await management.delete_category(conn, category_id)


# --- Pickup slots ------------------------------------------------------------------------------


@router.get("/outlets/{outlet_id}/pickup-slots", response_model=list[ManagerSlot])
async def manager_slots(
    outlet_id: UUID,
    principal: CurrentPrincipal,
    db: Db,
    on_date: Annotated[date | None, Query(alias="date")] = None,
) -> list[ManagerSlot]:
    """All slots of one local date (default today), including inactive and past ones."""
    async with db.user_transaction(principal) as conn:
        return await management.list_slots(conn, outlet_id, on_date)


@router.patch("/pickup-slots/{slot_id}", response_model=ManagerSlot)
async def update_slot(
    slot_id: UUID, body: SlotUpdate, principal: CurrentPrincipal, db: Db
) -> ManagerSlot:
    """Change capacity (not below places booked) or stop/resume bookings. Orders that already
    hold a deactivated slot keep it."""
    async with db.user_transaction(principal) as conn:
        return await management.update_slot(conn, slot_id, body)


# --- Staff -------------------------------------------------------------------------------------


@router.get("/outlets/{outlet_id}/staff", response_model=list[StaffMember])
async def list_staff(outlet_id: UUID, principal: CurrentPrincipal, db: Db) -> list[StaffMember]:
    async with db.user_transaction(principal) as conn:
        return await management.list_staff(conn, outlet_id)


@router.post(
    "/outlets/{outlet_id}/staff",
    response_model=list[StaffMember],
    status_code=status.HTTP_201_CREATED,
)
async def add_staff(
    outlet_id: UUID, body: StaffAdd, principal: CurrentPrincipal, db: Db
) -> list[StaffMember]:
    """Add an existing CampusCart account by email. Managers add kitchen staff; admins any role."""
    async with db.user_transaction(principal) as conn:
        return await management.add_staff(conn, outlet_id, body)


@router.delete("/outlets/{outlet_id}/staff/{user_id}", status_code=status.HTTP_204_NO_CONTENT)
async def remove_staff(outlet_id: UUID, user_id: UUID, principal: CurrentPrincipal, db: Db) -> None:
    async with db.user_transaction(principal) as conn:
        await management.remove_staff(conn, outlet_id, user_id)


# --- Refunds desk ------------------------------------------------------------------------------


@router.get("/outlets/{outlet_id}/refunds", response_model=RefundDesk)
async def refund_desk(outlet_id: UUID, principal: CurrentPrincipal, db: Db) -> RefundDesk:
    """Pending requests, recent decisions, refunds already owed, and resolution time."""
    async with db.user_transaction(principal) as conn:
        return await refunds.desk(conn, outlet_id)


@router.post("/refund-requests/{request_id}/decision", status_code=status.HTTP_204_NO_CONTENT)
async def decide_refund(
    request_id: UUID, body: RefundDecision, principal: CurrentPrincipal, db: Db
) -> None:
    """Approve (the refund becomes owed; paid out in Phase 5) or decline with a note."""
    async with db.user_transaction(principal) as conn:
        await refunds.decide(conn, request_id, body)


@router.post("/outlets/{outlet_id}/refunds/approve-all", response_model=ApprovedCount)
async def approve_all_refunds(
    outlet_id: UUID, principal: CurrentPrincipal, db: Db
) -> ApprovedCount:
    async with db.user_transaction(principal) as conn:
        return ApprovedCount(approved=await refunds.approve_all(conn, outlet_id))
