from datetime import date
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Query

from app.api.deps import Db
from app.modules.catalog import service
from app.modules.catalog.schemas import Diet, Menu, Outlet, OutletDetail, PickupSlot

router = APIRouter(prefix="/outlets", tags=["catalog"])


@router.get("", response_model=list[Outlet])
async def list_outlets(db: Db) -> list[Outlet]:
    """Active outlets with live status, accepting-orders flag and a load-based wait estimate."""
    async with db.anon_transaction() as conn:
        return await service.list_outlets(conn)


@router.get("/{outlet_ref}", response_model=OutletDetail)
async def get_outlet(outlet_ref: str, db: Db) -> OutletDetail:
    """Look up an outlet by id or slug."""
    async with db.anon_transaction() as conn:
        return await service.get_outlet(conn, outlet_ref)


@router.get("/{outlet_id}/menu", response_model=Menu)
async def get_menu(
    outlet_id: UUID,
    db: Db,
    category_id: UUID | None = None,
    diet: Diet | None = None,
    max_price_paise: Annotated[int | None, Query(ge=1)] = None,
    q: Annotated[str | None, Query(max_length=60)] = None,
    available_only: bool = False,
) -> Menu:
    async with db.anon_transaction() as conn:
        return await service.get_menu(
            conn,
            outlet_id,
            category_id=category_id,
            diet=diet,
            max_price_paise=max_price_paise,
            search=q.strip() if q else None,
            available_only=available_only,
        )


@router.get("/{outlet_id}/pickup-slots", response_model=list[PickupSlot])
async def list_pickup_slots(
    outlet_id: UUID,
    db: Db,
    on_date: Annotated[date | None, Query(alias="date")] = None,
    include_full: bool = True,
) -> list[PickupSlot]:
    """Upcoming slots (next 48 h, or one local date) with remaining capacity."""
    async with db.anon_transaction() as conn:
        return await service.list_pickup_slots(
            conn, outlet_id, on_date=on_date, include_full=include_full
        )
