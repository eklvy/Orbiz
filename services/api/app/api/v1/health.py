from typing import Annotated, Literal

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel

from app import __version__
from app.core.config import Environment, Settings, app_settings
from app.core.db import Database
from app.core.errors import ApiError

router = APIRouter(prefix="/health", tags=["health"])


class HealthResponse(BaseModel):
    status: Literal["ok"]
    version: str
    environment: Environment


class ReadinessResponse(BaseModel):
    status: Literal["ready"]
    database: Literal["ok"]


@router.get("", response_model=HealthResponse)
def health(settings: Annotated[Settings, Depends(app_settings)]) -> HealthResponse:
    """Liveness: the process is up. Does not touch dependencies."""
    return HealthResponse(status="ok", version=__version__, environment=settings.environment)


@router.get("/ready", response_model=ReadinessResponse)
async def ready(request: Request) -> ReadinessResponse:
    """Readiness: required dependencies are reachable."""
    db: Database | None = request.app.state.db
    if db is None:
        raise ApiError(503, "service_unavailable", "Database is not configured")
    if not await db.ping():
        raise ApiError(503, "service_unavailable", "Database is unreachable")
    return ReadinessResponse(status="ready", database="ok")
