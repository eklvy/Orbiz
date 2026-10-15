"""Manager console reads and edits. Every write is an app.* function that authorises the caller;
reads run in the caller's RLS transaction and check the manager role explicitly."""

import json
from datetime import UTC, date, datetime
from typing import Any
from uuid import UUID

from app.core.db import Connection
from app.core.errors import ApiError
from app.modules.catalog.schemas import OpeningHours
from app.modules.catalog.service import crowd_level
from app.modules.management.schemas import (
    CategoryInput,
    ManagedOutlet,
    ManagerCategory,
    ManagerMenu,
    ManagerMenuItem,
    ManagerSlot,
    MenuItemInput,
    OpeningHoursUpdate,
    OutletSettingsUpdate,
    OutletSummary,
    SlotUpdate,
    StaffAdd,
    StaffMember,
)


async def require_manager(conn: Connection, outlet_id: UUID) -> None:
    cur = await conn.execute(
        "select private.is_outlet_manager(%s) or private.is_admin() as allowed", (outlet_id,)
    )
    row = await cur.fetchone()
    if row is None or not row["allowed"]:
        raise ApiError(403, "forbidden", "Only this outlet's managers can do that")


# --- Outlets ---------------------------------------------------------------------------------


async def list_managed_outlets(
    conn: Connection, outlet_id: UUID | None = None
) -> list[ManagedOutlet]:
    """Outlets the caller manages (admins: every outlet), including inactive ones."""
    cur = await conn.execute(
        """
        select o.id, o.slug, o.name, o.description, o.location, o.is_active,
               o.status::text as status, o.status_reason, o.break_until, o.timezone,
               o.token_prefix, o.slot_minutes, o.default_slot_capacity,
               o.reservation_ttl_minutes, o.concurrent_orders, o.no_show_grace_minutes,
               o.no_show_deal_discount_percent, o.deal_ttl_minutes,
               q.active_orders, q.estimated_wait_minutes
        from public.outlets o
        cross join lateral app.outlet_queue_stats(o.id) q
        where (private.is_outlet_manager(o.id) or private.is_admin())
          and (%(id)s::uuid is null or o.id = %(id)s::uuid)
        order by o.name
        """,
        {"id": outlet_id},
    )
    rows = await cur.fetchall()
    cur = await conn.execute(
        "select outlet_id, day_of_week, opens_at, closes_at from public.outlet_hours"
        " where outlet_id = any(%s) order by day_of_week, opens_at",
        ([r["id"] for r in rows],),
    )
    hours: dict[UUID, list[OpeningHours]] = {r["id"]: [] for r in rows}
    for h in await cur.fetchall():
        hours[h["outlet_id"]].append(OpeningHours.model_validate(h))

    now = datetime.now(UTC)
    result = []
    for row in rows:
        break_over = (
            row["status"] == "on_break"
            and row["break_until"] is not None
            and row["break_until"] <= now
        )
        result.append(
            ManagedOutlet.model_validate(
                {
                    **row,
                    "status": "open" if break_over else row["status"],
                    "break_until": None if break_over else row["break_until"],
                    "hours": hours[row["id"]],
                    "queue": {
                        "active_orders": row["active_orders"],
                        "estimated_wait_minutes": row["estimated_wait_minutes"],
                        "crowd_level": crowd_level(row["estimated_wait_minutes"]),
                    },
                }
            )
        )
    return result


async def get_managed_outlet(conn: Connection, outlet_id: UUID) -> ManagedOutlet:
    await require_manager(conn, outlet_id)
    outlets = await list_managed_outlets(conn, outlet_id)
    if not outlets:
        raise ApiError(404, "not_found", "Outlet not found")
    return outlets[0]


async def update_settings(
    conn: Connection, outlet_id: UUID, update: OutletSettingsUpdate
) -> ManagedOutlet:
    await conn.execute(
        """
        select app.update_outlet_settings(
          %(outlet)s, p_name => %(name)s, p_description => %(description)s,
          p_location => %(location)s, p_slot_minutes => %(slot_minutes)s,
          p_default_slot_capacity => %(default_slot_capacity)s,
          p_reservation_ttl_minutes => %(reservation_ttl_minutes)s,
          p_concurrent_orders => %(concurrent_orders)s,
          p_no_show_grace_minutes => %(no_show_grace_minutes)s,
          p_no_show_deal_discount_percent => %(no_show_deal_discount_percent)s,
          p_deal_ttl_minutes => %(deal_ttl_minutes)s)
        """,
        {"outlet": outlet_id, **update.model_dump()},
    )
    return await get_managed_outlet(conn, outlet_id)


