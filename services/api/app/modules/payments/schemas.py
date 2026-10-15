from datetime import datetime
from typing import Annotated, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, StringConstraints

ProviderId = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=100)]
WalletEntryKind = Literal[
    "topup", "order_payment", "refund", "transfer_out", "transfer_in", "adjustment"
]


class PaymentsConfig(BaseModel):
    razorpay_enabled: bool
    # Public key id for Razorpay Checkout (safe to publish); None when disabled.
    razorpay_key_id: str | None


class CheckoutRequest(BaseModel):
    """Start an online payment. For an order the server reads the amount; for a top-up the
    student picks it (₹50 to ₹5,000)."""

    model_config = ConfigDict(extra="forbid")

    purpose: Literal["order", "wallet_topup"]
    order_id: UUID | None = None
    amount_paise: Annotated[int, Field(ge=5000, le=500000)] | None = None


class Checkout(BaseModel):
    payment_id: UUID
    key_id: str
    provider_order_id: str
    amount_paise: int
    currency: Literal["INR"]


class CheckoutVerification(BaseModel):
    model_config = ConfigDict(extra="forbid")

    razorpay_order_id: ProviderId
    razorpay_payment_id: ProviderId
    razorpay_signature: Annotated[str, StringConstraints(min_length=64, max_length=64)]


class PaymentResult(BaseModel):
    payment_id: UUID
    purpose: Literal["order", "wallet_topup"]
    order_id: UUID | None
    status: Literal["created", "captured", "failed"]
    # order_paid | wallet_credited | credited_to_wallet | amount_mismatch
    outcome: str | None


class WalletEntry(BaseModel):
    id: int
    kind: WalletEntryKind
    amount_paise: int
    balance_after_paise: int
    order_id: UUID | None
    note: str | None
    created_at: datetime


class Wallet(BaseModel):
    balance_paise: int
    entries: list[WalletEntry]
    next_cursor: int | None
