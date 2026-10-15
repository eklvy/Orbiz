from datetime import datetime
from typing import Annotated, Any, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, StringConstraints

NotificationCategory = Literal["orders", "refunds", "loyalty", "specials", "social"]


class Notification(BaseModel):
    id: UUID
    category: NotificationCategory
    title: str
    body: str
    data: dict[str, Any]
    read_at: datetime | None
    created_at: datetime


class NotificationPage(BaseModel):
    items: list[Notification]
    unread_count: int
    next_cursor: datetime | None


class MarkRead(BaseModel):
    model_config = ConfigDict(extra="forbid")

    # Omit to mark everything read.
    ids: Annotated[list[UUID], Field(max_length=200)] | None = None


class MarkedCount(BaseModel):
    marked: int


class PushTokenIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    token: Annotated[str, StringConstraints(strip_whitespace=True, max_length=200)]
    platform: Literal["ios", "android"]
