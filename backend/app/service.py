"""Translation orchestration: sanitise -> cache -> prompt -> model -> validate."""

from __future__ import annotations

import hashlib
import json
import logging
import time
from difflib import SequenceMatcher

from pydantic import ValidationError

from .cache import TTLCache
from .config import Settings
from .context import format_transcript, prepare_history
from .errors import APIError
from .languages import normalize_language
from .llm import LLMClient
from .prompts import (
    LLM_JSON_SCHEMA,
    PROMPT_VERSION,
    SYSTEM_PROMPT,
    build_retry_prompt,
    build_user_prompt,
)
from .ratelimit import SlidingWindowRateLimiter
from .sanitize import clean_text, has_translatable_content
from .schemas import LLMOutput, ResponseMeta, TranslateRequest, TranslateResponse

logger = logging.getLogger("linguabridge")

_MAX_NOTE_CHARS = 400
_MAX_TONE_CHARS = 120
_ECHO_MIN_ALNUM = 4
_ECHO_RATIO = 0.98


def _alnum_fold(text: str) -> str:
    """Case-fold and drop everything except letters/digits (incl. non-Latin)."""

    return "".join(char.casefold() for char in text if char.isalnum())


def _looks_like_echo(source: str, translated: str) -> bool:
    """True when the model handed the source back instead of translating it."""

    left = _alnum_fold(source)
    right = _alnum_fold(translated)
    if len(left) < _ECHO_MIN_ALNUM or len(right) < _ECHO_MIN_ALNUM:
        return False
    if left == right:
        return True
    if abs(len(left) - len(right)) > max(2, len(left) // 10):
        return False
    return SequenceMatcher(None, left, right).ratio() >= _ECHO_RATIO


def _same_language(detected: str, target_code: str, target_name: str) -> bool:
    """True when the detected source language is the requested target language."""

    code, name = normalize_language(detected)
    if code != "auto" and code.casefold() == target_code.casefold():
        return True
    return name.strip().casefold() == target_name.strip().casefold()


class TranslationService:
    def __init__(
        self,
        settings: Settings,
        llm: LLMClient,
        cache: TTLCache,
        limiter: SlidingWindowRateLimiter,
    ) -> None:
        self._settings = settings
        self._llm = llm
        self._cache = cache
        self._limiter = limiter

    @property
    def model_name(self) -> str:
        return self._settings.ollama_model

    async def translate(self, request: TranslateRequest, *, client_key: str) -> TranslateResponse:
        retry_after = await self._limiter.hit(client_key)
        if retry_after is not None:
            raise APIError(
                429,
                "rate_limited",
                "Too many translation requests. Wait a moment and try again.",
                retry_after=retry_after,
            )

        target_code, target_name = normalize_language(request.target_language)
        if target_code == "auto" or not target_name:
            raise APIError(422, "invalid_language", "target_language must name a concrete language.")

        source_label = "auto"
        if request.source_language.strip().lower() not in ("", "auto"):
            _, source_label = normalize_language(request.source_language)

        message = clean_text(request.message)
        if not message or not has_translatable_content(message):
            return self._passthrough(message)

        if len(message) > self._settings.max_message_chars:
            raise APIError(
                413,
                "message_too_long",
                f"Message is {len(message)} characters; the limit is "
                f"{self._settings.max_message_chars}. Try translating a shorter part.",
            )

        # Defensive: the extension should never include the target message in
        # history, but a duplicate would waste context and confuse the model.
        history = list(request.history)
        if history and clean_text(history[-1].text) == message:
            history = history[:-1]

        prepared = prepare_history(
            history,
            max_messages=self._settings.max_history_messages,
            max_total_chars=self._settings.max_history_chars,
            max_message_chars=self._settings.max_history_message_chars,
        )

        cache_key = self._cache_key(
            message=message,
            prepared_lines=prepared.lines,
            target_code=target_code,
            source_label=source_label,
            chat_type=request.chat_type,
        )
        cached = await self._cache.get(cache_key)
        if cached is not None:
            body = dict(cached)
            body["meta"] = {**cached.get("meta", {}), "cached": True, "latency_ms": 0}
            logger.info("translate cache_hit target=%s", target_code)
            return TranslateResponse.model_validate(body)

        history_text = format_transcript(prepared)
        user_prompt, _nonce = build_user_prompt(
            message=message,
            history_text=history_text,
            target_name=target_name,
            source_name=source_label,
            chat_type=request.chat_type,
        )
        messages = [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": user_prompt},
        ]

        started = time.perf_counter()
        raw = await self._llm.complete_json(messages, LLM_JSON_SCHEMA)
        output = await self._validate_or_repair(raw, messages)
        latency_ms = int((time.perf_counter() - started) * 1000)

        translated = clean_text(output.translated_text, max_chars=self._settings.max_output_chars)
        if not translated:
            translated = message
        tone = clean_text(output.detected_tone, max_chars=_MAX_TONE_CHARS, keep_newlines=False) or "neutral"
        note = clean_text(output.cultural_note, max_chars=_MAX_NOTE_CHARS, keep_newlines=False)
        detected = clean_text(output.source_language, keep_newlines=False, max_chars=60)
        if detected.lower() in ("", "auto", "unknown", "none"):
            detected = source_label if source_label != "auto" else "unknown"

        if (
            self._settings.llm_mode != "mock"
            and not _same_language(detected, target_code, target_name)
            and _looks_like_echo(message, translated)
        ):
            translated, tone, note, detected = await self._retry_untranslated(
                message=message,
                target_name=target_name,
                source_name=detected,
                chat_type=request.chat_type,
                fallback=(translated, tone, note, detected),
            )

        response = TranslateResponse(
            translated_text=translated,
            detected_tone=tone,
            cultural_note=note,
            meta=ResponseMeta(
                cached=False,
                passthrough=False,
                latency_ms=latency_ms,
                model=self.model_name,
                mode=self._settings.llm_mode,
                history_used=prepared.used,
                source_language_detected=detected,
            ),
        )
        await self._cache.set(cache_key, response.model_dump())
        logger.info(
            "translate ok target=%s chars=%d history=%d latency_ms=%d mode=%s",
            target_code,
            len(message),
            prepared.used,
            latency_ms,
            self._settings.llm_mode,
        )
        return response

    async def _validate_or_repair(
        self,
        raw: dict,
        messages: list[dict[str, str]],
    ) -> LLMOutput:
        try:
            return LLMOutput.model_validate(raw)
        except ValidationError:
            if self._settings.llm_mode == "mock":
                raise APIError(
                    502,
                    "llm_invalid_output",
                    "The model returned a response that did not match the required schema.",
                )

        repair_messages = [
            *messages,
            {"role": "assistant", "content": json.dumps(raw, ensure_ascii=False)},
            {
                "role": "user",
                "content": (
                    "That response did not satisfy the JSON schema. Return ONLY a corrected "
                    "JSON object with a non-empty translated_text. No markdown."
                ),
            },
        ]
        repaired = await self._llm.complete_json(repair_messages, LLM_JSON_SCHEMA)
        try:
            return LLMOutput.model_validate(repaired)
        except ValidationError as exc:
            raise APIError(
                502,
                "llm_invalid_output",
                "The model returned a response that did not match the required schema.",
            ) from exc

    async def _retry_untranslated(
        self,
        *,
        message: str,
        target_name: str,
        source_name: str,
        chat_type: str,
        fallback: tuple[str, str, str, str],
    ) -> tuple[str, str, str, str]:
        """Second attempt when the model echoed the source; never worse than ``fallback``."""

        prompt, _nonce = build_retry_prompt(
            message=message,
            target_name=target_name,
            source_name=source_name,
            chat_type=chat_type,
        )
        messages = [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": prompt},
        ]
        try:
            raw = await self._llm.complete_json(messages, LLM_JSON_SCHEMA)
            retried = await self._validate_or_repair(raw, messages)
        except APIError as exc:
            logger.warning("translate echo_retry_failed code=%s", exc.code)
            return fallback

        translated = clean_text(retried.translated_text, max_chars=self._settings.max_output_chars)
        improved = bool(translated) and not _looks_like_echo(message, translated)
        logger.warning("translate echo_retry improved=%s", improved)
        if not improved:
            return fallback

        tone = (
            clean_text(retried.detected_tone, max_chars=_MAX_TONE_CHARS, keep_newlines=False)
            or fallback[1]
        )
        note = (
            clean_text(retried.cultural_note, max_chars=_MAX_NOTE_CHARS, keep_newlines=False)
            or fallback[2]
        )
        detected = clean_text(retried.source_language, keep_newlines=False, max_chars=60)
        if detected.lower() in ("", "auto", "unknown", "none"):
            detected = fallback[3]
        return translated, tone, note, detected

    def _passthrough(self, message: str) -> TranslateResponse:
        return TranslateResponse(
            translated_text=message,
            detected_tone="neutral",
            cultural_note="",
            meta=ResponseMeta(
                cached=False,
                passthrough=True,
                latency_ms=0,
                model=self.model_name,
                mode=self._settings.llm_mode,
                history_used=0,
                source_language_detected="none",
            ),
        )

    def _cache_key(
        self,
        *,
        message: str,
        prepared_lines: tuple,
        target_code: str,
        source_label: str,
        chat_type: str,
    ) -> str:
        payload = {
            "v": PROMPT_VERSION,
            "model": self.model_name,
            "message": message,
            "target": target_code,
            "source": source_label,
            "chat": chat_type,
            "history": [[line.speaker, line.text] for line in prepared_lines],
        }
        canonical = json.dumps(payload, ensure_ascii=False, sort_keys=True)
        return hashlib.sha256(canonical.encode("utf-8")).hexdigest()
