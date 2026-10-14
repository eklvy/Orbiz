"""Postgres access.

Every transaction adopts an explicit database role so RLS applies to the API exactly as it
does to direct Supabase clients (defence in depth on top of explicit authorization):

- `user_transaction(principal)` — role `authenticated` with the caller's verified claims.
- `anon_transaction()` — role `anon`, for public catalogue reads.
- `system_transaction()` — role `service_role`, for trusted server operations (payment
  confirmation in Phase 5, jobs). Never used for work done on behalf of an end user.

Business operations live in SQL functions in the `app` schema; they signal failures with
SQLSTATE `CC<http status>` and a machine-readable reason in HINT, translated here into the
API error envelope.
"""

import json
import logging
from collections.abc import AsyncIterator
from contextlib import AbstractAsyncContextManager, asynccontextmanager
from typing import Any

import psycopg
from fastapi import Request
from psycopg import AsyncConnection
from psycopg.rows import DictRow, dict_row
from psycopg_pool import AsyncConnectionPool

from app.core.auth import Principal
from app.core.errors import ApiError, ErrorCode

logger = logging.getLogger(__name__)

Connection = AsyncConnection[DictRow]

_STATUS_TO_CODE: dict[int, ErrorCode] = {
    401: "unauthenticated",
    403: "forbidden",
    404: "not_found",
    409: "conflict",
    422: "validation_error",
    429: "rate_limited",
}
# Standard SQLSTATEs that indicate bad client input rather than a server fault.
_INPUT_ERRORS = {
    "22P02": "invalid_input",  # invalid_text_representation (e.g. malformed uuid)
    "22003": "out_of_range",  # numeric_value_out_of_range
    "23514": "constraint_violation",  # check_violation
}


def translate_db_error(exc: psycopg.Error) -> ApiError | None:
    """Map a database error to an API error, or None if it is an unexpected server fault."""
    sqlstate = exc.sqlstate or ""
    if sqlstate.startswith("CC") and sqlstate[2:].isdigit():
        status = int(sqlstate[2:])
        reason = exc.diag.message_hint or "error"
        message = exc.diag.message_primary or "Request failed"
        return ApiError(
            status, _STATUS_TO_CODE.get(status, "conflict"), message, {"reason": reason}
        )
    if sqlstate in _INPUT_ERRORS:
        return ApiError(
            422, "validation_error", "Invalid input", {"reason": _INPUT_ERRORS[sqlstate]}
        )
    return None


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
    async def _transaction(self, role: str, claims: dict[str, Any]) -> AsyncIterator[Connection]:
        try:
            async with self.pool.connection() as conn, conn.transaction():
                await conn.execute(
                    "select set_config('role', %s, true),"
                    " set_config('request.jwt.claims', %s, true)",
                    (role, json.dumps(claims)),
                )
                yield conn
        except psycopg.Error as exc:
            translated = translate_db_error(exc)
            if translated is None:
                raise
            raise translated from exc

    def user_transaction(self, principal: Principal) -> AbstractAsyncContextManager[Connection]:
        # auth.uid() / auth.jwt() read these; always use the verified subject.
        claims = {**principal.claims, "sub": str(principal.user_id), "role": "authenticated"}
        return self._transaction("authenticated", claims)

    def anon_transaction(self) -> AbstractAsyncContextManager[Connection]:
        return self._transaction("anon", {"role": "anon"})

    def system_transaction(self) -> AbstractAsyncContextManager[Connection]:
        return self._transaction("service_role", {"role": "service_role"})


def get_database(request: Request) -> Database:
    """FastAPI dependency: the app's database, or a 503 if none is configured."""
    db: Database | None = request.app.state.db
    if db is None:
        raise ApiError(503, "service_unavailable", "Database is not configured")
    return db