async def set_hours(conn: Connection, outlet_id: UUID, update: OpeningHoursUpdate) -> ManagedOutlet:
    payload = [
        {
            "day_of_week": h.day_of_week,
            "opens_at": h.opens_at.isoformat(),
            "closes_at": h.closes_at.isoformat(),
        }
        for h in update.hours
    ]
    await conn.execute(
        "select app.set_outlet_hours(%s, %s::jsonb)", (outlet_id, json.dumps(payload))
    )
    return await get_managed_outlet(conn, outlet_id)


# --- Menu ------------------------------------------------------------------------------------


async def _business_date(conn: Connection, outlet_id: UUID) -> date:
    cur = await conn.execute(
        "select (now() at time zone timezone)::date as d from public.outlets where id = %s",
        (outlet_id,),
    )
    row = await cur.fetchone()
    if row is None:
        raise ApiError(404, "not_found", "Outlet not found")
    business_date: date = row["d"]
    return business_date


async def get_menu(conn: Connection, outlet_id: UUID) -> ManagerMenu:
    await require_manager(conn, outlet_id)
    today = await _business_date(conn, outlet_id)
    cur = await conn.execute(
        "select id, name, sort_order, is_active from public.menu_categories"
        " where outlet_id = %s order by sort_order, name",
        (outlet_id,),
    )
    categories = [ManagerCategory.model_validate(r) for r in await cur.fetchall()]
    cur = await conn.execute(
        """
        with sales as (
          select oi.menu_item_id, count(distinct o.id)::int as orders, sum(oi.quantity)::int as qty
          from public.orders o
          join public.order_items oi on oi.order_id = o.id
          where o.outlet_id = %(outlet)s and o.business_date = %(today)s
            and o.source_deal_id is null
            and o.status not in ('cancelled', 'rejected')
          group by oi.menu_item_id
        )
        select m.id, m.category_id, m.name, m.description, m.price_paise, m.diet::text as diet,
               m.calories_kcal, m.protein_g, m.prep_minutes, m.is_packaged, m.is_active,
               m.sort_order, m.manual_status::text as manual_status,
               m.stock_status::text as stock_status, m.track_quantity,
               case when m.track_quantity then i.quantity_available end as quantity_available,
               case when m.track_quantity then i.low_stock_threshold end as low_stock_threshold,
               coalesce(s.orders, 0) as today_orders, coalesce(s.qty, 0) as today_quantity
        from public.menu_items m
        left join public.inventory i on i.menu_item_id = m.id
        left join public.menu_categories c on c.id = m.category_id
        left join sales s on s.menu_item_id = m.id
        where m.outlet_id = %(outlet)s
        order by m.is_active desc, c.sort_order nulls last, m.sort_order, m.name
        """,
        {"outlet": outlet_id, "today": today},
    )
    items = [ManagerMenuItem.model_validate(r) for r in await cur.fetchall()]
    return ManagerMenu(outlet_id=outlet_id, business_date=today, categories=categories, items=items)


async def _item(conn: Connection, outlet_id: UUID, item_id: UUID) -> ManagerMenuItem:
    menu = await get_menu(conn, outlet_id)
    for item in menu.items:
        if item.id == item_id:
            return item
    raise ApiError(404, "not_found", "Menu item not found")


async def item_outlet(conn: Connection, item_id: UUID) -> UUID:
    """The outlet of a menu item the caller can see (managers see archived items too)."""
    cur = await conn.execute("select outlet_id from public.menu_items where id = %s", (item_id,))
    row = await cur.fetchone()
    if row is None:
        raise ApiError(404, "not_found", "Menu item not found")
    outlet_id: UUID = row["outlet_id"]
    return outlet_id


async def save_item(
    conn: Connection, outlet_id: UUID, item_id: UUID | None, data: MenuItemInput
) -> ManagerMenuItem:
    cur = await conn.execute(
        """
        select app.save_menu_item(
          %(outlet)s, %(item)s, %(category_id)s, %(name)s, %(description)s, %(price_paise)s,
          %(diet)s::public.diet_type, %(calories_kcal)s, %(protein_g)s, %(prep_minutes)s,
          %(is_packaged)s, %(is_active)s, %(sort_order)s) as id
        """,
        {"outlet": outlet_id, "item": item_id, **data.model_dump()},
    )
    row = await cur.fetchone()
    assert row is not None  # noqa: S101
    return await _item(conn, outlet_id, row["id"])


async def category_outlet(conn: Connection, category_id: UUID) -> UUID:
    cur = await conn.execute(
        "select outlet_id from public.menu_categories where id = %s", (category_id,)
    )
    row = await cur.fetchone()
    if row is None:
        raise ApiError(404, "not_found", "Category not found")
    outlet_id: UUID = row["outlet_id"]
    return outlet_id


async def save_category(
    conn: Connection, outlet_id: UUID, category_id: UUID | None, data: CategoryInput
) -> ManagerCategory:
    cur = await conn.execute(
        "select app.save_menu_category(%s, %s, %s, %s, %s) as id",
        (outlet_id, category_id, data.name, data.sort_order, data.is_active),
    )
    row = await cur.fetchone()
    assert row is not None  # noqa: S101
    cur = await conn.execute(
        "select id, name, sort_order, is_active from public.menu_categories where id = %s",
        (row["id"],),
    )
    saved = await cur.fetchone()
    return ManagerCategory.model_validate(saved)


