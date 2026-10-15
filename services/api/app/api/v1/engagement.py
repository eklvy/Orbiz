from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Query, status

from app.api.deps import CurrentPrincipal, Db
from app.modules.engagement import service
from app.modules.engagement.schemas import (
    MyVote,
    OutletRating,
    Poll,
    PollInput,
    PopularItem,
    PublishWinner,
    Review,
    ReviewInput,
    ReviewReply,
    Special,
    SpecialInput,
    Vote,
)
from app.modules.management.service import require_manager
from app.modules.orders.service import get_order

router = APIRouter(tags=["engagement"])


# --- Public ----------------------------------------------------------------------------------


@router.get("/outlets/{outlet_id}/specials", response_model=list[Special])
async def list_specials(outlet_id: UUID, db: Db) -> list[Special]:
    """Today's and upcoming specials with server-computed prices and portions left."""
    async with db.anon_transaction() as conn:
        return await service.list_specials(conn, outlet_id)


@router.get("/outlets/{outlet_id}/polls", response_model=list[Poll])
async def list_polls(outlet_id: UUID, db: Db) -> list[Poll]:
    """Open polls and those decided in the last week, with live vote counts."""
    async with db.anon_transaction() as conn:
        return await service.list_polls(conn, outlet_id)


@router.get("/outlets/{outlet_id}/reviews", response_model=list[Review])
async def list_reviews(
    outlet_id: UUID,
    db: Db,
    needs_reply: bool = False,
    limit: Annotated[int, Query(ge=1, le=100)] = 30,
) -> list[Review]:
    """Anonymous reviews, newest first (needs_reply=true: without a reply yet)."""
    async with db.anon_transaction() as conn:
        return await service.list_reviews(conn, outlet_id, needs_reply=needs_reply, limit=limit)


@router.get("/ratings", response_model=list[OutletRating])
async def ratings(db: Db) -> list[OutletRating]:
    """Campus leaderboard: average ratings per outlet."""
    async with db.anon_transaction() as conn:
        return await service.ratings(conn)


# --- Students ----------------------------------------------------------------------------------


@router.get("/outlets/{outlet_id}/polls/my-votes", response_model=list[MyVote])
async def my_votes(outlet_id: UUID, principal: CurrentPrincipal, db: Db) -> list[MyVote]:
    async with db.user_transaction(principal) as conn:
        return await service.my_votes(conn, outlet_id)


@router.post("/polls/{poll_id}/vote", response_model=Poll)
async def vote(poll_id: UUID, body: Vote, principal: CurrentPrincipal, db: Db) -> Poll:
    """One vote per student per poll."""
    async with db.user_transaction(principal) as conn:
        return await service.vote(conn, poll_id, body.option_id)


@router.post(
    "/orders/{order_id}/review", response_model=Review, status_code=status.HTTP_201_CREATED
)
async def submit_review(
    order_id: UUID, body: ReviewInput, principal: CurrentPrincipal, db: Db
) -> Review:
    """Rate a collected order (within 7 days): taste, hygiene, speed, value. Earns 15 points."""
    async with db.user_transaction(principal) as conn:
        return await service.submit_review(conn, order_id, body)


@router.get("/orders/{order_id}/review", response_model=Review | None)
async def order_review(order_id: UUID, principal: CurrentPrincipal, db: Db) -> Review | None:
    async with db.user_transaction(principal) as conn:
        await get_order(conn, order_id)  # 404 unless the caller may see the order
        return await service.order_review(conn, order_id)


@router.get("/popular", response_model=list[PopularItem])
async def popular(
    principal: CurrentPrincipal, db: Db, limit: Annotated[int, Query(ge=1, le=20)] = 5
) -> list[PopularItem]:
    """Popular with your classmates: counts only, shown once at least 5 students ordered an item."""
    async with db.user_transaction(principal) as conn:
        return await service.popular(conn, limit)


# --- Staff and managers -------------------------------------------------------------------------


@router.post("/staff/reviews/{review_id}/reply", response_model=Review)
async def reply(review_id: UUID, body: ReviewReply, principal: CurrentPrincipal, db: Db) -> Review:
    """Reply as the outlet (any of its staff). The student is notified."""
    async with db.user_transaction(principal) as conn:
        return await service.reply(conn, review_id, body.reply)


@router.get("/manage/outlets/{outlet_id}/specials", response_model=list[Special])
async def manager_specials(outlet_id: UUID, principal: CurrentPrincipal, db: Db) -> list[Special]:
    async with db.user_transaction(principal) as conn:
        await require_manager(conn, outlet_id)
        return await service.list_specials(conn, outlet_id)


@router.put("/manage/outlets/{outlet_id}/specials", response_model=list[Special])
async def save_special(
    outlet_id: UUID, body: SpecialInput, principal: CurrentPrincipal, db: Db
) -> list[Special]:
    """Create or change a dish's special for a date (a new special today notifies customers)."""
    async with db.user_transaction(principal) as conn:
        return await service.save_special(conn, outlet_id, body)


@router.delete("/manage/specials/{special_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_special(special_id: UUID, principal: CurrentPrincipal, db: Db) -> None:
    async with db.user_transaction(principal) as conn:
        await service.delete_special(conn, special_id)


@router.post(
    "/manage/outlets/{outlet_id}/polls", response_model=Poll, status_code=status.HTTP_201_CREATED
)
async def create_poll(
    outlet_id: UUID, body: PollInput, principal: CurrentPrincipal, db: Db
) -> Poll:
    async with db.user_transaction(principal) as conn:
        return await service.create_poll(conn, outlet_id, body)


@router.post("/manage/polls/{poll_id}/close", response_model=Poll)
async def close_poll(poll_id: UUID, principal: CurrentPrincipal, db: Db) -> Poll:
    async with db.user_transaction(principal) as conn:
        return await service.close_poll(conn, poll_id)


@router.post("/manage/polls/{poll_id}/publish", response_model=Poll)
async def publish_winner(
    poll_id: UUID, body: PublishWinner, principal: CurrentPrincipal, db: Db
) -> Poll:
    """Publish the winner as the poll's special (the manager decides; votes are a guide)."""
    async with db.user_transaction(principal) as conn:
        return await service.publish_winner(conn, poll_id, body.option_id)
