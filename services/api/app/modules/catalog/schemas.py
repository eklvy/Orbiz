from datetime import datetime, time
from typing import Literal
from uuid import UUID

from pydantic import BaseModel

OutletStatus = Literal["open", "on_break", "closed"]
CrowdLevel = Literal["low", "medium", "high"]
Diet = Literal["veg", "egg", "non_veg"]
StockStatus = Literal["available", "low", "sold_out"]


class QueueStats(BaseModel):
    """Derived from real order load (REQUIREMENTS.md D-2, D-17); not from sensors."""

    active_orders: int
    estimated_wait_minutes: int
    crowd_level: CrowdLevel


class OpeningHours(BaseModel):
    day_of_week: int  # 0 = Sunday … 6 = Saturday
    opens_at: time
    closes_at: time


class Outlet(BaseModel):
    id: UUID
    slug: str
    name: str
    description: str | None
    location: str | None
    status: OutletStatus  # effective status (an elapsed break reads as open)
    status_reason: str | None
    break_until: datetime | None
    accepting_orders: bool
    timezone: str
    queue: QueueStats


class OutletDetail(Outlet):
    hours: list[OpeningHours]


class TodaySpecial(BaseModel):
    """Today's special for an item: the server-computed price and portions left (D-16)."""

    special_id: UUID
    unit_price_paise: int
    discount_percent: int
    portions_left: int


class MenuItem(BaseModel):
    id: UUID
    category_id: UUID | None
    name: str
    description: str | None
    price_paise: int
    diet: Diet | None
    calories_kcal: int | None
    protein_g: int | None
    prep_minutes: int
    stock_status: StockStatus
    # Present only for items that track quantity.
    quantity_available: int | None
    special: TodaySpecial | None = None


class MenuCategory(BaseModel):
    id: UUID
    name: str
    items: list[MenuItem]


class Menu(BaseModel):
    outlet_id: UUID
    categories: list[MenuCategory]
    uncategorized: list[MenuItem]


class PickupSlot(BaseModel):
    id: UUID
    starts_at: datetime
    ends_at: datetime
    capacity: int
    remaining: int
    # Final validation (prep lead time, capacity) happens transactionally at checkout.
    bookable: bool
