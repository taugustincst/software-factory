"""Application factory."""

import logging
from collections.abc import Awaitable, Callable

from fastapi import FastAPI, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.config import Settings, get_settings
from app.db import make_engine
from app.tasks import PostgresTaskStore
from app.tasks import router as tasks_router

logger = logging.getLogger("app")

SECURITY_HEADERS = {
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
}


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or get_settings()
    logging.basicConfig(level=settings.log_level, format="%(asctime)s %(levelname)s %(name)s %(message)s")

    app = FastAPI(
        title="{{factory.title}}",
        docs_url=None if settings.app_env == "production" else "/docs",
        redoc_url=None,
    )
    engine = make_engine(settings.database_url)
    app.state.db_engine = engine
    app.state.task_store = PostgresTaskStore(engine)

    if settings.cors_origins:
        app.add_middleware(
            CORSMiddleware,
            allow_origins=settings.cors_origins,
            allow_methods=["GET", "POST", "PATCH", "DELETE"],
            allow_headers=["Content-Type", "Authorization"],
        )

    @app.middleware("http")
    async def security_headers(request: Request, call_next: Callable[[Request], Awaitable[Response]]) -> Response:
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
    return app


app = create_app()
