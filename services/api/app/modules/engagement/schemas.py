from datetime import date, datetime
from typing import Annotated, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, StringConstraints

Stars = Annotated[int, Field(ge=1, le=5)]


class Special(BaseModel):
    id: UUID
    outlet_id: UUID
    menu_item_id: UUID
    item_name: str
    special_date: date
    regular_price_paise: int
    special_price_paise: int
    discount_percent: int
    portions_total: int
    portions_left: int
    headline: str | None


class SpecialInput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    menu_item_id: UUID
    special_date: date
    discount_percent: Annotated[int, Field(ge=1, le=90)]
    portions: Annotated[int, Field(ge=1, le=1000)]
    headline: Annotated[str, StringConstraints(strip_whitespace=True, max_length=120)] | None = None


class PollOption(BaseModel):
    id: UUID
    menu_item_id: UUID
    item_name: str
    vote_count: int
    percent: int  # of all votes, rounded; 0 when nobody has voted


class Poll(BaseModel):
    id: UUID
    outlet_id: UUID
    question: str
    status: Literal["open", "closed", "published"]
    closes_at: datetime
    special_date: date
    special_discount_percent: int
    total_votes: int
    options: list[PollOption]
    winner_option_id: UUID | None


class PollInput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    question: Annotated[str, StringConstraints(strip_whitespace=True, min_length=3, max_length=200)]
    menu_item_ids: Annotated[list[UUID], Field(min_length=2, max_length=6)]
    closes_at: datetime
    special_date: date
    special_discount_percent: Annotated[int, Field(ge=1, le=90)]
    special_portions: Annotated[int, Field(ge=1, le=1000)]


class Vote(BaseModel):
    model_config = ConfigDict(extra="forbid")

    option_id: UUID


class MyVote(BaseModel):
    poll_id: UUID
    option_id: UUID


class PublishWinner(BaseModel):
    model_config = ConfigDict(extra="forbid")

    # Omit to publish the dish with the most votes.
    option_id: UUID | None = None


class ReviewInput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    taste: Stars
    hygiene: Stars
    speed: Stars
    value: Stars
    comment: Annotated[str, StringConstraints(strip_whitespace=True, max_length=1000)] | None = None


class Review(BaseModel):
    """Public and anonymous: never who wrote it."""

    id: UUID
    order_id: UUID
    outlet_id: UUID
    taste: int
    hygiene: int
    speed: int
    value: int
    comment: str | None
    reply: str | None
    replied_at: datetime | None
    created_at: datetime


class ReviewReply(BaseModel):
    model_config = ConfigDict(extra="forbid")

    reply: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=1000)]


class OutletRating(BaseModel):
    outlet_id: UUID
    outlet_name: str
    review_count: int
    taste: float
    hygiene: float
    speed: float
    value: float
    overall: float


class PopularItem(BaseModel):
    menu_item_id: UUID
    item_name: str
    outlet_id: UUID
    outlet_name: str
    students: int
    # "department": at least 5 students from your department ordered it; else "campus".
    scope: Literal["department", "campus"]
