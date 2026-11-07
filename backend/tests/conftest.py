from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app


def make_settings(**overrides) -> Settings:
    base = dict(
        llm_mode="mock",
        rate_limit_per_minute=10_000,
        cache_ttl_s=60,
        max_message_chars=200,
        max_history_messages=6,
        max_history_chars=3000,
    )
    base.update(overrides)
    return Settings(**base)


@pytest.fixture
def client():
    with TestClient(create_app(make_settings())) as test_client:
        yield test_client


def post_translate(client: TestClient, **overrides):
    payload = {"message": "¿Qué pasa, tío?", "target_language": "en"}
    payload.update(overrides)
    return client.post("/v1/translate", json=payload)
