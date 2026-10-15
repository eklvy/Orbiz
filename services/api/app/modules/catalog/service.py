"""Public catalogue reads (outlets, menus, pickup slots). Run in an anon transaction."""

from datetime import UTC, date, datetime
from typing import Any
from uuid import UUID

from app.core.db import Connection
from app.core.errors import ApiError
from app.modules.catalog.schemas import (
    CrowdLevel,
    Diet,
    Menu,
    MenuCategory,
    MenuItem,
    OpeningHours,
    Outlet,
    OutletDetail,
    PickupSlot,
    QueueStats,
)

_OUTLET_SELECT = """
    select o.id, o.slug, o.name, o.description, o.location, o.status::text as status,
           o.status_reason, o.break_until, o.is_active, o.timezone,
           q.active_orders, q.estimated_wait_minutes
    from public.outlets o
    cross join lateral app.outlet_queue_stats(o.id) q
"""


def crowd_level(wait_minutes: int) -> CrowdLevel:
    if wait_minutes <= 5:
        return "low"
    if wait_minutes <= 15:
        return "medium"
    return "high"


def _outlet_from_row(row: dict[str, Any], now: datetime) -> dict[str, Any]:
    status = row["status"]
    break_over = (
        status == "on_break" and row["break_until"] is not None and row["break_until"] <= now
    )
    effective = "open" if break_over else status
    return {
        "id": row["id"],
        "slug": row["slug"],
        "name": row["name"],
        "description": row["description"],
        "location": row["location"],
        "status": effective,
        "status_reason": None if effective == "open" else row["status_reason"],
        "break_until": None if break_over else row["break_until"],
        "accepting_orders": bool(row["is_active"]) and effective == "open",
        "timezone": row["timezone"],
        "queue": QueueStats(
            active_orders=row["active_orders"],
            estimated_wait_minutes=row["estimated_wait_minutes"],
            crowd_level=crowd_level(row["estimated_wait_minutes"]),
        ),
    }


async def list_outlets(conn: Connection) -> list[Outlet]:
    cur = await conn.execute(_OUTLET_SELECT + " where o.is_active order by o.name")
    now = datetime.now(UTC)
    return [Outlet.model_validate(_outlet_from_row(row, now)) for row in await cur.fetchall()]


async def get_outlet(conn: Connection, outlet_ref: str) -> OutletDetail:
    try:
        outlet_id: UUID | None = UUID(outlet_ref)
    except ValueError:
        outlet_id = None
    cur = await conn.execute(
        _OUTLET_SELECT + " where (o.id = %s or o.slug = %s) and o.is_active",
        (outlet_id, outlet_ref),
    )
    row = await cur.fetchone()
    if row is None:
        raise ApiError(404, "not_found", "Outlet not found")
    cur = await conn.execute(
        "select day_of_week, opens_at, closes_at from public.outlet_hours"
        " where outlet_id = %s order by day_of_week, opens_at",
        (row["id"],),
    )
    hours = [OpeningHours.model_validate(h) for h in await cur.fetchall()]
    return OutletDetail.model_validate({**_outlet_from_row(row, datetime.now(UTC)), "hours": hours})


async def _require_visible_outlet(conn: Connection, outlet_id: UUID) -> None:
    cur = await conn.execute(
        "select 1 from public.outlets where id = %s and is_active", (outlet_id,)
    )
    if await cur.fetchone() is None:
        raise ApiError(404, "not_found", "Outlet not found")


def _escape_like(term: str) -> str:
    return term.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


