"""LLM adapters.

Only two implementations exist: Ollama (real) and a deterministic mock used by
tests and by extension development when no model is pulled.
"""

from __future__ import annotations

import json
import logging
import re
from typing import Any, Protocol

import httpx

from .config import Settings
from .errors import APIError

logger = logging.getLogger("linguabridge")

_UNAVAILABLE = "Translation is temporarily unavailable. Please try again."
_TIMEOUT = "Translation took too long. Please try again."
_INVALID = "Something went wrong while translating. Please try again."

_MESSAGE_BLOCK = re.compile(
    r"UNTRUSTED_MESSAGE_BEGIN_[0-9a-f]+\n(.*?)\nUNTRUSTED_MESSAGE_END_[0-9a-f]+",
    re.DOTALL,
)
_TARGET_LINE = re.compile(r"^TARGET_LANGUAGE: (.*)$", re.MULTILINE)
_FENCE = re.compile(r"^```[a-zA-Z0-9_-]*\s*|\s*```$")


class LLMClient(Protocol):
    async def complete_json(self, messages: list[dict[str, str]], schema: dict) -> dict[str, Any]: ...

    async def health(self) -> dict[str, Any]: ...

    async def aclose(self) -> None: ...


def parse_json_object(text: str) -> dict[str, Any]:
    """Tolerate code fences / stray prose, otherwise fail loudly."""

    cleaned = _FENCE.sub("", text.strip())
    start, end = cleaned.find("{"), cleaned.rfind("}")
    if start == -1 or end <= start:
        raise APIError(502, "llm_invalid_output", _INVALID)
    try:
        value = json.loads(cleaned[start : end + 1])
    except json.JSONDecodeError as exc:
        logger.warning("LLM returned invalid JSON: %s", exc.msg)
        raise APIError(502, "llm_invalid_output", _INVALID) from exc
    if not isinstance(value, dict):
        raise APIError(502, "llm_invalid_output", _INVALID)
    return value


class OllamaClient:
    def __init__(self, settings: Settings) -> None:
        self._settings = settings
        self._client = httpx.AsyncClient(
            base_url=settings.ollama_base_url,
            timeout=httpx.Timeout(settings.ollama_timeout_s, connect=5.0),
        )

    async def complete_json(self, messages: list[dict[str, str]], schema: dict) -> dict[str, Any]:
        payload = {
            "model": self._settings.ollama_model,
            "messages": messages,
            "stream": False,
            "format": schema,
            "keep_alive": self._settings.ollama_keep_alive,
            "options": {
                "temperature": self._settings.temperature,
                "num_ctx": self._settings.ollama_num_ctx,
            },
        }
        try:
            response = await self._client.post("/api/chat", json=payload)
        except httpx.ConnectError as exc:
            logger.warning("LLM unreachable at %s", self._settings.ollama_base_url)
            raise APIError(503, "llm_unreachable", _UNAVAILABLE) from exc
        except httpx.TimeoutException as exc:
            logger.warning("LLM timed out after %.0fs", self._settings.ollama_timeout_s)
            raise APIError(504, "llm_timeout", _TIMEOUT) from exc
        except httpx.HTTPError as exc:
            logger.warning("LLM transport error: %s", type(exc).__name__)
            raise APIError(502, "llm_transport_error", _UNAVAILABLE) from exc

        if response.status_code == 404:
            logger.warning("LLM model not available: %s", self._settings.ollama_model)
            raise APIError(503, "model_not_found", _UNAVAILABLE)
        if response.status_code >= 400:
            detail = response.text[:200].replace(self._settings.ollama_base_url, "")
            logger.warning("LLM upstream HTTP %s: %s", response.status_code, detail)
            raise APIError(502, "llm_upstream_error", _UNAVAILABLE)

        try:
            data = response.json()
        except ValueError as exc:
            logger.warning("LLM returned a non-JSON body")
            raise APIError(502, "llm_invalid_output", _INVALID) from exc

        content = (data.get("message") or {}).get("content") or ""
        if not content.strip():
            logger.warning("LLM returned an empty response")
            raise APIError(502, "llm_empty_response", _INVALID)
        return parse_json_object(content)

    @staticmethod
    def _model_present(wanted: str, models: list[str]) -> bool:
        if wanted in models:
            return True
        base = wanted.split(":")[0]
        return any(model.split(":")[0] == base for model in models)

    async def health(self) -> dict[str, Any]:
        try:
            response = await self._client.get("/api/tags", timeout=3.0)
            response.raise_for_status()
            models = [str(entry.get("name", "")) for entry in response.json().get("models", [])]
        except Exception as exc:  # noqa: BLE001 - health endpoint must never raise
            return {
                "ollama": "down",
                "model_present": False,
                "detail": type(exc).__name__,
                "hint": "Translation is temporarily unavailable. Please try again later.",
            }
        present = self._model_present(self._settings.ollama_model, models)
        return {
            "ollama": "up",
            "model_present": present,
            "model": self._settings.ollama_model,
            "models": models[:25],
            "hint": None
            if present
            else "Translation is not ready yet. Please try again later.",
        }

    async def aclose(self) -> None:
        await self._client.aclose()


class MockClient:
    """Deterministic stand-in. Never used unless LB_LLM_MODE=mock."""

    def __init__(self, settings: Settings) -> None:
        self._settings = settings

    async def complete_json(self, messages: list[dict[str, str]], schema: dict) -> dict[str, Any]:
        user = next((m["content"] for m in reversed(messages) if m["role"] == "user"), "")
        match = _MESSAGE_BLOCK.search(user)
        text = match.group(1) if match else ""
        target_match = _TARGET_LINE.search(user)
        target = target_match.group(1).strip() if target_match else "the target language"
        return {
            "translated_text": f"[{target}] {text}".strip(),
            "detected_tone": _mock_tone(text),
            "cultural_note": "",
            "source_language": "Unknown",
        }

    async def health(self) -> dict[str, Any]:
        return {
            "ollama": "mock",
            "model_present": True,
            "model": self._settings.ollama_model,
            "hint": None,
        }

    async def aclose(self) -> None:
        return None


def _mock_tone(text: str) -> str:
    low = text.lower()
    if any(token in low for token in ("lol", "lmao", "haha", "jaja", "😂", "🤣")):
        return "casual, humorous"
    if any(token in low for token in ("please", "kindly", "sincerely", "regards")):
        return "formal"
    if text.endswith("!!"):
        return "emphatic"
    if any(token in low for token in ("love", "❤", "🥰", "miss you")):
        return "affectionate"
    return "neutral"


def build_client(settings: Settings) -> LLMClient:
    if settings.llm_mode == "mock":
        logger.info("LLM mode: mock (no model calls)")
        return MockClient(settings)
    logger.info("LLM mode: ollama model=%s url=%s", settings.ollama_model, settings.ollama_base_url)
    return OllamaClient(settings)
