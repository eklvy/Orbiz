"""Specials, polls, reviews, the outlet leaderboard and "popular with your classmates".
Rules live in app.* SQL functions; this module validates input and shapes responses."""

from typing import Any
from uuid import UUID

from app.core.db import Connection
from app.core.errors import ApiError
from app.modules.engagement.schemas import (
    MyVote,
    OutletRating,
    Poll,
    PollInput,
    PollOption,
    PopularItem,
    Review,
    ReviewInput,
    Special,
    SpecialInput,
)

_REVIEW_COLUMNS = (
    "id, order_id, outlet_id, taste, hygiene, speed, value, comment, reply, replied_at, created_at"
)


async def _visible_outlet(conn: Connection, outlet_id: UUID) -> None:
    cur = await conn.execute("select 1 from public.outlets where id = %s", (outlet_id,))
    if await cur.fetchone() is None:
        raise ApiError(404, "not_found", "Outlet not found")


async def list_specials(
    conn: Connection, outlet_id: UUID, *, include_past: bool = False
) -> list[Special]:
    await _visible_outlet(conn, outlet_id)
    cur = await conn.execute(
        """
        select s.id, s.outlet_id, s.menu_item_id, m.name as item_name, s.special_date,
               m.price_paise as regular_price_paise,
               greatest(1, (m.price_paise * (100 - s.discount_percent) + 50) / 100)
                 as special_price_paise,
               s.discount_percent, s.portions_total, s.portions_left, s.headline
        from public.daily_specials s
        join public.menu_items m on m.id = s.menu_item_id
        join public.outlets o on o.id = s.outlet_id
        where s.outlet_id = %s
          and (%s or s.special_date >= (now() at time zone o.timezone)::date)
        order by s.special_date, m.name
        limit 100
        """,
        (outlet_id, include_past),
    )
    return [Special.model_validate(r) for r in await cur.fetchall()]


async def save_special(conn: Connection, outlet_id: UUID, body: SpecialInput) -> list[Special]:
    await conn.execute(
        "select app.save_special(%s, %s, %s, %s, %s, %s)",
        (
            outlet_id,
            body.menu_item_id,
            body.special_date,
            body.discount_percent,
            body.portions,
            body.headline,
        ),
    )
    return await list_specials(conn, outlet_id)


async def delete_special(conn: Connection, special_id: UUID) -> None:
    await conn.execute("select app.delete_special(%s)", (special_id,))


async def _polls(
    conn: Connection, *, poll_id: UUID | None = None, outlet_id: UUID | None = None
) -> list[Poll]:
    cur = await conn.execute(
        """
        select id, outlet_id, question, status::text as status, closes_at, special_date,
               special_discount_percent, winner_option_id
        from public.polls
        where (%(poll)s::uuid is null or id = %(poll)s)
          and (%(outlet)s::uuid is null or (outlet_id = %(outlet)s
               and (status = 'open' or created_at > now() - interval '7 days')))
        order by created_at desc limit 50
        """,
        {"poll": poll_id, "outlet": outlet_id},
    )
    polls = await cur.fetchall()
    cur = await conn.execute(
        "select po.id, po.poll_id, po.menu_item_id, m.name as item_name, po.vote_count"
        " from public.poll_options po join public.menu_items m on m.id = po.menu_item_id"
        " where po.poll_id = any(%s) order by po.sort_order",
        ([p["id"] for p in polls],),
    )
    options: dict[UUID, list[dict[str, Any]]] = {p["id"]: [] for p in polls}
    for row in await cur.fetchall():
        options[row["poll_id"]].append(row)
    result = []
    for poll in polls:
        total = sum(o["vote_count"] for o in options[poll["id"]])
        result.append(
            Poll.model_validate(
                {
                    **poll,
                    "total_votes": total,
                    "options": [
                        PollOption.model_validate(
                            {**o, "percent": round(o["vote_count"] * 100 / total) if total else 0}
                        )
                        for o in options[poll["id"]]
                    ],
                }
            )
        )
    return result


async def list_polls(conn: Connection, outlet_id: UUID) -> list[Poll]:
    await _visible_outlet(conn, outlet_id)
    return await _polls(conn, outlet_id=outlet_id)


