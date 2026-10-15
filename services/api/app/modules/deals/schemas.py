from datetime import datetime
from typing import Annotated, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, StringConstraints

from app.modules.catalog.schemas import Diet

DealStatus = Literal["available", "reserved", "sold", "expired", "withdrawn"]


class DealItem(BaseModel):
    menu_item_id: UUID | None
    item_name: str
    diet: Diet | None
    quantity: int
    original_unit_price_paise: int
    deal_unit_price_paise: int


class Deal(BaseModel):
    """Prepared food from an uncollected order, offered at a discount (REQUIREMENTS.md D-19).
    Prices are set by the server when the deal is listed."""

    id: UUID
    outlet_id: UUID
    status: DealStatus
    discount_percent: int
    original_price_paise: int
    price_paise: int
    item_count: int
    listed_at: datetime
    expires_at: datetime
    items: list[DealItem]


class StaffDeal(Deal):
    # Token of the uncollected order the food came from.
    source_token: str | None
    # The order holding (reserved) or that bought (sold) the deal, and its token once paid.
    buyer_order_id: UUID | None
    buyer_token: str | None
    closed_at: datetime | None
    close_reason: str | None


class WithdrawRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    reason: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=300)]
