from uuid import UUID

from fastapi import APIRouter, status

from app.api.deps import CurrentPrincipal, Db
from app.modules.management.service import require_manager
from app.modules.social import service
from app.modules.social.schemas import (
    Group,
    GroupCreate,
    GroupItemSet,
    GroupJoin,
    GroupSplit,
    Party,
    PartyDecision,
    PartyRequest,
    Split,
    SplitCreate,
)

router = APIRouter(tags=["social"])

# --- Group orders ------------------------------------------------------------------------------


@router.get("/groups", response_model=list[Group])
async def my_groups(principal: CurrentPrincipal, db: Db) -> list[Group]:
    async with db.user_transaction(principal) as conn:
        return await service.my_groups(conn, principal)


@router.post("/groups", response_model=Group, status_code=status.HTTP_201_CREATED)
async def create_group(body: GroupCreate, principal: CurrentPrincipal, db: Db) -> Group:
    """Start a group order for a pickup slot; share the invite code."""
    async with db.user_transaction(principal) as conn:
        return await service.create_group(conn, principal, body.outlet_id, body.pickup_slot_id)


@router.post("/groups/join", response_model=Group)
async def join_group(body: GroupJoin, principal: CurrentPrincipal, db: Db) -> Group:
    async with db.user_transaction(principal) as conn:
        return await service.join_group(conn, principal, body.code)


@router.get("/groups/{group_id}", response_model=Group)
async def get_group(group_id: UUID, principal: CurrentPrincipal, db: Db) -> Group:
    async with db.user_transaction(principal) as conn:
        return await service.get_group(conn, principal, group_id)


@router.put("/groups/{group_id}/items", response_model=Group)
async def set_group_item(
    group_id: UUID, body: GroupItemSet, principal: CurrentPrincipal, db: Db
) -> Group:
    """Set a member's quantity (0 removes). Members edit their own; the host can edit anyone's."""
    async with db.user_transaction(principal) as conn:
        return await service.set_item(
            conn, principal, group_id, body.member_id, body.menu_item_id, body.quantity
        )


@router.put("/groups/{group_id}/split", response_model=Group)
async def set_group_split(
    group_id: UUID, body: GroupSplit, principal: CurrentPrincipal, db: Db
) -> Group:
    async with db.user_transaction(principal) as conn:
        return await service.set_split(conn, principal, group_id, body)


@router.post("/groups/{group_id}/checkout", response_model=Group)
async def lock_group(group_id: UUID, principal: CurrentPrincipal, db: Db) -> Group:
    """Host: one order for the tray (stock, slot and specials reserved); shares are fixed."""
    async with db.user_transaction(principal) as conn:
        return await service.call_and_get(conn, principal, "lock_group", group_id)


@router.post("/groups/{group_id}/pay", response_model=Group)
async def pay_share(group_id: UUID, principal: CurrentPrincipal, db: Db) -> Group:
    """Pay your share from the wallet. The last share sends the order to the kitchen."""
    async with db.user_transaction(principal) as conn:
        return await service.call_and_get(conn, principal, "pay_group_share", group_id)


@router.post("/groups/{group_id}/leave", status_code=status.HTTP_204_NO_CONTENT)
async def leave_group(group_id: UUID, principal: CurrentPrincipal, db: Db) -> None:
    """Leave before checkout (the host leaving cancels the group)."""
    async with db.user_transaction(principal) as conn:
        await conn.execute("select app.leave_group(%s)", (group_id,))


# --- Party bookings ---------------------------------------------------------------------------


@router.get("/parties", response_model=list[Party])
async def my_parties(principal: CurrentPrincipal, db: Db) -> list[Party]:
    async with db.user_transaction(principal) as conn:
        return await service.my_parties(conn, principal)


@router.post("/parties", response_model=Party, status_code=status.HTTP_201_CREATED)
async def request_party(body: PartyRequest, principal: CurrentPrincipal, db: Db) -> Party:
    """Request catering for an event (24 h to 60 days ahead), priced from the menu."""
    async with db.user_transaction(principal) as conn:
        return await service.request_party(conn, body)


@router.post("/parties/{booking_id}/pay", response_model=Party)
async def pay_party(booking_id: UUID, principal: CurrentPrincipal, db: Db) -> Party:
    async with db.user_transaction(principal) as conn:
        await service.party_action(conn, "pay_party", booking_id)
        return await service.party(conn, booking_id)


@router.post("/parties/{booking_id}/cancel", response_model=Party)
async def cancel_party(booking_id: UUID, principal: CurrentPrincipal, db: Db) -> Party:
    """Free before payment; a full refund to the wallet until 24 h before the event."""
    async with db.user_transaction(principal) as conn:
        await service.party_action(conn, "cancel_party", booking_id)
        return await service.party(conn, booking_id)


@router.get("/manage/outlets/{outlet_id}/parties", response_model=list[Party])
async def outlet_parties(outlet_id: UUID, principal: CurrentPrincipal, db: Db) -> list[Party]:
    async with db.user_transaction(principal) as conn:
        await require_manager(conn, outlet_id)
        return await service.outlet_parties(conn, outlet_id)


@router.post("/manage/parties/{booking_id}/decision", response_model=Party)
async def decide_party(
    booking_id: UUID, body: PartyDecision, principal: CurrentPrincipal, db: Db
) -> Party:
    async with db.user_transaction(principal) as conn:
        await service.party_action(conn, "decide_party", booking_id, body.accept, body.note)
        return await service.party(conn, booking_id, names=True)


@router.post("/manage/parties/{booking_id}/fulfil", response_model=Party)
async def fulfil_party(booking_id: UUID, principal: CurrentPrincipal, db: Db) -> Party:
    async with db.user_transaction(principal) as conn:
        await service.party_action(conn, "fulfil_party", booking_id)
        return await service.party(conn, booking_id, names=True)


# --- Bill splits --------------------------------------------------------------------------------


@router.get("/splits", response_model=list[Split])
async def my_splits(principal: CurrentPrincipal, db: Db) -> list[Split]:
    async with db.user_transaction(principal) as conn:
        return await service.my_splits(conn, principal)


@router.post("/splits", response_model=Split, status_code=status.HTTP_201_CREATED)
async def create_split(body: SplitCreate, principal: CurrentPrincipal, db: Db) -> Split:
    """Record a shared expense; each person (by CampusCart email) owes you their amount."""
    async with db.user_transaction(principal) as conn:
        return await service.create_split(conn, principal, body)


@router.post("/splits/{split_id}/settle", response_model=Split)
async def settle_split(split_id: UUID, principal: CurrentPrincipal, db: Db) -> Split:
    """Pay your share to the creator by wallet transfer."""
    async with db.user_transaction(principal) as conn:
        return await service.split_action(conn, principal, "settle_bill_share", split_id)


@router.post("/splits/{split_id}/cancel", response_model=Split)
async def cancel_split(split_id: UUID, principal: CurrentPrincipal, db: Db) -> Split:
    async with db.user_transaction(principal) as conn:
        return await service.split_action(conn, principal, "cancel_bill_split", split_id)