async def get_poll(conn: Connection, poll_id: UUID) -> Poll:
    polls = await _polls(conn, poll_id=poll_id)
    if not polls:
        raise ApiError(404, "not_found", "Poll not found")
    return polls[0]


async def my_votes(conn: Connection, outlet_id: UUID) -> list[MyVote]:
    cur = await conn.execute(
        "select v.poll_id, v.option_id from public.poll_votes v"
        " join public.polls p on p.id = v.poll_id where p.outlet_id = %s",
        (outlet_id,),
    )
    return [MyVote.model_validate(r) for r in await cur.fetchall()]


async def create_poll(conn: Connection, outlet_id: UUID, body: PollInput) -> Poll:
    cur = await conn.execute(
        "select app.create_poll(%s, %s, %s, %s, %s, %s, %s) as id",
        (
            outlet_id,
            body.question,
            [str(i) for i in body.menu_item_ids],
            body.closes_at,
            body.special_date,
            body.special_discount_percent,
            body.special_portions,
        ),
    )
    row = await cur.fetchone()
    assert row is not None  # noqa: S101
    return await get_poll(conn, row["id"])


async def vote(conn: Connection, poll_id: UUID, option_id: UUID) -> Poll:
    await conn.execute("select app.vote(%s, %s)", (poll_id, option_id))
    return await get_poll(conn, poll_id)


async def close_poll(conn: Connection, poll_id: UUID) -> Poll:
    await conn.execute("select app.close_poll(%s)", (poll_id,))
    return await get_poll(conn, poll_id)


async def publish_winner(conn: Connection, poll_id: UUID, option_id: UUID | None) -> Poll:
    await conn.execute("select app.publish_poll_winner(%s, %s)", (poll_id, option_id))
    return await get_poll(conn, poll_id)


async def submit_review(conn: Connection, order_id: UUID, body: ReviewInput) -> Review:
    cur = await conn.execute(
        "select app.submit_review(%s, %s, %s, %s, %s, %s) as id",
        (order_id, body.taste, body.hygiene, body.speed, body.value, body.comment),
    )
    row = await cur.fetchone()
    assert row is not None  # noqa: S101
    return await get_review(conn, row["id"])


async def get_review(conn: Connection, review_id: UUID) -> Review:
    cur = await conn.execute(
        f"select {_REVIEW_COLUMNS} from public.reviews where id = %s",  # noqa: S608 — fixed columns
        (review_id,),
    )
    row = await cur.fetchone()
    if row is None:
        raise ApiError(404, "not_found", "Review not found")
    return Review.model_validate(row)


async def order_review(conn: Connection, order_id: UUID) -> Review | None:
    cur = await conn.execute(
        f"select {_REVIEW_COLUMNS} from public.reviews where order_id = %s",  # noqa: S608
        (order_id,),
    )
    row = await cur.fetchone()
    return Review.model_validate(row) if row else None


async def list_reviews(
    conn: Connection, outlet_id: UUID, *, needs_reply: bool, limit: int
) -> list[Review]:
    await _visible_outlet(conn, outlet_id)
    cur = await conn.execute(
        f"select {_REVIEW_COLUMNS} from public.reviews"  # noqa: S608 — fixed columns/filter
        " where outlet_id = %s and (not %s or reply is null)"
        " order by created_at desc limit %s",
        (outlet_id, needs_reply, limit),
    )
    return [Review.model_validate(r) for r in await cur.fetchall()]


async def reply(conn: Connection, review_id: UUID, text: str) -> Review:
    await conn.execute("select app.reply_to_review(%s, %s)", (review_id, text))
    return await get_review(conn, review_id)


async def ratings(conn: Connection) -> list[OutletRating]:
    cur = await conn.execute(
        "select r.*, o.name as outlet_name from app.outlet_ratings() r"
        " join public.outlets o on o.id = r.outlet_id order by r.overall desc, r.review_count desc"
    )
    return [OutletRating.model_validate(r) for r in await cur.fetchall()]


async def popular(conn: Connection, limit: int) -> list[PopularItem]:
    cur = await conn.execute("select * from app.popular_items(%s)", (limit,))
    return [PopularItem.model_validate(r) for r in await cur.fetchall()]
