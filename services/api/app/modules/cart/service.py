"""Server-side cart (same cart on every device). Runs under the user's RLS session."""

from uuid import UUID

from app.core.auth import Principal
from app.core.db import Connection
from app.core.errors import ApiError
from app.modules.cart.schemas import MAX_CART_LINES, Cart, CartItem


async def get_cart(conn: Connection, principal: Principal) -> Cart:
    cur = await conn.execute(
        "select outlet_id from public.carts where user_id = %s", (principal.user_id,)
    )
    cart = await cur.fetchone()
    if cart is None:
        return Cart(outlet_id=None, items=[], subtotal_paise=0, item_count=0)

    cur = await conn.execute(
        """
        select ci.menu_item_id, m.name, m.price_paise as unit_price_paise, ci.quantity,
               m.price_paise * ci.quantity as line_total_paise,
               m.stock_status::text as stock_status,
               (m.is_active and m.stock_status <> 'sold_out') as orderable
        from public.cart_items ci
        join public.menu_items m on m.id = ci.menu_item_id
        where ci.user_id = %s
        order by ci.added_at, m.name
        """,
        (principal.user_id,),
    )
    items = [CartItem.model_validate(row) for row in await cur.fetchall()]
    return Cart(
        outlet_id=cart["outlet_id"],
        items=items,
        subtotal_paise=sum(i.line_total_paise for i in items),
        item_count=sum(i.quantity for i in items),
    )


async def set_item(
    conn: Connection, principal: Principal, menu_item_id: UUID, quantity: int, *, replace_cart: bool
) -> None:
    # RLS limits this to items the user may see (active items of active outlets).
    cur = await conn.execute(
        "select outlet_id from public.menu_items where id = %s and is_active", (menu_item_id,)
    )
    item = await cur.fetchone()
    if item is None:
        raise ApiError(404, "not_found", "Menu item not found")
    outlet_id = item["outlet_id"]

    # Serialise this user's cart writes: two quick "Add" taps must not both try to create the
    # cart (or both replace it). Released automatically at commit/rollback.
    await conn.execute(
        "select pg_advisory_xact_lock(hashtextextended('cart:' || %s::text, 0))",
        (principal.user_id,),
    )
    cur = await conn.execute(
        "select outlet_id from public.carts where user_id = %s for update", (principal.user_id,)
    )
    cart = await cur.fetchone()
    if cart is not None and cart["outlet_id"] != outlet_id:
        if not replace_cart:
            raise ApiError(
                409,
                "conflict",
                "Your cart has items from another outlet",
                {"reason": "cart_outlet_mismatch", "cart_outlet_id": str(cart["outlet_id"])},
            )
        await conn.execute("delete from public.carts where user_id = %s", (principal.user_id,))
        cart = None
    if cart is None:
        await conn.execute(
            "insert into public.carts (user_id, outlet_id) values (%s, %s)",
            (principal.user_id, outlet_id),
        )
    else:
        await conn.execute(
            "update public.carts set updated_at = now() where user_id = %s", (principal.user_id,)
        )

    cur = await conn.execute(
        "select count(*) as lines, bool_or(menu_item_id = %s) as present"
        " from public.cart_items where user_id = %s",
        (menu_item_id, principal.user_id),
    )
    counts = await cur.fetchone()
    if counts is not None and not counts["present"] and counts["lines"] >= MAX_CART_LINES:
        raise ApiError(
            422, "validation_error", f"A cart can hold at most {MAX_CART_LINES} different items"
        )

    await conn.execute(
        """
        insert into public.cart_items (user_id, outlet_id, menu_item_id, quantity)
        values (%s, %s, %s, %s)
        on conflict (user_id, menu_item_id) do update set quantity = excluded.quantity
        """,
        (principal.user_id, outlet_id, menu_item_id, quantity),
    )


async def remove_item(conn: Connection, principal: Principal, menu_item_id: UUID) -> None:
    await conn.execute(
        "delete from public.cart_items where user_id = %s and menu_item_id = %s",
        (principal.user_id, menu_item_id),
    )
    # An empty cart is no cart.
    await conn.execute(
        "delete from public.carts c where c.user_id = %s"
        " and not exists (select 1 from public.cart_items i where i.user_id = c.user_id)",
        (principal.user_id,),
    )


async def clear(conn: Connection, principal: Principal) -> None:
    await conn.execute("delete from public.carts where user_id = %s", (principal.user_id,))
