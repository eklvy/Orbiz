"""Environment-driven settings, validated at startup.

Only settings needed by the current phase are declared here. Later phases add their own
(Supabase, Razorpay, Expo push, model paths) together with the code that uses them, so a
missing secret fails fast instead of being silently ignored.
"""

from enum import StrEnum
from functools import lru_cache

from fastapi import Request
from pydantic import Field
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
        ]
    )

    @property
    def docs_enabled(self) -> bool:
        return self.environment is not Environment.PRODUCTION


@lru_cache
def get_settings() -> Settings:
    return Settings()


def app_settings(request: Request) -> Settings:
    """FastAPI dependency: the settings the running app was created with."""
    settings: Settings = request.app.state.settings
    return settings
