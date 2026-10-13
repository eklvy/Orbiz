"""Consistent error envelope for every API error response.

Shape is mirrored by `ApiErrorBody` in packages/contracts/src/errors.ts.
"""

import logging
from typing import Any, Literal

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from starlette.exceptions import HTTPException as StarletteHTTPException

logger = logging.getLogger(__name__)

ErrorCode = Literal[
    "validation_error",
    "unauthenticated",
    "forbidden",
    "not_found",
    "conflict",
    "rate_limited",
    "internal_error",
]

_STATUS_TO_CODE: dict[int, ErrorCode] = {
    400: "validation_error",
    401: "unauthenticated",
    403: "forbidden",
    404: "not_found",
    409: "conflict",
    422: "validation_error",
    429: "rate_limited",
}


class ErrorDetail(BaseModel):
    code: ErrorCode
    message: str
    request_id: str | None
    details: Any | None = None


class ErrorResponse(BaseModel):
    error: ErrorDetail


class ApiError(Exception):
    """Raise from service code to return a specific error code and HTTP status."""

    def __init__(
        self, status_code: int, code: ErrorCode, message: str, details: Any | None = None
    ) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.code = code
        self.message = message
        self.details = details


def _response(
    request: Request, status_code: int, code: ErrorCode, message: str, details: Any = None
) -> JSONResponse:
    body = ErrorResponse(
        error=ErrorDetail(
            code=code,
            message=message,
            request_id=getattr(request.state, "request_id", None),
            details=details,
        )
    )
    return JSONResponse(status_code=status_code, content=body.model_dump(exclude_none=True))


def register_error_handlers(app: FastAPI) -> None:
    @app.exception_handler(ApiError)
    async def _api_error(request: Request, exc: ApiError) -> JSONResponse:
        return _response(request, exc.status_code, exc.code, exc.message, exc.details)

    @app.exception_handler(StarletteHTTPException)
    async def _http_error(request: Request, exc: StarletteHTTPException) -> JSONResponse:
        code = _STATUS_TO_CODE.get(exc.status_code, "internal_error")
        return _response(request, exc.status_code, code, str(exc.detail))

    @app.exception_handler(RequestValidationError)
    async def _validation_error(request: Request, exc: RequestValidationError) -> JSONResponse:
        details = [
            {"loc": list(err.get("loc", ())), "msg": err.get("msg"), "type": err.get("type")}
            for err in exc.errors()
        ]
        return _response(request, 422, "validation_error", "Request validation failed", details)

    @app.exception_handler(Exception)
    async def _unhandled(request: Request, exc: Exception) -> JSONResponse:
        logger.exception("unhandled_error", extra={"path": request.url.path})
        return _response(request, 500, "internal_error", "An unexpected error occurred")
