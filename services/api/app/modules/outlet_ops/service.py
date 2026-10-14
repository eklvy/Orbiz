"""Manager operations. Authorization is enforced inside each app.* function."""

from datetime import date
from typing import Annotated, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, StringConstraints

from app.core.db import Connection
from app.modules.catalog.schemas import OutletStatus, StockStatus

Note = Annotated[str, StringConstraints(strip_whitespace=True, max_length=200)]


class OutletStatusUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    status: OutletStatus
    reason: Note | None = None
    # Required for on_break (5-240); must be omitted otherwise.
    break_minutes: int | None = None


class StockAdjustment(BaseModel):
    model_config = ConfigDict(extra="forbid")

    delta: Annotated[int, Field(ge=-100_000, le=100_000)]
    reason: Literal["restock", "manual_adjustment"]
    note: Note | None = None


class StockTracking(BaseModel):
    model_config = ConfigDict(extra="forbid")

    track_quantity: bool
    quantity: Annotated[int, Field(ge=0, le=100_000)] | None = None
    low_stock_threshold: Annotated[int, Field(ge=0, le=100_000)] | None = None


class AvailabilityUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    manual_status: StockStatus


class SlotGeneration(BaseModel):
    model_config = ConfigDict(extra="forbid")

    date: date


class StockLevel(BaseModel):
    menu_item_id: UUID
    quantity_available: int


class SlotsGenerated(BaseModel):
    created: int


async def set_outlet_status(conn: Connection, outlet_id: UUID, update: OutletStatusUpdate) -> None:
    await conn.execute(
        "select app.set_outlet_status(%s, %s::public.outlet_status, %s, %s)",
        (outlet_id, update.status, update.reason, update.break_minutes),
    )


async def adjust_stock(conn: Connection, menu_item_id: UUID, change: StockAdjustment) -> StockLevel:
    cur = await conn.execute(
        "select app.adjust_stock(%s, %s, %s::public.inventory_movement_reason, %s) as quantity",
        (menu_item_id, change.delta, change.reason, change.note),
    )
    row = await cur.fetchone()
    assert row is not None  # noqa: S101
    return StockLevel(menu_item_id=menu_item_id, quantity_available=row["quantity"])


async def set_stock_tracking(conn: Connection, menu_item_id: UUID, tracking: StockTracking) -> None:
    await conn.execute(
        "select app.set_stock_tracking(%s, %s, %s, %s)",
        (menu_item_id, tracking.track_quantity, tracking.quantity, tracking.low_stock_threshold),
    )


async def set_availability(
    conn: Connection, menu_item_id: UUID, update: AvailabilityUpdate
) -> None:
    await conn.execute(
        "select app.set_item_manual_status(%s, %s::public.stock_status)",
        (menu_item_id, update.manual_status),
    )


async def generate_slots(
    conn: Connection, outlet_id: UUID, request: SlotGeneration
) -> SlotsGenerated:
    cur = await conn.execute(
        "select app.generate_pickup_slots(%s, %s) as created", (outlet_id, request.date)
    )
    row = await cur.fetchone()
    assert row is not None  # noqa: S101
    return SlotsGenerated(created=row["created"])
