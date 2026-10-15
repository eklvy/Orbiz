from datetime import date, datetime
from typing import Annotated, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, StringConstraints

Tier = Literal["silver", "gold", "platinum"]
LoyaltyReason = Literal["order_paid", "order_refunded", "topup_bonus", "review", "voucher_redeemed"]
VoucherStatus = Literal["available", "applied", "used", "expired"]


class LoyaltyRules(BaseModel):
    """D-15 (decided 2026-10-15). Shown to students exactly as the server applies them."""

    points_per_10_rupees: int = 1
    topup_bonus_points: int = 50
    topup_bonus_min_paise: int = 99900
    review_points: int = 15
    voucher_cost_points: int = 100
    voucher_value_paise: int = 1000
    tier_silver: int = 0
    tier_gold: int = 1000
    tier_platinum: int = 3000


class LoyaltyEntry(BaseModel):
    id: int
    points: int
    reason: LoyaltyReason
    order_id: UUID | None
    created_at: datetime


class Voucher(BaseModel):
    id: UUID
    code: str
    value_paise: int
    # "expired" is derived from expires_at for unused vouchers.
    status: VoucherStatus
    order_id: UUID | None
    expires_at: datetime
    created_at: datetime


class Loyalty(BaseModel):
    balance_points: int
    lifetime_points: int
    tier: Tier
    next_tier: Tier | None
    points_to_next_tier: int | None
    rules: LoyaltyRules
    entries: list[LoyaltyEntry]
    vouchers: list[Voucher]


class VoucherApply(BaseModel):
    model_config = ConfigDict(extra="forbid")

    code: Annotated[str, StringConstraints(strip_whitespace=True, min_length=3, max_length=20)]


class BudgetUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    monthly_limit_paise: Annotated[int, Field(ge=10000, le=10_000_000)]
    daily_limit_paise: Annotated[int, Field(ge=1000, le=10_000_000)] | None = None
    warn_at_percent: Annotated[int, Field(ge=50, le=100)] = 80


class CategorySpend(BaseModel):
    category: str
    paise: int


class Budget(BaseModel):
    """Spending from paid, unrefunded orders (outlet business dates, campus time zone)."""

    month: date  # first day of the month
    today: date
    monthly_limit_paise: int | None
    daily_limit_paise: int | None
    warn_at_percent: int | None
    month_spent_paise: int
    today_spent_paise: int
    # None without a budget. "near" from warn_at_percent of a limit; "over" past it.
    month_status: Literal["ok", "near", "over"] | None
    today_status: Literal["ok", "near", "over"] | None
    # Item prices by menu category; voucher discounts appear as one negative line.
    by_category: list[CategorySpend]
