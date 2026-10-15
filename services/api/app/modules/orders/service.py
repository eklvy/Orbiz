"""Orders. Business rules and locking live in the `app.*` SQL functions; this module
validates input, calls them inside the caller's RLS transaction, and shapes responses."""

import base64
import binascii
import hashlib
import json
from collections import defaultdict
from datetime import datetime
from typing import Any, Literal
from uuid import UUID

from app.core.auth import Principal
from app.core.db import Connection
from app.core.errors import ApiError
from app.modules.orders.schemas import (
    ACTIVE_STATUSES,
    Order,
    OrderCreate,
    OrderDetail,
    OrderEvent,
    OrderItem,
    OrderPage,
    OrderStatus,
    RefundRequestSummary,
    StaffOrder,
    TransitionRule,
)

PickupResult = Literal["completed", "invalid_code", "locked"]

_ORDER_SELECT = """
    select o.id, o.user_id, o.status::text as status, o.payment_status::text as payment_status,
           o.refund_status::text as refund_status, o.token_label, o.subtotal_paise,
           o.discount_paise, o.total_paise,
           o.item_count, o.reservation_expires_at, o.placed_at, o.confirmed_at, o.preparing_at,
           o.ready_at, o.completed_at, o.cancelled_at, o.cancel_reason,
           o.cancelled_by::text as cancelled_by, o.version, o.created_at, o.updated_at,
           o.source_deal_id, o.group_session_id, o.no_show_at,
           case when o.status = 'ready_for_pickup'
                then private.pickup_deadline(o.ready_at, s.ends_at, ot.no_show_grace_minutes)
           end as pickup_deadline,
           ot.id as outlet_id, ot.slug as outlet_slug, ot.name as outlet_name,
           s.id as slot_id, s.starts_at as slot_starts_at, s.ends_at as slot_ends_at,
           pc.code as pickup_code,
           (select sum(l.points)::int from public.loyalty_ledger l
             where l.order_id = o.id and l.user_id = o.user_id) as loyalty_points
    from public.orders o
    join public.outlets ot on ot.id = o.outlet_id
    left join public.pickup_slots s on s.id = o.pickup_slot_id
    left join public.order_pickup_codes pc on pc.order_id = o.id
"""


def request_hash(payload: OrderCreate) -> str:
    """Canonical fingerprint of an order request, used to detect idempotency-key reuse."""
    quantities: dict[str, int] = defaultdict(int)
    for line in payload.items:
        quantities[str(line.menu_item_id)] += line.quantity
    canonical = json.dumps(
        {
            "outlet_id": str(payload.outlet_id),
            "pickup_slot_id": str(payload.pickup_slot_id),
            "items": sorted(quantities.items()),
        },
        separators=(",", ":"),
    )
    return hashlib.sha256(canonical.encode()).hexdigest()


def encode_cursor(created_at: datetime, order_id: UUID) -> str:
    raw = f"{created_at.isoformat()}|{order_id}".encode()
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def decode_cursor(cursor: str) -> tuple[datetime, UUID]:
    try:
        padded = cursor + "=" * (-len(cursor) % 4)
        created, order_id = base64.urlsafe_b64decode(padded).decode().split("|", 1)
        return datetime.fromisoformat(created), UUID(order_id)
    except (ValueError, binascii.Error, UnicodeDecodeError) as exc:
        raise ApiError(422, "validation_error", "Invalid cursor") from exc


async def _load_orders(conn: Connection, ids: list[UUID]) -> dict[UUID, dict[str, Any]]:
    if not ids:
        return {}
    cur = await conn.execute(_ORDER_SELECT + " where o.id = any(%s)", (ids,))
    rows = {row["id"]: row for row in await cur.fetchall()}

    cur = await conn.execute(
        "select id, order_id, menu_item_id, item_name, unit_price_paise, quantity,"
        " line_total_paise, is_packaged"
        " from public.order_items where order_id = any(%s) order by item_name",
        (list(rows),),
    )
    items: dict[UUID, list[OrderItem]] = defaultdict(list)
    for item in await cur.fetchall():
        items[item["order_id"]].append(OrderItem.model_validate(item))

    result: dict[UUID, dict[str, Any]] = {}
    for order_id, row in rows.items():
        position = None
        if row["status"] in ("placed", "confirmed", "preparing"):
            cur = await conn.execute("select app.order_queue_position(%s) as position", (order_id,))
            position_row = await cur.fetchone()
            position = position_row["position"] if position_row else None
        result[order_id] = {
            **row,
            "outlet": {
                "id": row["outlet_id"],
                "slug": row["outlet_slug"],
                "name": row["outlet_name"],
            },
            "pickup_slot": (
                {
                    "id": row["slot_id"],
                    "starts_at": row["slot_starts_at"],
                    "ends_at": row["slot_ends_at"],
                }
                if row["slot_id"] is not None
                else None
            ),
            "queue_position": position,
            "items": items[order_id],
        }
    return result


async def get_order(conn: Connection, order_id: UUID) -> OrderDetail:
    """Returns the order if the caller may see it (owner, outlet staff, admin) — RLS decides."""
    loaded = await _load_orders(conn, [order_id])
    if order_id not in loaded:
        raise ApiError(404, "not_found", "Order not found")
    cur = await conn.execute(
        "select event_type, from_status::text as from_status, to_status::text as to_status,"
        " actor::text as actor, reason, created_at"
        " from public.order_events where order_id = %s order by id",
        (order_id,),
    )
    events = [OrderEvent.model_validate(e) for e in await cur.fetchall()]
    # RLS: visible to the student who asked and to the outlet's managers.
    cur = await conn.execute(
        "select id, status::text as status, amount_paise, reason, decision_note, created_at,"
        " decided_at from public.refund_requests where order_id = %s",
        (order_id,),
    )
    refund = await cur.fetchone()
    return OrderDetail.model_validate(
        {
            **loaded[order_id],
            "events": events,
            "refund_request": RefundRequestSummary.model_validate(refund) if refund else None,
        }
    )


