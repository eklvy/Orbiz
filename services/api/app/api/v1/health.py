from typing import Literal

from fastapi import APIRouter, Depends
from pydantic import BaseModel

from app import __version__
from app.core.config import Environment, Settings, app_settings

router = APIRouter(tags=["health"])


class HealthResponse(BaseModel):
    status: Literal["ok"]
    version: str
    environment: Environment


@router.get("/health", response_model=HealthResponse)
def health(settings: Settings = Depends(app_settings)) -> HealthResponse:  # noqa: B008
    """Liveness only. Dependency checks (database, Realtime) are added with those integrations."""
    return HealthResponse(status="ok", version=__version__, environment=settings.environment)
