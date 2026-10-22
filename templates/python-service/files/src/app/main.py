"""Application factory."""

import logging
from collections.abc import Awaitable, Callable
from typing import TYPE_CHECKING

from fastapi import FastAPI, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.auth import PostgresAuthStore, RateLimiter
from app.auth import router as auth_router
from app.config import Settings, get_settings
from app.db import make_engine
from app.tasks import PostgresTaskStore
from app.tasks import router as tasks_router
from app.telemetry import TraceContextLogFilter, configure_telemetry

if TYPE_CHECKING:
    from opentelemetry.sdk.trace.export import SpanExporter

logger = logging.getLogger("app")

SECURITY_HEADERS = {
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
}


def create_app(settings: Settings | None = None, *, span_exporter: "SpanExporter | None" = None) -> FastAPI:
    settings = settings or get_settings()
    logging.basicConfig(
        level=settings.log_level,
        format="%(asctime)s %(levelname)s %(name)s trace_id=%(trace_id)s span_id=%(span_id)s %(message)s",
    )
    # Every log record carries trace_id/span_id ("-" outside a span), so a
    # line emitted during a traced request can be correlated with its trace.
    log_filter = TraceContextLogFilter()
    for handler in logging.getLogger().handlers:
        if not any(isinstance(f, TraceContextLogFilter) for f in handler.filters):
            handler.addFilter(log_filter)

    app = FastAPI(
        title="P3 Py",
        docs_url=None if settings.app_env == "production" else "/docs",
        redoc_url=None,
    )
    engine = make_engine(settings.database_url)
    app.state.db_engine = engine
    app.state.settings = settings
    app.state.task_store = PostgresTaskStore(engine)
    app.state.auth_store = PostgresAuthStore(engine)
    app.state.auth_rate_limiter = RateLimiter()

    if settings.cors_origins:
        app.add_middleware(
            CORSMiddleware,
            allow_origins=settings.cors_origins,
            allow_methods=["GET", "POST", "PATCH", "DELETE"],
            allow_headers=["Content-Type", "Authorization"],
        )

    @app.middleware("http")
    async def security_headers(
        request: Request, call_next: Callable[[Request], Awaitable[Response]]
    ) -> Response:
        response = await call_next(request)
        if not request.url.path.startswith("/docs") and request.url.path != "/openapi.json":
            response.headers.update(SECURITY_HEADERS)
        return response

    @app.exception_handler(Exception)
    async def unhandled(request: Request, exc: Exception) -> JSONResponse:
        # Log details server-side; never return internals (or any personal data) to clients.
        logger.exception("unhandled error on %s %s", request.method, request.url.path)
        return JSONResponse(status_code=500, content={"error": "internal_error"})

    @app.get("/healthz")
    def healthz() -> dict[str, str]:
        return {"status": "ok"}

    @app.get("/readyz")
    def readyz() -> dict[str, str]:
        return {"status": "ready"}

    app.include_router(tasks_router)
    app.include_router(auth_router)
    # Off by default: a no-op unless OTEL_EXPORTER_OTLP_ENDPOINT is set (or a
    # test injected an exporter). See app/telemetry.py.
    configure_telemetry(app, settings, exporter=span_exporter)
    return app


app = create_app()
