"""Notification Center reads/read-state, device tokens, and the optional Expo push sender."""

import asyncio
import logging
from datetime import datetime
from typing import Any

import httpx2 as httpx

from app.core.auth import Principal
from app.core.config import Settings
from app.core.db import Connection, Database
from app.modules.notifications.schemas import (
    MarkRead,
    Notification,
    NotificationCategory,
    NotificationPage,
    PushTokenIn,
)

logger = logging.getLogger(__name__)


async def list_notifications(
    conn: Connection,
    principal: Principal,
    *,
    limit: int,
    before: datetime | None,
    category: NotificationCategory | None,
) -> NotificationPage:
    cur = await conn.execute(
        """
        select id, category::text as category, title, body, data, read_at, created_at
        from public.notifications
        where user_id = %(user)s
          and (%(before)s::timestamptz is null or created_at < %(before)s)
          and (%(category)s::text is null or category::text = %(category)s)
        order by created_at desc, id desc limit %(limit)s
        """,
        {"user": principal.user_id, "before": before, "category": category, "limit": limit + 1},
    )
    rows = await cur.fetchall()
    items = [Notification.model_validate(r) for r in rows[:limit]]
    cur = await conn.execute(
        "select count(*)::int as n from public.notifications"
        " where user_id = %s and read_at is null",
        (principal.user_id,),
    )
    unread = await cur.fetchone()
    return NotificationPage(
        items=items,
        unread_count=unread["n"] if unread else 0,
        next_cursor=items[-1].created_at if len(rows) > limit else None,
    )


async def mark_read(conn: Connection, body: MarkRead) -> int:
    cur = await conn.execute(
        "select app.mark_notifications_read(%s) as n",
        ([str(i) for i in body.ids] if body.ids else None,),
    )
    row = await cur.fetchone()
    return int(row["n"]) if row else 0


async def register_token(conn: Connection, body: PushTokenIn) -> None:
    await conn.execute("select app.register_push_token(%s, %s)", (body.token, body.platform))


async def remove_token(conn: Connection, token: str) -> None:
    await conn.execute("select app.remove_push_token(%s)", (token,))


async def send_pending_pushes(db: Database, client: httpx.AsyncClient, push_url: str) -> int:
    """One sender pass: claims unsent notifications (marked pushed in the same transaction) and
    posts them to Expo in batches of 100. At-most-once: a failed push still shows in-app."""
    async with db.system_transaction() as conn:
        cur = await conn.execute(
            "select notification_id, token, title, body, data from app.claim_pending_pushes(200)"
        )
        rows: list[dict[str, Any]] = await cur.fetchall()
    for start in range(0, len(rows), 100):
        messages = [
            {
                "to": r["token"],
                "title": r["title"],
                "body": r["body"],
                "data": r["data"],
                "sound": "default",
            }
            for r in rows[start : start + 100]
        ]
        try:
            response = await client.post(push_url, json=messages)
            if response.status_code >= 400:
                logger.warning("expo push rejected a batch: %s", response.status_code)
        except httpx.HTTPError as exc:
            logger.warning("expo push failed: %s", type(exc).__name__)
    return len(rows)


async def push_loop(
    db: Database, settings: Settings, transport: httpx.AsyncBaseTransport | None
) -> None:
    """Runs while the API is up, only when CAMPUSCART_EXPO_ACCESS_TOKEN is set."""
    assert settings.expo_access_token is not None  # noqa: S101
    headers = {"Authorization": f"Bearer {settings.expo_access_token.get_secret_value()}"}
    async with httpx.AsyncClient(headers=headers, timeout=10, transport=transport) as client:
        while True:
            try:
                await send_pending_pushes(db, client, settings.expo_push_url)
            except Exception:  # keep the loop alive; the next pass retries
                logger.exception("push sender pass failed")
            await asyncio.sleep(15)
