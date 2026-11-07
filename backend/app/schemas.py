"""Request/response models.

The three fields required by the product contract are top-level:
``translated_text``, ``detected_tone`` and ``cultural_note``. Everything else
lives under ``meta`` so the client contract stays stable.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator


class HistoryMessage(BaseModel):
    model_config = ConfigDict(extra="forbid")

    role: Literal["self", "other"]
    text: str = Field(min_length=1, max_length=8000)
    speaker: str = Field(default="", max_length=64)


class TranslateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    message: str = Field(min_length=1, max_length=8000)
    target_language: str = Field(min_length=1, max_length=40)
    source_language: str = Field(default="auto", max_length=40)
    chat_type: Literal["private", "group"] = "private"
    history: list[HistoryMessage] = Field(default_factory=list, max_length=50)
    message_id: str | None = Field(default=None, max_length=128)


class LLMOutput(BaseModel):
    """Shape enforced on the model's structured output."""

    translated_text: str = Field(default="", max_length=12000)
    detected_tone: str = Field(default="neutral", max_length=160)
    cultural_note: str = Field(default="", max_length=800)
    source_language: str = Field(default="", max_length=80)

    @field_validator("translated_text")
    @classmethod
    def _require_translation(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("translated_text must not be empty")
        return value

    @field_validator("detected_tone", "cultural_note", "source_language")
    @classmethod
    def _single_line(cls, value: str) -> str:
        return " ".join(value.split()).strip()


class ResponseMeta(BaseModel):
    cached: bool = False
    passthrough: bool = False
    latency_ms: int = 0
    model: str = ""
    mode: str = ""
    history_used: int = 0
    source_language_detected: str = "unknown"


class TranslateResponse(BaseModel):
    translated_text: str
    detected_tone: str
    cultural_note: str
    meta: ResponseMeta = Field(default_factory=ResponseMeta)


class LanguageInfo(BaseModel):
    code: str
    name: str


class ErrorInfo(BaseModel):
    code: str
    message: str


class ErrorResponse(BaseModel):
    error: ErrorInfo