async def delete_category(conn: Connection, category_id: UUID) -> None:
    await conn.execute("select app.delete_menu_category(%s)", (category_id,))


# --- Pickup slots ------------------------------------------------------------------------------


async def list_slots(conn: Connection, outlet_id: UUID, on_date: date | None) -> list[ManagerSlot]:
    await require_manager(conn, outlet_id)
    day = on_date or await _business_date(conn, outlet_id)
    cur = await conn.execute(
        """
        select s.id, s.starts_at, s.ends_at, s.capacity, s.reserved_count, s.is_active
        from public.pickup_slots s
        join public.outlets o on o.id = s.outlet_id
        where s.outlet_id = %s and (s.starts_at at time zone o.timezone)::date = %s
        order by s.starts_at
        """,
        (outlet_id, day),
    )
    return [ManagerSlot.model_validate(r) for r in await cur.fetchall()]


async def update_slot(conn: Connection, slot_id: UUID, update: SlotUpdate) -> ManagerSlot:
    await conn.execute(
        "select app.update_pickup_slot(%s, %s, %s)", (slot_id, update.capacity, update.is_active)
    )
    cur = await conn.execute(
        "select id, starts_at, ends_at, capacity, reserved_count, is_active"
        " from public.pickup_slots where id = %s",
        (slot_id,),
    )
    return ManagerSlot.model_validate(await cur.fetchone())


# --- Staff -------------------------------------------------------------------------------------


async def list_staff(conn: Connection, outlet_id: UUID) -> list[StaffMember]:
    cur = await conn.execute(
        "select user_id, full_name, email, role::text as role, added_at"
        " from app.list_outlet_staff(%s)",
        (outlet_id,),
    )
    return [StaffMember.model_validate(r) for r in await cur.fetchall()]


async def add_staff(conn: Connection, outlet_id: UUID, data: StaffAdd) -> list[StaffMember]:
    await conn.execute(
        "select app.add_outlet_staff(%s, %s, %s::public.outlet_role)",
        (outlet_id, data.email, data.role),
    )
    return await list_staff(conn, outlet_id)


async def remove_staff(conn: Connection, outlet_id: UUID, user_id: UUID) -> None:
    await conn.execute("select app.remove_outlet_staff(%s, %s)", (outlet_id, user_id))


# --- Daily summary ----------------------------------------------------------------------------


async def summary(conn: Connection, outlet_id: UUID) -> OutletSummary:
    await require_manager(conn, outlet_id)
    today = await _business_date(conn, outlet_id)
    cur = await conn.execute(
        """
        select o.status::text as status, count(*)::int as n,
               coalesce(sum(o.total_paise), 0)::bigint as paise
        from public.orders o
        where o.outlet_id = %s and o.business_date = %s and o.payment_status = 'paid'
        group by o.status
        """,
        (outlet_id, today),
    )
    by_status: dict[str, int] = {}
    gross = 0
    for row in await cur.fetchall():
        by_status[row["status"]] = row["n"]
        gross += int(row["paise"])

    cur = await conn.execute(
        "select coalesce(sum(total_paise), 0)::bigint as owed from public.orders"
        " where outlet_id = %s and refund_status = 'required'",
        (outlet_id,),
    )
    owed_row = await cur.fetchone()

    cur = await conn.execute(
        """
        select d.status::text as status, count(*)::int as n,
               coalesce(sum(d.price_paise) filter (where d.status = 'sold'), 0)::bigint as sold
        from public.surplus_deals d
        join public.outlets o on o.id = d.outlet_id
        where d.outlet_id = %s and (d.listed_at at time zone o.timezone)::date = %s
        group by d.status
        """,
        (outlet_id, today),
    )
    deals: dict[str, Any] = dict.fromkeys(
        ("available", "reserved", "sold", "expired", "withdrawn"), 0
    )
    deal_sales = 0
    for row in await cur.fetchall():
        deals[row["status"]] = row["n"]
        deal_sales += int(row["sold"])

    cur = await conn.execute(
        "select count(*)::int as n from public.refund_requests"
        " where outlet_id = %s and status = 'pending'",
        (outlet_id,),
    )
    pending_row = await cur.fetchone()
    return OutletSummary(
        business_date=today,
        orders_by_status=by_status,
        paid_orders=sum(by_status.values()),
        gross_paid_paise=gross,
        refunds_owed_paise=int(owed_row["owed"]) if owed_row else 0,
        no_shows=by_status.get("no_show", 0),
        deals=deals,
        deal_sales_paise=deal_sales,
        pending_refund_requests=pending_row["n"] if pending_row else 0,
    )
