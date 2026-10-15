from datetime import datetime
from typing import Annotated, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, StringConstraints

from app.modules.orders.schemas import OrderLineIn, OrderStatus, OutletRef, PickupSlotRef

SplitMode = Literal["by_dish", "equal", "percent"]
GroupStatus = Literal["open", "locked", "paid", "cancelled"]
PartyStatus = Literal["requested", "accepted", "declined", "paid", "cancelled", "fulfilled"]


class GroupCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    outlet_id: UUID
    pickup_slot_id: UUID


class GroupJoin(BaseModel):
    model_config = ConfigDict(extra="forbid")

    code: Annotated[str, StringConstraints(strip_whitespace=True, min_length=6, max_length=6)]


class GroupItemSet(BaseModel):
    model_config = ConfigDict(extra="forbid")

    member_id: UUID
    menu_item_id: UUID
    quantity: Annotated[int, Field(ge=0, le=20)]


class GroupSplit(BaseModel):
    model_config = ConfigDict(extra="forbid")

    mode: SplitMode
    # Whole percentages per member id, adding up to 100 (percent mode only).
    percents: dict[UUID, Annotated[int, Field(ge=0, le=100)]] | None = None


class GroupMember(BaseModel):
    user_id: UUID
    full_name: str | None
    is_host: bool
    is_me: bool
    percent: int | None
    # After checkout: what this member owes and whether it's paid.
    share_paise: int | None
    paid: bool | None


class GroupItem(BaseModel):
    id: UUID
    member_id: UUID
    menu_item_id: UUID
    item_name: str
    quantity: int
    # Current price (today's special if any) before checkout; the order's price after.
    unit_price_paise: int
    line_total_paise: int


class Group(BaseModel):
    id: UUID
    outlet: OutletRef
    pickup_slot: PickupSlotRef
    host_id: UUID
    invite_code: str
    status: GroupStatus
    split_mode: SplitMode
    version: int
    members: list[GroupMember]
    items: list[GroupItem]
    # Before checkout an estimate at current prices; after, the order's server total.
    total_paise: int
    order_id: UUID | None
    order_status: OrderStatus | None
    token_label: str | None
    payment_due_by: datetime | None
    created_at: datetime


class PartyRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    outlet_id: UUID
    event_name: Annotated[
        str, StringConstraints(strip_whitespace=True, min_length=3, max_length=120)
    ]
    event_at: datetime
    headcount: Annotated[int, Field(ge=5, le=500)]
    items: Annotated[list[OrderLineIn], Field(min_length=1, max_length=30)]
    notes: Annotated[str, StringConstraints(strip_whitespace=True, max_length=1000)] | None = None


class PartyItem(BaseModel):
    menu_item_id: UUID | None
    item_name: str
    unit_price_paise: int
    quantity: int


class Party(BaseModel):
    id: UUID
    outlet_id: UUID
    outlet_name: str
    event_name: str
    event_at: datetime
    headcount: int
    notes: str | None
    status: PartyStatus
    total_paise: int
    manager_note: str | None
    customer_name: str | None = None  # managers only
    items: list[PartyItem]
    created_at: datetime


class PartyDecision(BaseModel):
    model_config = ConfigDict(extra="forbid")

    accept: bool
    note: Annotated[str, StringConstraints(strip_whitespace=True, max_length=500)] | None = None


class SplitShareIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    email: Annotated[
        str, StringConstraints(strip_whitespace=True, max_length=254, pattern=r"^[^@\s]+@[^@\s]+$")
    ]
    amount_paise: Annotated[int, Field(ge=1, le=5_000_000)]


class SplitCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    title: Annotated[str, StringConstraints(strip_whitespace=True, min_length=2, max_length=120)]
    total_paise: Annotated[int, Field(ge=100, le=5_000_000)]
    shares: Annotated[list[SplitShareIn], Field(min_length=1, max_length=10)]


class SplitShare(BaseModel):
    user_id: UUID
    full_name: str | None
    amount_paise: int
    paid: bool


class Split(BaseModel):
    id: UUID
    title: str
    total_paise: int
    creator_id: UUID
    creator_name: str | None
    i_am_creator: bool
    shares: list[SplitShare]
    settled_at: datetime | None
    cancelled_at: datetime | None
    created_at: datetime
