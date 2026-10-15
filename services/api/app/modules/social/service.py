"""Group orders, party bookings and bill splits. Money and permissions are enforced by app.* SQL
functions; this module validates input and assembles responses (names via narrow helpers)."""

import json
from typing import Any
from uuid import UUID

from app.core.auth import Principal
from app.core.db import Connection
from app.core.errors import ApiError
from app.modules.social.schemas import (
    Group,
    GroupItem,
    GroupMember,
    GroupSplit,
    Party,
    PartyItem,
    PartyRequest,
    Split,
    SplitCreate,
    SplitShare,
)

# --- Group orders ------------------------------------------------------------------------------


async def get_group(conn: Connection, principal: Principal, group_id: UUID) -> Group:
    cur = await conn.execute(
        """
        select g.id, g.host_id, g.invite_code, g.status::text as status,
               g.split_mode::text as split_mode, g.version, g.order_id, g.created_at,
               o.id as outlet_id, o.slug as outlet_slug, o.name as outlet_name,
               s.id as slot_id, s.starts_at, s.ends_at,
               ord.status::text as order_status, ord.token_label, ord.total_paise as order_total,
               ord.reservation_expires_at
        from public.group_sessions g
        join public.outlets o on o.id = g.outlet_id
        join public.pickup_slots s on s.id = g.pickup_slot_id
        left join public.orders ord on ord.id = g.order_id
        where g.id = %s
        """,
        (group_id,),
    )
    g = await cur.fetchone()
    if g is None:  # RLS: members only
        raise ApiError(404, "not_found", "Group order not found")
    cur = await conn.execute(
        """
        select m.user_id, n.full_name, m.percent, sh.amount_paise as share_paise,
               sh.paid_at is not null as paid
        from public.group_members m
        left join app.group_member_names(%(g)s) n on n.user_id = m.user_id
        left join public.group_shares sh on sh.session_id = m.session_id and sh.user_id = m.user_id
        where m.session_id = %(g)s order by m.joined_at
        """,
        {"g": group_id},
    )
    members = [
        GroupMember.model_validate(
            {
                **r,
                "is_host": r["user_id"] == g["host_id"],
                "is_me": r["user_id"] == principal.user_id,
                "paid": r["paid"] if r["share_paise"] is not None else None,
            }
        )
        for r in await cur.fetchall()
    ]
    cur = await conn.execute(
        """
        select gi.id, gi.member_id, gi.menu_item_id, m.name as item_name, gi.quantity,
               coalesce(oi.unit_price_paise, sp.unit_price_paise, m.price_paise) as unit_price_paise
        from public.group_items gi
        join public.menu_items m on m.id = gi.menu_item_id
        left join lateral app.item_special(m.id) sp on true
        left join public.group_sessions g on g.id = gi.session_id
        left join public.order_items oi
          on oi.order_id = g.order_id and oi.menu_item_id = gi.menu_item_id
        where gi.session_id = %s order by gi.created_at
        """,
        (group_id,),
    )
    items = [
        GroupItem.model_validate({**r, "line_total_paise": r["unit_price_paise"] * r["quantity"]})
        for r in await cur.fetchall()
    ]
    return Group.model_validate(
        {
            **g,
            "outlet": {"id": g["outlet_id"], "slug": g["outlet_slug"], "name": g["outlet_name"]},
            "pickup_slot": {
                "id": g["slot_id"],
                "starts_at": g["starts_at"],
                "ends_at": g["ends_at"],
            },
            "members": members,
            "items": items,
            "total_paise": g["order_total"]
            if g["order_total"] is not None
            else sum(i.line_total_paise for i in items),
            "payment_due_by": g["reservation_expires_at"] if g["status"] == "locked" else None,
        }
    )


async def my_groups(conn: Connection, principal: Principal) -> list[Group]:
    cur = await conn.execute(
        "select g.id from public.group_sessions g"
        " where g.status in ('open', 'locked') or g.updated_at > now() - interval '2 days'"
        " order by g.created_at desc limit 20"
    )
    return [await get_group(conn, principal, r["id"]) for r in await cur.fetchall()]


async def create_group(
    conn: Connection, principal: Principal, outlet_id: UUID, slot_id: UUID
) -> Group:
    cur = await conn.execute("select app.create_group(%s, %s) as id", (outlet_id, slot_id))
    row = await cur.fetchone()
    assert row is not None  # noqa: S101
    return await get_group(conn, principal, row["id"])


async def join_group(conn: Connection, principal: Principal, code: str) -> Group:
    cur = await conn.execute("select app.join_group(%s) as id", (code,))
    row = await cur.fetchone()
    assert row is not None  # noqa: S101
    return await get_group(conn, principal, row["id"])


async def set_item(
    conn: Connection, principal: Principal, group_id: UUID, member: UUID, item: UUID, qty: int
) -> Group:
    await conn.execute("select app.set_group_item(%s, %s, %s, %s)", (group_id, member, item, qty))
    return await get_group(conn, principal, group_id)


async def set_split(
    conn: Connection, principal: Principal, group_id: UUID, body: GroupSplit
) -> Group:
    percents = (
        json.dumps({str(k): v for k, v in body.percents.items()})
        if body.percents is not None
        else None
    )
    await conn.execute(
        "select app.set_group_split(%s, %s::public.split_mode, %s::jsonb)",
        (group_id, body.mode, percents),
    )
    return await get_group(conn, principal, group_id)


async def call_and_get(conn: Connection, principal: Principal, fn: str, group_id: UUID) -> Group:
    """lock_group / pay_group_share / leave_group, then the group's current state."""
    assert fn in {"lock_group", "pay_group_share", "leave_group"}  # noqa: S101
    await conn.execute(f"select app.{fn}(%s)", (group_id,))
    return await get_group(conn, principal, group_id)


