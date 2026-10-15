"""Loyalty points, vouchers and the budget planner. Points and vouchers change only inside
app.* SQL functions and triggers; this module reads and shapes."""

from datetime import datetime
from typing import Literal
from uuid import UUID
from zoneinfo import ZoneInfo

from app.core.auth import Principal
from app.core.db import Connection
from app.core.errors import ApiError
from app.modules.rewards.schemas import (
    Budget,
    BudgetUpdate,
    CategorySpend,
    Loyalty,
    LoyaltyEntry,
    LoyaltyRules,
    Voucher,
)

RULES = LoyaltyRules()
CAMPUS_TZ = ZoneInfo("Asia/Kolkata")
_TIERS: list[tuple[Literal["silver", "gold", "platinum"], int]] = [
    ("silver", 0),
    ("gold", 1000),
    ("platinum", 3000),
]


def tier_for(lifetime: int) -> tuple[Literal["silver", "gold", "platinum"], int | None]:
    """Current tier and the points still needed for the next one (None at the top)."""
    current = _TIERS[0][0]
    for name, threshold in _TIERS:
        if lifetime >= threshold:
            current = name
    upcoming = [threshold for _, threshold in _TIERS if threshold > lifetime]
    return current, (upcoming[0] - lifetime if upcoming else None)


async def loyalty(conn: Connection, principal: Principal) -> Loyalty:
    cur = await conn.execute(
        "select balance_points, lifetime_points from public.loyalty_accounts where user_id = %s",
        (principal.user_id,),
    )
    account = await cur.fetchone()
    balance = account["balance_points"] if account else 0
    lifetime = account["lifetime_points"] if account else 0
    cur = await conn.execute(
        "select id, points, reason::text as reason, order_id, created_at from public.loyalty_ledger"
        " where user_id = %s order by id desc limit 30",
        (principal.user_id,),
    )
    entries = [LoyaltyEntry.model_validate(r) for r in await cur.fetchall()]
    vouchers = await list_vouchers(conn, principal)
    tier, to_next = tier_for(lifetime)
    names = [n for n, _ in _TIERS]
    next_tier = names[names.index(tier) + 1] if to_next is not None else None
    return Loyalty(
        balance_points=balance,
        lifetime_points=lifetime,
        tier=tier,
        next_tier=next_tier,
        points_to_next_tier=to_next,
        rules=RULES,
        entries=entries,
        vouchers=vouchers,
    )


async def list_vouchers(conn: Connection, principal: Principal) -> list[Voucher]:
    cur = await conn.execute(
        """
        select id, code, value_paise,
               case when status = 'available' and expires_at <= now() then 'expired'
                    else status::text end as status,
               order_id, expires_at, created_at
        from public.vouchers where user_id = %s
        order by status = 'available' desc, created_at desc limit 50
        """,
        (principal.user_id,),
    )
    return [Voucher.model_validate(r) for r in await cur.fetchall()]


async def redeem(conn: Connection, principal: Principal) -> Voucher:
    cur = await conn.execute("select app.redeem_points_for_voucher() as id")
    row = await cur.fetchone()
    assert row is not None  # noqa: S101
    for voucher in await list_vouchers(conn, principal):
        if voucher.id == row["id"]:
            return voucher
    raise ApiError(500, "internal_error", "Voucher was not created")


async def apply_voucher(conn: Connection, order_id: UUID, code: str) -> None:
    await conn.execute("select app.apply_voucher(%s, %s)", (order_id, code))


def _status(
    spent: int, limit: int | None, warn: int | None
) -> Literal["ok", "near", "over"] | None:
    if limit is None or warn is None:
        return None
    if spent > limit:
        return "over"
    if spent * 100 >= limit * warn:
        return "near"
    return "ok"


async def budget(conn: Connection, principal: Principal, now: datetime | None = None) -> Budget:
    today = (now or datetime.now(CAMPUS_TZ)).astimezone(CAMPUS_TZ).date()
    month = today.replace(day=1)
    cur = await conn.execute(
        "select monthly_limit_paise, daily_limit_paise, warn_at_percent from public.budgets"
        " where user_id = %s",
        (principal.user_id,),
    )
    limits = await cur.fetchone()
    spend_filter = """
        o.user_id = %(user)s and o.payment_status = 'paid' and o.refund_status <> 'refunded'
        and o.business_date >= %(month)s and o.business_date <= %(today)s
    """
    params = {"user": principal.user_id, "month": month, "today": today}
    cur = await conn.execute(
        f"""
        select coalesce(sum(o.total_paise), 0)::bigint as month,
               coalesce(sum(o.total_paise) filter (where o.business_date = %(today)s), 0)::bigint
                 as today
        from public.orders o where {spend_filter}
        """,  # noqa: S608 — fixed fragment; values are bound parameters
        params,
    )
    totals = await cur.fetchone()
    cur = await conn.execute(
        f"""
        select coalesce(c.name, 'Other') as category, sum(oi.line_total_paise)::bigint as paise
        from public.orders o
        join public.order_items oi on oi.order_id = o.id
        left join public.menu_items m on m.id = oi.menu_item_id
        left join public.menu_categories c on c.id = m.category_id
        where {spend_filter}
        group by 1
        union all
        select 'Voucher discounts', -sum(o.discount_paise)::bigint
        from public.orders o where {spend_filter} and o.discount_paise > 0
        order by 2 desc
        """,  # noqa: S608 — fixed fragment; values are bound parameters
        params,
    )
    by_category = [
        CategorySpend(category=r["category"], paise=int(r["paise"]))
        for r in await cur.fetchall()
        if r["paise"] is not None
    ]
    month_spent = int(totals["month"]) if totals else 0
    today_spent = int(totals["today"]) if totals else 0
    monthly = limits["monthly_limit_paise"] if limits else None
    daily = limits["daily_limit_paise"] if limits else None
    warn = limits["warn_at_percent"] if limits else None
    return Budget(
        month=month,
        today=today,
        monthly_limit_paise=monthly,
        daily_limit_paise=daily,
        warn_at_percent=warn,
        month_spent_paise=month_spent,
        today_spent_paise=today_spent,
        month_status=_status(month_spent, monthly, warn),
        today_status=_status(today_spent, daily, warn),
        by_category=by_category,
    )


async def set_budget(conn: Connection, principal: Principal, update: BudgetUpdate) -> Budget:
    await conn.execute(
        "select app.set_budget(%s, %s, %s)",
        (update.monthly_limit_paise, update.daily_limit_paise, update.warn_at_percent),
    )
    return await budget(conn, principal)


async def clear_budget(conn: Connection) -> None:
    await conn.execute("select app.clear_budget()")
