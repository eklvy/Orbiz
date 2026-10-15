"""Environment-driven settings, validated at startup.

Only settings needed by implemented phases are declared here. Later phases add their own
(model paths) together with the code that uses them, so a missing secret fails fast instead of
being silently ignored. Optional integrations (Razorpay, Expo push) report themselves as
unavailable rather than pretending to work.
"""

from enum import StrEnum
from functools import lru_cache
from typing import Self

from fastapi import Request
from pydantic import Field, SecretStr, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Environment(StrEnum):
    LOCAL = "local"
    TEST = "test"
    STAGING = "staging"
    PRODUCTION = "production"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_prefix="CAMPUSCART_",
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    environment: Environment = Environment.LOCAL
    log_level: str = "INFO"
    cors_allowed_origins: list[str] = Field(
        default_factory=lambda: [
            "http://localhost:3000",
            "http://localhost:3001",
            "http://localhost:3002",
            "http://localhost:8081",  # Expo web dev server; native apps need no CORS
        ]
    )

    # Supabase project base URL, e.g. http://127.0.0.1:54321. Used to derive the JWT issuer
    # ({url}/auth/v1) and the JWKS endpoint for asymmetric token verification.
    supabase_url: str | None = None
    # Legacy symmetric JWT secret. Only needed if the project still signs with HS256.
    supabase_jwt_secret: SecretStr | None = None
    jwt_audience: str = "authenticated"

    # Direct Postgres connection string (server-side only). The connecting role must be able
    # to `SET ROLE authenticated` so user requests run under RLS (docs/ARCHITECTURE.md §4).
    database_url: SecretStr | None = None
    db_pool_min_size: int = Field(default=1, ge=0)
    db_pool_max_size: int = Field(default=10, ge=1)

    # Razorpay (Phase 5). TEST-mode keys in development. Payments are disabled (503) unless the
    # key id and secret are both set; webhooks are rejected unless the webhook secret is set.
    razorpay_key_id: str | None = None
    razorpay_key_secret: SecretStr | None = None
    razorpay_webhook_secret: SecretStr | None = None
    razorpay_api_base: str = "https://api.razorpay.com/v1"

    # Expo push (Phase 5). Optional: without it notifications are stored in-app but not pushed.
    expo_access_token: SecretStr | None = None
    expo_push_url: str = "https://exp.host/--/api/v2/push/send"

    @model_validator(mode="after")
    def _require_deployed_settings(self) -> Self:
        if self.environment in (Environment.STAGING, Environment.PRODUCTION):
            missing = [
                name for name in ("supabase_url", "database_url") if getattr(self, name) is None
            ]
            if missing:
                raise ValueError(
                    f"Missing required settings for {self.environment}: "
                    + ", ".join(f"CAMPUSCART_{m.upper()}" for m in missing)
                )
        return self

    @property
    def payments_enabled(self) -> bool:
        return bool(self.razorpay_key_id and self.razorpay_key_secret)

    @property
    def docs_enabled(self) -> bool:
        return self.environment is not Environment.PRODUCTION

    @property
    def jwt_issuer(self) -> str | None:
        return f"{self.supabase_url.rstrip('/')}/auth/v1" if self.supabase_url else None


@lru_cache
def get_settings() -> Settings:
    return Settings()


def app_settings(request: Request) -> Settings:
    """FastAPI dependency: the settings the running app was created with."""
    settings: Settings = request.app.state.settings
    return settings