# --- Party bookings ---------------------------------------------------------------------------


async def _parties(
    conn: Connection,
    *,
    user_id: UUID | None = None,
    outlet_id: UUID | None = None,
    booking_id: UUID | None = None,
    names: bool,
) -> list[Party]:
    cur = await conn.execute(
        """
        select b.id, b.outlet_id, o.name as outlet_name, b.event_name, b.event_at, b.headcount,
               b.notes, b.status::text as status, b.total_paise, b.manager_note, b.created_at
        from public.party_bookings b join public.outlets o on o.id = b.outlet_id
        where (%(user)s::uuid is null or b.user_id = %(user)s)
          and (%(outlet)s::uuid is null
               or (b.outlet_id = %(outlet)s and b.event_at > now() - interval '7 days'))
          and (%(id)s::uuid is null or b.id = %(id)s)
        order by b.event_at limit 100
        """,
        {"user": user_id, "outlet": outlet_id, "id": booking_id},
    )
    rows = await cur.fetchall()
    ids = [r["id"] for r in rows]
    cur = await conn.execute(
        "select booking_id, menu_item_id, item_name, unit_price_paise, quantity"
        " from public.party_items where booking_id = any(%s) order by item_name",
        (ids,),
    )
    items: dict[UUID, list[PartyItem]] = {i: [] for i in ids}
    for r in await cur.fetchall():
        items[r["booking_id"]].append(PartyItem.model_validate(r))
    customer: dict[UUID, str] = {}
    if names and ids:
        cur = await conn.execute("select * from app.party_customer_names(%s)", (ids,))
        customer = {r["booking_id"]: r["full_name"] for r in await cur.fetchall()}
    return [
        Party.model_validate({**r, "items": items[r["id"]], "customer_name": customer.get(r["id"])})
        for r in rows
    ]


async def my_parties(conn: Connection, principal: Principal) -> list[Party]:
    return await _parties(conn, user_id=principal.user_id, names=False)


async def outlet_parties(conn: Connection, outlet_id: UUID) -> list[Party]:
    return await _parties(conn, outlet_id=outlet_id, names=True)


async def party(conn: Connection, booking_id: UUID, *, names: bool = False) -> Party:
    found = await _parties(conn, booking_id=booking_id, names=names)
    if not found:
        raise ApiError(404, "not_found", "Booking not found")
    return found[0]


async def request_party(conn: Connection, body: PartyRequest) -> Party:
    cur = await conn.execute(
        "select app.request_party(%s, %s, %s, %s, %s::jsonb, %s) as id",
        (
            body.outlet_id,
            body.event_name,
            body.event_at,
            body.headcount,
            json.dumps(
                [{"menu_item_id": str(i.menu_item_id), "quantity": i.quantity} for i in body.items]
            ),
            body.notes,
        ),
    )
    row = await cur.fetchone()
    assert row is not None  # noqa: S101
    return await party(conn, row["id"])


async def party_action(conn: Connection, fn: str, booking_id: UUID, *args: Any) -> None:
    assert fn in {"pay_party", "cancel_party", "fulfil_party", "decide_party"}  # noqa: S101
    placeholders = ", ".join(["%s"] * (1 + len(args)))
    await conn.execute(f"select app.{fn}({placeholders})", (booking_id, *args))


# --- Bill splits --------------------------------------------------------------------------------


async def split(conn: Connection, principal: Principal, split_id: UUID) -> Split:
    cur = await conn.execute(
        "select id, title, total_paise, creator_id, settled_at, cancelled_at, created_at"
        " from public.bill_splits where id = %s",
        (split_id,),
    )
    row = await cur.fetchone()
    if row is None:
        raise ApiError(404, "not_found", "Bill split not found")
    cur = await conn.execute("select user_id, full_name from app.split_people(%s)", (split_id,))
    names = {r["user_id"]: r["full_name"] for r in await cur.fetchall()}
    cur = await conn.execute(
        "select user_id, amount_paise, paid_at is not null as paid from public.bill_split_shares"
        " where split_id = %s order by amount_paise desc",
        (split_id,),
    )
    shares = [
        SplitShare.model_validate({**r, "full_name": names.get(r["user_id"])})
        for r in await cur.fetchall()
    ]
    return Split.model_validate(
        {
            **row,
            "creator_name": names.get(row["creator_id"]),
            "i_am_creator": row["creator_id"] == principal.user_id,
            "shares": shares,
        }
    )


async def my_splits(conn: Connection, principal: Principal) -> list[Split]:
    cur = await conn.execute(
        "select id from public.bill_splits order by created_at desc limit 30"
    )  # RLS: creator or participant
    return [await split(conn, principal, r["id"]) for r in await cur.fetchall()]


async def create_split(conn: Connection, principal: Principal, body: SplitCreate) -> Split:
    cur = await conn.execute(
        "select app.create_bill_split(%s, %s, %s::jsonb) as id",
        (
            body.title,
            body.total_paise,
            json.dumps([{"email": s.email, "amount_paise": s.amount_paise} for s in body.shares]),
        ),
    )
    row = await cur.fetchone()
    assert row is not None  # noqa: S101
    return await split(conn, principal, row["id"])


async def split_action(conn: Connection, principal: Principal, fn: str, split_id: UUID) -> Split:
    assert fn in {"settle_bill_share", "cancel_bill_split"}  # noqa: S101
    await conn.execute(f"select app.{fn}(%s)", (split_id,))
    return await split(conn, principal, split_id)
