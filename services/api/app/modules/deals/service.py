"""Surplus deals (D-19). Listing, buying and withdrawing are app.* SQL functions; this module
calls them and shapes responses."""

from collections import defaultdict
from typing import Any
from uuid import UUID

from app.core.db import Connection
from app.core.errors import ApiError
from app.modules.deals.schemas import Deal, DealItem, StaffDeal
from app.modules.orders import service as orders
from app.modules.orders.schemas import OrderDetail

_DEAL_COLUMNS = """
    d.id, d.outlet_id, d.status::text as status, d.discount_percent, d.original_price_paise,
    d.price_paise, d.item_count, d.listed_at, d.expires_at, d.closed_at, d.close_reason,
    d.reserved_order_id, d.sold_order_id
"""


async def _items(conn: Connection, deal_ids: list[UUID]) -> dict[UUID, list[DealItem]]:
    if not deal_ids:
        return {}
    cur = await conn.execute(
        "select deal_id, menu_item_id, item_name, diet::text as diet, quantity,"
        " original_unit_price_paise, deal_unit_price_paise"
        " from public.surplus_deal_items where deal_id = any(%s) order by item_name",
        (deal_ids,),
    )
    items: dict[UUID, list[DealItem]] = defaultdict(list)
    for row in await cur.fetchall():
        items[row["deal_id"]].append(DealItem.model_validate(row))
    return items


async def list_outlet_deals(conn: Connection, outlet_id: UUID) -> list[Deal]:
    """Deals on sale now at a visible outlet (public; RLS shows only available, unexpired ones)."""
    cur = await conn.execute(
        "select 1 from public.outlets where id = %s and is_active", (outlet_id,)
    )
    if await cur.fetchone() is None:
        raise ApiError(404, "not_found", "Outlet not found")
    cur = await conn.execute(
        f"select {_DEAL_COLUMNS} from public.surplus_deals d"  # noqa: S608 — fixed columns
        " where d.outlet_id = %s and d.status = 'available' and d.expires_at > now()"
        " order by d.expires_at",
        (outlet_id,),
    )
    rows = await cur.fetchall()
    items = await _items(conn, [r["id"] for r in rows])
    return [Deal.model_validate({**r, "items": items[r["id"]]}) for r in rows]


async def claim_deal(conn: Connection, deal_id: UUID, idempotency_key: str) -> OrderDetail:
    cur = await conn.execute("select app.claim_deal(%s, %s) as id", (deal_id, idempotency_key))
    row = await cur.fetchone()
    assert row is not None  # noqa: S101 — the function returns a value or raises
    return await orders.get_order(conn, row["id"])


async def staff_deals(conn: Connection, outlet_id: UUID) -> list[StaffDeal]:
    """Every deal listed at the outlet in the last 24 hours, newest first (staff only)."""
    await orders.require_outlet_staff(conn, outlet_id)
    cur = await conn.execute(
        f"""
        select {_DEAL_COLUMNS}, src.token_label as source_token,
               coalesce(d.sold_order_id, d.reserved_order_id) as buyer_order_id,
               buyer.token_label as buyer_token
        from public.surplus_deals d
        join public.orders src on src.id = d.source_order_id
        left join public.orders buyer on buyer.id = coalesce(d.sold_order_id, d.reserved_order_id)
        where d.outlet_id = %s and d.listed_at > now() - interval '24 hours'
        order by d.listed_at desc
        limit 200
        """,  # noqa: S608 — fixed columns
        (outlet_id,),
    )
    rows: list[dict[str, Any]] = await cur.fetchall()
    items = await _items(conn, [r["id"] for r in rows])
    return [StaffDeal.model_validate({**r, "items": items[r["id"]]}) for r in rows]


async def withdraw_deal(conn: Connection, deal_id: UUID, reason: str) -> None:
    await conn.execute("select app.withdraw_deal(%s, %s)", (deal_id, reason))
