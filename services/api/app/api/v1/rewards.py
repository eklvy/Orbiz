from uuid import UUID

from fastapi import APIRouter, status

from app.api.deps import CurrentPrincipal, Db
from app.modules.orders import service as orders
from app.modules.orders.schemas import OrderDetail
from app.modules.rewards import service
from app.modules.rewards.schemas import Budget, BudgetUpdate, Loyalty, Voucher, VoucherApply

router = APIRouter(tags=["rewards"])


@router.get("/loyalty", response_model=Loyalty)
async def get_loyalty(principal: CurrentPrincipal, db: Db) -> Loyalty:
    """Points, tier, recent activity, vouchers, and the earning rules (D-15)."""
    async with db.user_transaction(principal) as conn:
        return await service.loyalty(conn, principal)


@router.post("/loyalty/vouchers", response_model=Voucher, status_code=status.HTTP_201_CREATED)
async def redeem_voucher(principal: CurrentPrincipal, db: Db) -> Voucher:
    """Spend 100 points on a ₹10 voucher (valid 90 days)."""
    async with db.user_transaction(principal) as conn:
        return await service.redeem(conn, principal)


@router.post("/orders/{order_id}/voucher", response_model=OrderDetail)
async def apply_voucher(
    order_id: UUID, body: VoucherApply, principal: CurrentPrincipal, db: Db
) -> OrderDetail:
    """Apply one of your vouchers to your unpaid order; the server lowers the total."""
    async with db.user_transaction(principal) as conn:
        await service.apply_voucher(conn, order_id, body.code)
        return await orders.get_order(conn, order_id)


@router.get("/budget", response_model=Budget)
async def get_budget(principal: CurrentPrincipal, db: Db) -> Budget:
    async with db.user_transaction(principal) as conn:
        return await service.budget(conn, principal)


@router.put("/budget", response_model=Budget)
async def set_budget(body: BudgetUpdate, principal: CurrentPrincipal, db: Db) -> Budget:
    async with db.user_transaction(principal) as conn:
        return await service.set_budget(conn, principal, body)


@router.delete("/budget", status_code=status.HTTP_204_NO_CONTENT)
async def clear_budget(principal: CurrentPrincipal, db: Db) -> None:
    async with db.user_transaction(principal) as conn:
        await service.clear_budget(conn)