async def get_menu(
    conn: Connection,
    outlet_id: UUID,
    *,
    category_id: UUID | None = None,
    diet: Diet | None = None,
    max_price_paise: int | None = None,
    search: str | None = None,
    available_only: bool = False,
) -> Menu:
    await _require_visible_outlet(conn, outlet_id)
    cur = await conn.execute(
        "select id, name from public.menu_categories"
        " where outlet_id = %s and is_active order by sort_order, name",
        (outlet_id,),
    )
    categories = await cur.fetchall()

    filters = ["m.outlet_id = %(outlet_id)s", "m.is_active"]
    params: dict[str, Any] = {"outlet_id": outlet_id}
    if category_id is not None:
        filters.append("m.category_id = %(category_id)s")
        params["category_id"] = category_id
    if diet is not None:
        filters.append("m.diet = %(diet)s::public.diet_type")
        params["diet"] = diet
    if max_price_paise is not None:
        filters.append("m.price_paise <= %(max_price)s")
        params["max_price"] = max_price_paise
    if search:
        filters.append("(m.name ilike %(search)s or m.description ilike %(search)s)")
        params["search"] = f"%{_escape_like(search)}%"
    if available_only:
        filters.append("m.stock_status <> 'sold_out'")

    cur = await conn.execute(
        f"""
        select m.id, m.category_id, m.name, m.description, m.price_paise, m.diet::text as diet,
               m.calories_kcal, m.protein_g, m.prep_minutes, m.stock_status::text as stock_status,
               case when m.track_quantity then i.quantity_available end as quantity_available,
               sp.special_id, sp.unit_price_paise as special_price_paise,
               sp.discount_percent as special_discount_percent,
               sp.portions_left as special_portions_left
        from public.menu_items m
        left join public.inventory i on i.menu_item_id = m.id
        left join lateral app.item_special(m.id) sp on true
        left join public.menu_categories c on c.id = m.category_id
        where {" and ".join(filters)}
        order by c.sort_order nulls last, m.sort_order, m.name
        """,  # noqa: S608 — filters are fixed fragments; values are bound parameters
        params,
    )
    items = [
        MenuItem.model_validate(
            {
                **row,
                "special": (
                    {
                        "special_id": row["special_id"],
                        "unit_price_paise": row["special_price_paise"],
                        "discount_percent": row["special_discount_percent"],
                        "portions_left": row["special_portions_left"],
                    }
                    if row["special_id"]
                    else None
                ),
            }
        )
        for row in await cur.fetchall()
    ]

    by_category: dict[UUID, list[MenuItem]] = {c["id"]: [] for c in categories}
    uncategorized: list[MenuItem] = []
    for item in items:
        if item.category_id in by_category:
            by_category[item.category_id].append(item)
        else:
            uncategorized.append(item)
    # Unfiltered: show every active category (an empty one is honest information).
    # Filtered: show only categories with matching items.
    filtered = len(filters) > 2  # anything beyond the outlet + is_active base filters
    return Menu(
        outlet_id=outlet_id,
        categories=[
            MenuCategory(id=c["id"], name=c["name"], items=by_category[c["id"]])
            for c in categories
            if by_category[c["id"]] or not filtered
        ],
        uncategorized=uncategorized,
    )


async def list_pickup_slots(
    conn: Connection, outlet_id: UUID, *, on_date: date | None = None, include_full: bool = True
) -> list[PickupSlot]:
    await _require_visible_outlet(conn, outlet_id)
    if on_date is None:
        window = "s.starts_at > now() and s.starts_at < now() + interval '48 hours'"
        params: tuple[Any, ...] = (outlet_id,)
    else:
        window = "s.starts_at > now() and (s.starts_at at time zone o.timezone)::date = %s"
        params = (outlet_id, on_date)
    cur = await conn.execute(
        f"""
        select s.id, s.starts_at, s.ends_at, s.capacity,
               greatest(s.capacity - s.reserved_count, 0) as remaining
        from public.pickup_slots s
        join public.outlets o on o.id = s.outlet_id
        where s.outlet_id = %s and s.is_active and {window}
        order by s.starts_at
        limit 200
        """,  # noqa: S608 — window is one of two fixed fragments
        params,
    )
    slots = [
        PickupSlot.model_validate({**row, "bookable": row["remaining"] > 0})
        for row in await cur.fetchall()
    ]
    return slots if include_full else [s for s in slots if s.bookable]
