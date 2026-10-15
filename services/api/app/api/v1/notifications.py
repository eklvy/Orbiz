from datetime import datetime
from typing import Annotated

from fastapi import APIRouter, Query, status

from app.api.deps import CurrentPrincipal, Db
from app.modules.notifications import service
from app.modules.notifications.schemas import (
    MarkedCount,
    MarkRead,
    NotificationCategory,
    NotificationPage,
    PushTokenIn,
)

router = APIRouter(prefix="/notifications", tags=["notifications"])


@router.get("", response_model=NotificationPage)
async def list_notifications(
    principal: CurrentPrincipal,
    db: Db,
    limit: Annotated[int, Query(ge=1, le=50)] = 20,
    before: datetime | None = None,
    category: NotificationCategory | None = None,
) -> NotificationPage:
    """Your notifications, newest first, with the unread count."""
    async with db.user_transaction(principal) as conn:
        return await service.list_notifications(
            conn, principal, limit=limit, before=before, category=category
        )


@router.post("/read", response_model=MarkedCount)
async def mark_read(body: MarkRead, principal: CurrentPrincipal, db: Db) -> MarkedCount:
    async with db.user_transaction(principal) as conn:
        return MarkedCount(marked=await service.mark_read(conn, body))


@router.post("/push-tokens", status_code=status.HTTP_204_NO_CONTENT)
async def register_push_token(body: PushTokenIn, principal: CurrentPrincipal, db: Db) -> None:
    """Register this device's Expo push token (sent only if the server has Expo set up)."""
    async with db.user_transaction(principal) as conn:
        await service.register_token(conn, body)


@router.delete("/push-tokens/{token}", status_code=status.HTTP_204_NO_CONTENT)
async def remove_push_token(token: str, principal: CurrentPrincipal, db: Db) -> None:
    async with db.user_transaction(principal) as conn:
        await service.remove_token(conn, token)
