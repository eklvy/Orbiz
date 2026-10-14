from uuid import UUID

from fastapi import APIRouter

from app.api.deps import CurrentPrincipal, Db
from app.modules.cart import service
from app.modules.cart.schemas import Cart, CartItemSet

router = APIRouter(prefix="/cart", tags=["cart"])


@router.get("", response_model=Cart)
async def get_cart(principal: CurrentPrincipal, db: Db) -> Cart:
    async with db.user_transaction(principal) as conn:
        return await service.get_cart(conn, principal)


@router.put("/items/{menu_item_id}", response_model=Cart)
async def set_cart_item(
    menu_item_id: UUID, body: CartItemSet, principal: CurrentPrincipal, db: Db
) -> Cart:
    async with db.user_transaction(principal) as conn:
        await service.set_item(
            conn, principal, menu_item_id, body.quantity, replace_cart=body.replace_cart
        )
        return await service.get_cart(conn, principal)


@router.delete("/items/{menu_item_id}", response_model=Cart)
async def remove_cart_item(menu_item_id: UUID, principal: CurrentPrincipal, db: Db) -> Cart:
    async with db.user_transaction(principal) as conn:
        await service.remove_item(conn, principal, menu_item_id)
        return await service.get_cart(conn, principal)


@router.delete("", response_model=Cart)
async def clear_cart(principal: CurrentPrincipal, db: Db) -> Cart:
    async with db.user_transaction(principal) as conn:
        await service.clear(conn, principal)
        return await service.get_cart(conn, principal)
