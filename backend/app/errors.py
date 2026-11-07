"""Uniform error envelope and exception handlers."""

from __future__ import annotations

import logging
import math

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

logger = logging.getLogger("linguabridge")


class APIError(Exception):
    """An error that is safe to expose to the extension."""

    def __init__(
        self,
        status_code: int,
        code: str,
        message: str,
        *,
        retry_after: float | None = None,
    ) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.code = code
        self.message = message
        self.retry_after = retry_after


def register_exception_handlers(app: FastAPI) -> None:
    @app.exception_handler(APIError)
    async def _handle_api_error(_: Request, exc: APIError) -> JSONResponse:
        headers: dict[str, str] = {}
        if exc.retry_after is not None:
            headers["Retry-After"] = str(max(1, math.ceil(exc.retry_after)))
        return JSONResponse(
            status_code=exc.status_code,
            content={"error": {"code": exc.code, "message": exc.message}},
            headers=headers,
        )

    @app.exception_handler(RequestValidationError)
    async def _handle_validation_error(_: Request, exc: RequestValidationError) -> JSONResponse:
        # Never echo the submitted value: it may contain a private message.
        first = exc.errors()[0] if exc.errors() else {}
        location = ".".join(str(part) for part in first.get("loc", []) if part != "body")
        detail = first.get("msg", "Invalid request")
        if location:
            detail = f"{location}: {detail}"
        return JSONResponse(
            status_code=422,
            content={"error": {"code": "invalid_request", "message": detail}},
        )

    @app.exception_handler(Exception)
    async def _handle_unexpected(_: Request, exc: Exception) -> JSONResponse:
        # Log the exception type only; messages can contain user content.
        logger.exception("Unhandled error (%s)", type(exc).__name__)
        return JSONResponse(
            status_code=500,
            content={"error": {"code": "internal_error", "message": "Unexpected server error."}},
        )
