from datetime import datetime
from typing import Annotated, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, StringConstraints

OrderStatus = Literal[
    "payment_pending",
    "placed",
    "confirmed",
    "preparing",
    "ready_for_pickup",
    "no_show",
    "completed",
    "cancelled",
    "rejected",
]
PaymentStatus = Literal["unpaid", "paid"]
RefundStatus = Literal["none", "required", "refunded"]
OrderActor = Literal["student", "staff", "system"]
# Statuses staff may request through the transition endpoint (completion uses pickup verify).
StaffTargetStatus = Literal["confirmed", "preparing", "ready_for_pickup", "rejected", "cancelled"]
ACTIVE_STATUSES: tuple[OrderStatus, ...] = ("placed", "confirmed", "preparing", "ready_for_pickup")

Reason = Annotated[str, StringConstraints(strip_whitespace=True, max_length=300)]


class OrderLineIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    menu_item_id: UUID
    quantity: Annotated[int, Field(ge=1, le=20)]


class OrderCreate(BaseModel):
    """Prices and totals are never accepted from the client; the server computes them."""

    model_config = ConfigDict(extra="forbid")

    outlet_id: UUID
    pickup_slot_id: UUID
    items: Annotated[list[OrderLineIn], Field(min_length=1, max_length=20)]


class OutletRef(BaseModel):
    id: UUID
    slug: str
    name: str


class PickupSlotRef(BaseModel):
    id: UUID
    starts_at: datetime
    ends_at: datetime


class OrderItem(BaseModel):
    id: UUID
    menu_item_id: UUID | None
    item_name: str
    unit_price_paise: int
    quantity: int
    line_total_paise: int
    # Packaged items go back into stock if the order is not collected (D-19).
    is_packaged: bool


class OrderEvent(BaseModel):
    event_type: str
    from_status: OrderStatus | None
    to_status: OrderStatus
    actor: OrderActor
    reason: str | None
    created_at: datetime


RefundRequestStatus = Literal["pending", "approved", "declined"]


class RefundRequestSummary(BaseModel):
    id: UUID
    status: RefundRequestStatus
    amount_paise: int
    reason: str
    decision_note: str | None
    created_at: datetime
    decided_at: datetime | None


class Order(BaseModel):
    id: UUID
    outlet: OutletRef
    # None for a surplus-deal order: the food is already at the counter.
    pickup_slot: PickupSlotRef | None
    # Set when this order bought a surplus deal (food from another student's uncollected order).
    source_deal_id: UUID | None
    # Set for a group order: it is paid share by share (POST /groups/{id}/pay).
    group_session_id: UUID | None
    status: OrderStatus
    payment_status: PaymentStatus
    refund_status: RefundStatus
    token_label: str | None
    # Only ever returned to the order's owner (staff verify it but cannot read it).
    pickup_code: str | None
    subtotal_paise: int
    # Voucher discount; total = subtotal - discount.
    discount_paise: int
    total_paise: int
    item_count: int
    reservation_expires_at: datetime | None
    placed_at: datetime | None
    confirmed_at: datetime | None
    preparing_at: datetime | None
    ready_at: datetime | None
    completed_at: datetime | None
    cancelled_at: datetime | None
    cancel_reason: str | None
    cancelled_by: OrderActor | None
    # While ready_for_pickup: when the order becomes a no-show if not collected (D-19).
    pickup_deadline: datetime | None
    no_show_at: datetime | None
    queue_position: int | None
    # Loyalty points this order earned (net of reversals); owner only, else null.
    loyalty_points: int | None
    version: int
    created_at: datetime
    updated_at: datetime
    items: list[OrderItem]


class OrderDetail(Order):
    events: list[OrderEvent]
    refund_request: RefundRequestSummary | None


class StaffOrder(Order):
    """An order as the counter sees it: never the pickup code, but the customer's name."""

    customer_name: str | None
    # For a deal order: the token of the uncollected order the food came from.
    deal_source_token: str | None


class OrderPage(BaseModel):
    items: list[Order]
    next_cursor: str | None


class CancelRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    reason: Reason | None = None


class TransitionRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    to_status: StaffTargetStatus
    reason: Reason | None = None


class PickupVerifyRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    code: Annotated[str, StringConstraints(strip_whitespace=True, min_length=4, max_length=12)]


class TransitionRule(BaseModel):
    from_status: OrderStatus
    to_status: OrderStatus
    actor: OrderActor
    requires_paid: bool
    requires_reason: bool
    requires_pickup_code: bool
    releases_stock: bool
    releases_slot: bool
    marks_refund_required: bool
    description: str
