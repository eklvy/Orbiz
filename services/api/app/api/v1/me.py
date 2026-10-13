from typing import Annotated

from fastapi import APIRouter, Depends

from app.core.auth import Principal, current_principal
from app.core.db import Database, get_database
from app.modules.identity import service
from app.modules.identity.schemas import Me, ProfileUpdate

router = APIRouter(prefix="/me", tags=["identity"])

CurrentPrincipal = Annotated[Principal, Depends(current_principal)]
Db = Annotated[Database, Depends(get_database)]


@router.get("", response_model=Me)
async def read_me(principal: CurrentPrincipal, db: Db) -> Me:
    """The caller's profile, platform roles and outlet memberships (all read under RLS)."""
    async with db.user_transaction(principal) as conn:
        return await service.get_me(conn, principal)


@router.patch("", response_model=Me)
async def update_me(update: ProfileUpdate, principal: CurrentPrincipal, db: Db) -> Me:
    async with db.user_transaction(principal) as conn:
        await service.update_profile(conn, principal, update)
        return await service.get_me(conn, principal)
