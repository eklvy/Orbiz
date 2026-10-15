import asyncio
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

import httpx2 as httpx
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app import __version__
from app.api.v1.router import api_router
from app.core.auth import TokenVerifier
from app.core.config import Settings, get_settings
from app.core.db import Database
from app.core.errors import register_error_handlers
from app.core.logging import configure_logging
from app.core.request_context import register_request_context
from app.modules.notifications.service import push_loop
from app.modules.payments.provider import Razorpay


def create_app(
    settings: Settings | None = None, *, http_transport: httpx.AsyncBaseTransport | None = None
) -> FastAPI:
    """`http_transport` replaces outbound HTTP (Razorpay, Expo) in tests only."""
    settings = settings or get_settings()
    configure_logging(settings.log_level)

    db = (
        Database(
            settings.database_url.get_secret_value(),
            min_size=settings.db_pool_min_size,
            max_size=settings.db_pool_max_size,
        )
        if settings.database_url
        else None
    )

    razorpay = Razorpay(settings, http_transport) if settings.payments_enabled else None

    @asynccontextmanager
    async def lifespan(_: FastAPI) -> AsyncIterator[None]:
        if db is not None:
            await db.open()
        pusher = (
            asyncio.create_task(push_loop(db, settings, http_transport))
            if db is not None and settings.expo_access_token is not None
            else None
        )
        try:
            yield
        finally:
            if pusher is not None:
                pusher.cancel()
            if razorpay is not None:
                await razorpay.close()
            if db is not None:
                await db.close()

    app = FastAPI(
        title="CampusCart API",
        version=__version__,
        lifespan=lifespan,
        docs_url="/docs" if settings.docs_enabled else None,
        redoc_url=None,
        openapi_url="/openapi.json" if settings.docs_enabled else None,
    )
    app.state.settings = settings
    app.state.db = db
    app.state.razorpay = razorpay
    app.state.http_transport = http_transport
    app.state.token_verifier = TokenVerifier.from_settings(settings)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_allowed_origins,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
        expose_headers=["X-Request-ID"],
    )
    register_request_context(app)
    register_error_handlers(app)
    app.include_router(api_router)
    return app


app = create_app()
