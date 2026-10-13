"""Supabase access-token verification.

Clients sign in with Supabase Auth and send `Authorization: Bearer <access_token>`. The API
verifies the signature (JWKS for asymmetric keys; the legacy shared secret for HS256), the
issuer, audience and expiry, and that the token belongs to a signed-in user. Roles are NOT
read from the token; they are loaded from the database under RLS.
"""

import logging
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any
from uuid import UUID

import jwt
from fastapi import Request
from starlette.concurrency import run_in_threadpool

from app.core.config import Settings
from app.core.errors import ApiError

logger = logging.getLogger(__name__)

ASYMMETRIC_ALGORITHMS = frozenset({"ES256", "RS256"})
SigningKeyResolver = Callable[[str], Any]


@dataclass(frozen=True)
class Principal:
    """An authenticated end user. `claims` are the verified JWT claims."""

    user_id: UUID
    claims: dict[str, Any]

    @property
    def email(self) -> str | None:
        email = self.claims.get("email")
        return email if isinstance(email, str) else None


class InvalidTokenError(Exception):
    pass


class TokenVerifier:
    def __init__(
        self,
        *,
        issuer: str | None,
        audience: str,
        hs256_secret: str | None = None,
        signing_key_resolver: SigningKeyResolver | None = None,
    ) -> None:
        self._issuer = issuer
        self._audience = audience
        self._hs256_secret = hs256_secret
        self._resolve_signing_key = signing_key_resolver

    @classmethod
    def from_settings(cls, settings: Settings) -> "TokenVerifier":
        resolver: SigningKeyResolver | None = None
        if settings.jwt_issuer:
            jwks = jwt.PyJWKClient(
                f"{settings.jwt_issuer}/.well-known/jwks.json", cache_keys=True, lifespan=300
            )
            resolver = lambda token: jwks.get_signing_key_from_jwt(token).key  # noqa: E731
        secret = settings.supabase_jwt_secret
        return cls(
            issuer=settings.jwt_issuer,
            audience=settings.jwt_audience,
            hs256_secret=secret.get_secret_value() if secret else None,
            signing_key_resolver=resolver,
        )

    def verify(self, token: str) -> dict[str, Any]:
        if self._issuer is None:
            raise InvalidTokenError("authentication is not configured")
        try:
            algorithm = jwt.get_unverified_header(token).get("alg")
            key: Any
            if algorithm in ASYMMETRIC_ALGORITHMS and self._resolve_signing_key is not None:
                key = self._resolve_signing_key(token)
            elif algorithm == "HS256" and self._hs256_secret:
                key = self._hs256_secret
            else:
                raise InvalidTokenError(f"unsupported signing algorithm: {algorithm!r}")
            claims: dict[str, Any] = jwt.decode(
                token,
                key,
                algorithms=[algorithm],
                audience=self._audience,
                issuer=self._issuer,
                options={"require": ["exp", "iat", "sub", "aud", "iss"]},
            )
        except (jwt.PyJWTError, ValueError) as exc:
            raise InvalidTokenError(str(exc)) from exc

        # Anon/service keys are JWTs too; only signed-in user sessions are principals.
        if claims.get("role") != "authenticated":
            raise InvalidTokenError("token is not a user session")
        return claims


def _bearer_token(request: Request) -> str:
    header = request.headers.get("Authorization", "")
    scheme, _, token = header.partition(" ")
    if scheme.lower() != "bearer" or not token.strip():
        raise ApiError(401, "unauthenticated", "Missing bearer token")
    return token.strip()


async def current_principal(request: Request) -> Principal:
    """FastAPI dependency: the verified caller, or a 401 error envelope."""
    token = _bearer_token(request)
    verifier: TokenVerifier = request.app.state.token_verifier
    try:
        # JWKS lookups may perform (cached) blocking HTTP; keep them off the event loop.
        claims = await run_in_threadpool(verifier.verify, token)
        user_id = UUID(str(claims["sub"]))
    except (InvalidTokenError, ValueError) as exc:
        logger.info("token_rejected", extra={"reason": str(exc)[:200]})
        raise ApiError(401, "unauthenticated", "Invalid or expired access token") from exc
    return Principal(user_id=user_id, claims=claims)
