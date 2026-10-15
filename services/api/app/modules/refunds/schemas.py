from datetime import datetime
from typing import Annotated, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, StringConstraints

from app.modules.orders.schemas import OrderStatus, RefundRequestStatus


class RefundRequestCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    reason: Annotated[str, StringConstraints(strip_whitespace=True, min_length=5, max_length=500)]


class RefundDecision(BaseModel):
    model_config = ConfigDict(extra="forbid")

    decision: Literal["approve", "decline"]
    # Required when declining (shown to the student).
    note: Annotated[str, StringConstraints(strip_whitespace=True, max_length=300)] | None = None


class RefundRequestEntry(BaseModel):
    id: UUID
    order_id: UUID
    order_token: str | None
    customer_name: str | None
    amount_paise: int
    reason: str
    status: RefundRequestStatus
    decision_note: str | None
    decided_by: UUID | None
    created_at: datetime
    decided_at: datetime | None


class OwedRefund(BaseModel):
    """A refund owed without a request (e.g. the kitchen cancelled a paid order), owed or already
    paid into the student's wallet within the last 30 days."""

    order_id: UUID
    order_token: str | None
    customer_name: str | None
    amount_paise: int
    order_status: OrderStatus
    cancel_reason: str | None
    owed_since: datetime
    # True once the refund has been paid into the student's wallet (D-20).
    paid_out: bool


class RefundDesk(BaseModel):
    pending: list[RefundRequestEntry]
    # Most recent decisions (up to 50).
    decided: list[RefundRequestEntry]
    owed: list[OwedRefund]
    # Median minutes from request to decision over the last 7 days; None without decisions.
    median_resolution_minutes_7d: float | None


class ApprovedCount(BaseModel):
    approved: int
