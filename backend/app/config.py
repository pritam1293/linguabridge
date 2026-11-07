"""Runtime configuration, loaded from environment variables prefixed with ``LB_``."""

from __future__ import annotations

from typing import Literal

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """All tunables for the local service.

    Every field can be overridden with ``LB_<UPPER_CASE_NAME>`` in the
    environment or in ``backend/.env``.
    """

    model_config = SettingsConfigDict(
        env_prefix="LB_",
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    # --- LLM ---
    llm_mode: Literal["ollama", "mock"] = "ollama"
    ollama_base_url: str = "http://127.0.0.1:11434"
    ollama_model: str = "qwen2.5:7b"
    ollama_timeout_s: float = 90.0
    ollama_num_ctx: int = 4096
    ollama_keep_alive: str = "30m"
    temperature: float = Field(default=0.2, ge=0.0, le=2.0)
    max_output_chars: int = 8000

    # --- Input limits (defensive token budget) ---
    max_message_chars: int = 4000
    max_history_messages: int = 6
    max_history_chars: int = 3000
    max_history_message_chars: int = 600

    # --- Service behaviour ---
    rate_limit_per_minute: int = 30
    cache_ttl_s: int = 3600
    cache_max_entries: int = 256
    allowed_origin_regex: str = (
        r"^(chrome-extension://[a-p]{32}"
        r"|https://web\.telegram\.org"
        r"|http://localhost(:\d+)?"
        r"|http://127\.0\.0\.1(:\d+)?"
        r"|null)$"
    )

    # --- HTTP ---
    host: str = "127.0.0.1"
    port: int = 8787
    log_level: str = "INFO"

    @field_validator("ollama_base_url")
    @classmethod
    def _strip_trailing_slash(cls, value: str) -> str:
        return value.rstrip("/")

    @field_validator("ollama_model", "ollama_keep_alive")
    @classmethod
    def _non_empty(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("must not be empty")
        return value
