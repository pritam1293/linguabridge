"""FastAPI entry point."""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from typing import Any

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware

from . import __version__
from .cache import TTLCache
from .config import Settings
from .errors import register_exception_handlers
from .languages import language_options
from .llm import build_client
from .ratelimit import SlidingWindowRateLimiter
from .schemas import LanguageInfo, TranslateRequest, TranslateResponse
from .service import TranslationService

logger = logging.getLogger("linguabridge")


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or Settings()

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        logging.basicConfig(
            level=getattr(logging, settings.log_level.upper(), logging.INFO),
            format="%(asctime)s %(levelname)s %(name)s: %(message)s",
        )
        client = build_client(settings)
        app.state.settings = settings
        app.state.llm = client
        app.state.service = TranslationService(
            settings,
            client,
            TTLCache(settings.cache_max_entries, settings.cache_ttl_s),
            SlidingWindowRateLimiter(settings.rate_limit_per_minute),
        )
        logger.info("LinguaBridge listening on http://%s:%d", settings.host, settings.port)
        try:
            yield
        finally:
            await client.aclose()

    app = FastAPI(
        title="LinguaBridge",
        version=__version__,
        description="Local, context-aware translation service for the LinguaBridge Telegram and WhatsApp Web extension.",
        lifespan=lifespan,
    )

    app.add_middleware(
        CORSMiddleware,
        allow_origin_regex=settings.allowed_origin_regex,
        allow_credentials=False,
        allow_methods=["GET", "POST", "OPTIONS"],
        allow_headers=["Content-Type"],
    )
    register_exception_handlers(app)

    @app.get("/", include_in_schema=False)
    async def root() -> dict[str, str]:
        return {"service": "LinguaBridge", "version": __version__, "docs": "/docs"}

    @app.get("/health")
    async def health(request: Request) -> dict[str, Any]:
        current: Settings = request.app.state.settings
        return {
            "status": "ok",
            "version": __version__,
            "mode": current.llm_mode,
            "model": current.ollama_model,
        }

    @app.get("/health/deep")
    async def health_deep(request: Request) -> dict[str, Any]:
        current: Settings = request.app.state.settings
        llm = await request.app.state.llm.health()
        ready = bool(llm.get("model_present"))
        return {
            "status": "ok" if ready else "degraded",
            "version": __version__,
            "mode": current.llm_mode,
            "model": current.ollama_model,
            "llm": llm,
        }

    @app.get("/v1/languages", response_model=list[LanguageInfo])
    async def languages() -> list[dict[str, str]]:
        return language_options()

    @app.post("/v1/translate", response_model=TranslateResponse)
    async def translate(payload: TranslateRequest, request: Request) -> TranslateResponse:
        client_key = request.client.host if request.client else "local"
        return await request.app.state.service.translate(payload, client_key=client_key)

    return app


app = create_app()
