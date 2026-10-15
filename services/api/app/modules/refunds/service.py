"""Refunds & cancellations desk. Rules live in app.request_refund / app.decide_refund_request /
app.approve_pending_refunds; money movement is Phase 5."""

from uuid import UUID

from app.core.db import Connection
from app.core.errors import ApiError
from app.modules.orders import service as orders
from app.modules.orders.schemas import OrderDetail
from app.modules.refunds.schemas import (
    OwedRefund,
    RefundDecision,
    RefundDesk,
    RefundRequestEntry,
)


async def request_refund(conn: Connection, order_id: UUID, reason: str) -> OrderDetail:
    await conn.execute("select app.request_refund(%s, %s)", (order_id, reason))
    return await orders.get_order(conn, order_id)


async def _require_manager(conn: Connection, outlet_id: UUID) -> None:
    cur = await conn.execute(
        "select private.is_outlet_manager(%s) or private.is_admin() as allowed", (outlet_id,)
    )
    row = await cur.fetchone()
    if row is None or not row["allowed"]:
        raise ApiError(403, "forbidden", "Only this outlet's managers can do that")


async def desk(conn: Connection, outlet_id: UUID) -> RefundDesk:
    await _require_manager(conn, outlet_id)
    cur = await conn.execute(
        """
        select r.id, r.order_id, o.token_label as order_token, n.customer_name, r.amount_paise,
               r.reason, r.status::text as status, r.decision_note, r.decided_by, r.created_at,
               r.decided_at
        from public.refund_requests r
        join public.orders o on o.id = r.order_id
        left join lateral app.order_customer_names(array[r.order_id]) n on true
        where r.outlet_id = %s
          and (r.status = 'pending' or r.decided_at > now() - interval '30 days')
        order by r.status <> 'pending', coalesce(r.decided_at, r.created_at) desc
        limit 300
        """,
        (outlet_id,),
    )
    entries = [RefundRequestEntry.model_validate(r) for r in await cur.fetchall()]
    pending = sorted((e for e in entries if e.status == "pending"), key=lambda e: e.created_at)
    decided = [e for e in entries if e.status != "pending"][:50]

    # Owed without a request: paid orders the kitchen (or student, before acceptance) cancelled.
    cur = await conn.execute(
        """
        select o.id as order_id, o.token_label as order_token, n.customer_name,
               o.total_paise as amount_paise, o.status::text as order_status, o.cancel_reason,
               coalesce(o.cancelled_at, o.updated_at) as owed_since
        from public.orders o
        left join lateral app.order_customer_names(array[o.id]) n on true
        where o.outlet_id = %s and o.refund_status = 'required'
          and not exists (select 1 from public.refund_requests r where r.order_id = o.id)
        order by owed_since
        limit 300
        """,
        (outlet_id,),
    )
    owed = [OwedRefund.model_validate(r) for r in await cur.fetchall()]

    cur = await conn.execute(
        """
        select percentile_cont(0.5) within group (
                 order by extract(epoch from decided_at - created_at) / 60) as median
        from public.refund_requests
        where outlet_id = %s and decided_at > now() - interval '7 days'
        """,
        (outlet_id,),
    )
    row = await cur.fetchone()
    median = round(float(row["median"]), 1) if row and row["median"] is not None else None
    return RefundDesk(
        pending=pending, decided=decided, owed=owed, median_resolution_minutes_7d=median
    )


async def decide(conn: Connection, request_id: UUID, decision: RefundDecision) -> None:
    await conn.execute(
        "select app.decide_refund_request(%s, %s, %s)",
        (request_id, decision.decision == "approve", decision.note),
    )


async def approve_all(conn: Connection, outlet_id: UUID) -> int:
    cur = await conn.execute("select app.approve_pending_refunds(%s) as approved", (outlet_id,))
    row = await cur.fetchone()
    assert row is not None  # noqa: S101
    approved: int = row["approved"]
    return approved
