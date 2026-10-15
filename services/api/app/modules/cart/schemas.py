from typing import Annotated
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field

from app.modules.catalog.schemas import StockStatus

MAX_CART_LINES = 20


class CartItem(BaseModel):
    menu_item_id: UUID
    name: str
    # Current price (today's special price if there is one); the order snapshots it at checkout.
    unit_price_paise: int
    special_discount_percent: int | None
    quantity: int
    line_total_paise: int
    stock_status: StockStatus
    # False when the item was archived or is sold out; checkout would reject it.
    orderable: bool


class Cart(BaseModel):
    outlet_id: UUID | None
    items: list[CartItem]
    subtotal_paise: int
    item_count: int


class CartItemSet(BaseModel):
    model_config = ConfigDict(extra="forbid")

    quantity: Annotated[int, Field(ge=1, le=20)]
    # Adding an item from a different outlet requires explicitly discarding the current cart.
    replace_cart: bool = False