async def create_order(conn: Connection, payload: OrderCreate, idempotency_key: str) -> OrderDetail:
    cur = await conn.execute(
        "select app.create_order(%s, %s, %s::jsonb, %s, %s) as id",
        (
            payload.outlet_id,
            payload.pickup_slot_id,
            json.dumps(
                [
                    {"menu_item_id": str(i.menu_item_id), "quantity": i.quantity}
                    for i in payload.items
                ]
            ),
            idempotency_key,
            request_hash(payload),
        ),
    )
    row = await cur.fetchone()
    assert row is not None  # noqa: S101 — the function returns a value or raises
    return await get_order(conn, row["id"])


async def list_my_orders(
    conn: Connection, principal: Principal, *, limit: int, cursor: str | None
) -> OrderPage:
    params: list[Any] = [principal.user_id]
    keyset = ""
    if cursor:
        created_at, order_id = decode_cursor(cursor)
        keyset = " and (o.created_at, o.id) < (%s, %s)"
        params += [created_at, order_id]
    cur = await conn.execute(
        "select o.id, o.created_at from public.orders o where o.user_id = %s"  # noqa: S608
        + keyset  # fixed fragment; values are bound parameters
        + " order by o.created_at desc, o.id desc limit %s",
        (*params, limit + 1),
    )
    page = await cur.fetchall()
    has_more = len(page) > limit
    page = page[:limit]
    loaded = await _load_orders(conn, [r["id"] for r in page])
    return OrderPage(
        items=[Order.model_validate(loaded[r["id"]]) for r in page],
        next_cursor=encode_cursor(page[-1]["created_at"], page[-1]["id"]) if has_more else None,
    )


async def transition(
    conn: Connection, order_id: UUID, to_status: OrderStatus, reason: str | None
) -> OrderDetail:
    await conn.execute(
        "select app.transition_order(%s, %s::public.order_status, %s)",
        (order_id, to_status, reason),
    )
    return await get_order(conn, order_id)


async def verify_pickup(conn: Connection, order_id: UUID, code: str) -> PickupResult:
    cur = await conn.execute("select app.verify_pickup(%s, %s) as result", (order_id, code))
    row = await cur.fetchone()
    assert row is not None  # noqa: S101
    result: PickupResult = row["result"]
    return result


async def require_outlet_staff(conn: Connection, outlet_id: UUID) -> None:
    cur = await conn.execute(
        "select private.is_outlet_staff(%s) or private.is_admin() as allowed", (outlet_id,)
    )
    row = await cur.fetchone()
    if row is None or not row["allowed"]:
        raise ApiError(403, "forbidden", "You are not staff at this outlet")


async def outlet_queue(
    conn: Connection, outlet_id: UUID, statuses: list[OrderStatus] | None
) -> list[StaffOrder]:
    await require_outlet_staff(conn, outlet_id)
    wanted = list(statuses or ACTIVE_STATUSES)
    cur = await conn.execute(
        """
        select o.id from public.orders o
        left join public.pickup_slots s on s.id = o.pickup_slot_id
        where o.outlet_id = %s and o.status::text = any(%s)
        order by coalesce(s.starts_at, o.ready_at), o.placed_at nulls last,
                 o.token_number nulls last
        limit 200
        """,
        (outlet_id, wanted),
    )
    ids = [r["id"] for r in await cur.fetchall()]
    return await staff_orders(conn, ids)


async def staff_orders(conn: Connection, ids: list[UUID]) -> list[StaffOrder]:
    """Orders for the counter, in the given order: with the customer's name and, for deal
    orders, the token the food originally belonged to."""
    loaded = await _load_orders(conn, ids)
    cur = await conn.execute(
        "select order_id, customer_name from app.order_customer_names(%s)", (ids,)
    )
    names = {r["order_id"]: r["customer_name"] for r in await cur.fetchall()}
    cur = await conn.execute(
        "select o.id, src.token_label from public.orders o"
        " join public.surplus_deals d on d.id = o.source_deal_id"
        " join public.orders src on src.id = d.source_order_id"
        " where o.id = any(%s)",
        (ids,),
    )
    sources = {r["id"]: r["token_label"] for r in await cur.fetchall()}
    # Staff never receive pickup codes (RLS already hides them; this is belt and braces).
    return [
        StaffOrder.model_validate(
            {
                **loaded[i],
                "pickup_code": None,
                "customer_name": names.get(i),
                "deal_source_token": sources.get(i),
            }
        )
        for i in ids
        if i in loaded
    ]


async def list_transition_rules(conn: Connection) -> list[TransitionRule]:
    cur = await conn.execute(
        "select from_status::text as from_status, to_status::text as to_status,"
        " actor::text as actor,"
        " requires_paid, requires_reason, requires_pickup_code, releases_stock, releases_slot,"
        " marks_refund_required, description"
        " from public.order_status_transitions order by from_status, to_status, actor"
    )
    return [TransitionRule.model_validate(r) for r in await cur.fetchall()]
