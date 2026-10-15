from typing import Any

from fastapi import APIRouter

from app.api.v1 import (
    cart,
    deals,
    engagement,
    health,
    manage,
    me,
    notifications,
    orders,
    outlets,
    payments,
    rewards,
    social,
    staff,
)
from app.core.errors import ErrorResponse

# Every error uses the same envelope (including request validation, which FastAPI would
# otherwise document as its own HTTPValidationError shape).
_ERRORS: dict[int | str, dict[str, Any]] = {
    status: {"model": ErrorResponse, "description": description}
    for status, description in {
        401: "Missing or invalid access token",
        403: "Authenticated but not allowed",
        404: "Not found (or not visible to the caller)",
        409: "Conflicts with current state (stock, slot, transition, idempotency…)",
        422: "Invalid input",
        429: "Rate limited",
        503: "A required dependency is unavailable",
    }.items()
}

api_router = APIRouter(prefix="/api/v1", responses=_ERRORS)
api_router.include_router(health.router)
api_router.include_router(me.router)
api_router.include_router(outlets.router)
api_router.include_router(cart.router)
api_router.include_router(orders.router)
api_router.include_router(deals.router)
api_router.include_router(payments.router)
api_router.include_router(rewards.router)
api_router.include_router(notifications.router)
api_router.include_router(engagement.router)
api_router.include_router(social.router)
api_router.include_router(staff.router)
api_router.include_router(manage.router)
