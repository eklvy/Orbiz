from datetime import date, datetime, time
from typing import Annotated, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, StringConstraints

from app.modules.catalog.schemas import Diet, OpeningHours, OutletStatus, QueueStats, StockStatus
from app.modules.identity.schemas import OutletRole

Name120 = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=120)]
SortOrder = Annotated[int, Field(ge=-1000, le=1000)]
Description1000 = Annotated[str, StringConstraints(strip_whitespace=True, max_length=1000)]
Description500 = Annotated[str, StringConstraints(strip_whitespace=True, max_length=500)]
Location = Annotated[str, StringConstraints(strip_whitespace=True, max_length=200)]


class ManagedOutlet(BaseModel):
    id: UUID
    slug: str
    name: str
    description: str | None
    location: str | None
    is_active: bool
    status: OutletStatus  # effective status (an elapsed break reads as open)
    status_reason: str | None
    break_until: datetime | None
    timezone: str
    token_prefix: str
    slot_minutes: int
    default_slot_capacity: int
    reservation_ttl_minutes: int
    concurrent_orders: int
    no_show_grace_minutes: int
    no_show_deal_discount_percent: int
    deal_ttl_minutes: int
    hours: list[OpeningHours]
    queue: QueueStats


class OutletSettingsUpdate(BaseModel):
    """Omitted fields are left unchanged."""

    model_config = ConfigDict(extra="forbid")

    name: Name120 | None = None
    description: Description1000 | None = None
    location: Location | None = None
    slot_minutes: Annotated[int, Field(ge=5, le=120)] | None = None
    default_slot_capacity: Annotated[int, Field(ge=1, le=500)] | None = None
    reservation_ttl_minutes: Annotated[int, Field(ge=2, le=60)] | None = None
    concurrent_orders: Annotated[int, Field(ge=1, le=50)] | None = None
    no_show_grace_minutes: Annotated[int, Field(ge=5, le=120)] | None = None
    no_show_deal_discount_percent: Annotated[int, Field(ge=10, le=90)] | None = None
    deal_ttl_minutes: Annotated[int, Field(ge=5, le=240)] | None = None


class OpeningHoursIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    day_of_week: Annotated[int, Field(ge=0, le=6)]  # 0 = Sunday … 6 = Saturday
    opens_at: time
    closes_at: time


class OpeningHoursUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    hours: Annotated[list[OpeningHoursIn], Field(max_length=28)]


class ManagerCategory(BaseModel):
    id: UUID
    name: str
    sort_order: int
    is_active: bool


class CategoryInput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=60)]
    sort_order: SortOrder = 0
    is_active: bool = True


class ManagerMenuItem(BaseModel):
    id: UUID
    category_id: UUID | None
    name: str
    description: str | None
    price_paise: int
    diet: Diet | None
    calories_kcal: int | None
    protein_g: int | None
    prep_minutes: int
    is_packaged: bool
    is_active: bool
    sort_order: int
    manual_status: StockStatus
    stock_status: StockStatus
    track_quantity: bool
    quantity_available: int | None
    low_stock_threshold: int | None
    # Today's (outlet-local) paid orders containing the item, excluding cancelled/rejected ones.
    today_orders: int
    today_quantity: int


class MenuItemInput(BaseModel):
    """Replaces every editable field. Prices are integer paise."""

    model_config = ConfigDict(extra="forbid")

    category_id: UUID | None = None
    name: Name120
    description: Description500 | None = None
    price_paise: Annotated[int, Field(ge=1, le=10_000_000)]
    diet: Diet | None = None
    calories_kcal: Annotated[int, Field(ge=0, le=5000)] | None = None
    protein_g: Annotated[int, Field(ge=0, le=500)] | None = None
    prep_minutes: Annotated[int, Field(ge=0, le=180)] = 5
    is_packaged: bool = False
    is_active: bool = True
    sort_order: SortOrder = 0


class ManagerMenu(BaseModel):
    outlet_id: UUID
    business_date: date
    categories: list[ManagerCategory]
    items: list[ManagerMenuItem]


class ManagerSlot(BaseModel):
    id: UUID
    starts_at: datetime
    ends_at: datetime
    capacity: int
    reserved_count: int
    is_active: bool


class SlotUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    capacity: Annotated[int, Field(ge=0, le=1000)] | None = None
    is_active: bool | None = None


class StaffMember(BaseModel):
    user_id: UUID
    full_name: str | None
    email: str
    role: OutletRole
    added_at: datetime


class StaffAdd(BaseModel):
    model_config = ConfigDict(extra="forbid")

    # Light shape check only; the database looks the account up (case-insensitively).
    email: Annotated[
        str, StringConstraints(strip_whitespace=True, max_length=254, pattern=r"^[^@\s]+@[^@\s]+$")
    ]
    role: OutletRole = "kitchen_staff"


DealCounts = dict[Literal["available", "reserved", "sold", "expired", "withdrawn"], int]


class OutletSummary(BaseModel):
    """Today's figures for one outlet, computed from real orders (outlet-local business date)."""

    business_date: date
    # Orders paid today, by current status.
    orders_by_status: dict[str, int]
    paid_orders: int
    gross_paid_paise: int
    refunds_owed_paise: int
    no_shows: int
    deals: DealCounts
    deal_sales_paise: int
    pending_refund_requests: int
