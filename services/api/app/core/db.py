"""Postgres access.

User-scoped work runs in `user_transaction`, which makes the database session adopt the
caller's identity (`role = authenticated`, `request.jwt.claims` = verified claims) for the
duration of the transaction. RLS therefore applies to the API exactly as it does to direct
Supabase clients — defence in depth on top of explicit service-level checks.
"""

import json
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any

from fastapi import Request
from psycopg import AsyncConnection
from psycopg.rows import DictRow, dict_row
from psycopg_pool import AsyncConnectionPool

from app.core.auth import Principal
from app.core.errors import ApiError

Connection = AsyncConnection[DictRow]


class Database:
    def __init__(self, dsn: str, *, min_size: int, max_size: int) -> None:
        self.pool: AsyncConnectionPool[Connection] = AsyncConnectionPool(
            dsn,
            min_size=min_size,
            max_size=max_size,
            open=False,
            # autocommit so conn.transaction() opens a real (not nested) transaction;
            # no prepared statements so transaction-mode poolers (Supavisor) work.
            kwargs={"autocommit": True, "prepare_threshold": None, "row_factory": dict_row},
            connection_class=AsyncConnection[DictRow],
        )

    async def open(self) -> None:
        # Don't block startup on the database; readiness reports its state.
        await self.pool.open(wait=False)

    async def close(self) -> None:
        await self.pool.close()

    async def ping(self) -> bool:
        try:
            async with self.pool.connection(timeout=2) as conn:
                await conn.execute("select 1")
        except Exception:
            return False
        return True

    @asynccontextmanager
    async def user_transaction(self, principal: Principal) -> AsyncIterator[Connection]:
        async with self.pool.connection() as conn, conn.transaction():
            await conn.execute(
                "select set_config('role', 'authenticated', true),"
                " set_config('request.jwt.claims', %s, true)",
                (json.dumps(_claims_for_db(principal)),),
            )
            yield conn


def _claims_for_db(principal: Principal) -> dict[str, Any]:
    # auth.uid() / auth.jwt() read these; always use the verified subject.
    return {**principal.claims, "sub": str(principal.user_id), "role": "authenticated"}


def get_database(request: Request) -> Database:
    """FastAPI dependency: the app's database, or a 503 if none is configured."""
    db: Database | None = request.app.state.db
    if db is None:
        raise ApiError(503, "service_unavailable", "Database is not configured")
    return db
