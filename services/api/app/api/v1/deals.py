from uuid import UUID

from fastapi import APIRouter, status

from app.api.deps import CurrentPrincipal, Db
from app.api.v1.orders import IdempotencyKey
from app.modules.deals import service
from app.modules.orders.schemas import OrderDetail

router = APIRouter(prefix="/deals", tags=["deals"])


@router.post("/{deal_id}/claim", response_model=OrderDetail, status_code=status.HTTP_201_CREATED)
async def claim_deal(
    deal_id: UUID, idempotency_key: IdempotencyKey, principal: CurrentPrincipal, db: Db
) -> OrderDetail:
    """Buy a surplus deal: creates an unpaid order that holds the deal until it is paid or the
    hold expires. Once paid, the order is ready for pickup at the counter straight away."""
    async with db.user_transaction(principal) as conn:
        return await service.claim_deal(conn, deal_id, idempotency_key)
