"""Identity queries. Every function runs inside a user transaction, so RLS applies."""

from psycopg import sql

from app.core.auth import Principal
from app.core.db import Connection
from app.core.errors import ApiError
from app.modules.identity.schemas import Me, OutletMembership, ProfileUpdate

_PROFILE_COLUMNS = sql.SQL(
    "id, full_name, customer_type::text, roll_number, department, year_of_study, hostel_room"
)
# Must match the column-level UPDATE grant in the identity migration.
_EDITABLE_COLUMNS = frozenset({"full_name", "department", "year_of_study", "hostel_room"})


async def get_me(conn: Connection, principal: Principal) -> Me:
    cur = await conn.execute(
        sql.SQL("select {} from public.profiles where id = %s").format(_PROFILE_COLUMNS),
        (principal.user_id,),
    )
    profile = await cur.fetchone()
    if profile is None:
        raise ApiError(404, "not_found", "Profile not found")

    cur = await conn.execute(
        "select role::text from public.user_roles where user_id = %s order by role",
        (principal.user_id,),
    )
    platform_roles = [row["role"] for row in await cur.fetchall()]

    cur = await conn.execute(
        """
        select s.outlet_id, o.slug as outlet_slug, o.name as outlet_name, s.role::text as role
        from public.outlet_staff s
        join public.outlets o on o.id = s.outlet_id
        where s.user_id = %s
        order by o.name
        """,
        (principal.user_id,),
    )
    memberships = [OutletMembership.model_validate(row) for row in await cur.fetchall()]

    return Me.model_validate(
        {
            **profile,
            "email": principal.email,
            "platform_roles": platform_roles,
            "outlet_roles": memberships,
        }
    )


async def update_profile(conn: Connection, principal: Principal, update: ProfileUpdate) -> None:
    changes = update.model_dump(exclude_unset=True)
    if not changes:
        return
    if "full_name" in changes and changes["full_name"] is None:
        raise ApiError(422, "validation_error", "full_name cannot be null")
    if not changes.keys() <= _EDITABLE_COLUMNS:  # defensive; the schema already forbids extras
        raise ApiError(422, "validation_error", "Field is not editable")

    assignments = sql.SQL(", ").join(
        sql.SQL("{} = {}").format(sql.Identifier(column), sql.Placeholder(column))
        for column in changes
    )
    cur = await conn.execute(
        sql.SQL("update public.profiles set {} where id = %(user_id)s returning id").format(
            assignments
        ),
        {**changes, "user_id": principal.user_id},
    )
    if await cur.fetchone() is None:
        raise ApiError(404, "not_found", "Profile not found")
