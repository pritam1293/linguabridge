from __future__ import annotations

from fastapi.testclient import TestClient

from app.main import create_app

from tests.conftest import make_settings, post_translate


def test_health(client):
    response = client.get("/health")
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "ok"
    assert body["mode"] == "mock"


def test_deep_health(client):
    response = client.get("/health/deep")
    assert response.status_code == 200
    assert response.json()["status"] == "ok"


def test_translate_contract(client):
    response = post_translate(
        client,
        message="¿Qué pasa, tío?",
        history=[{"role": "other", "speaker": "Ana", "text": "¿Vienes a la fiesta?"}],
        chat_type="private",
    )
    assert response.status_code == 200
    body = response.json()
    assert body["translated_text"] == "[English] ¿Qué pasa, tío?"
    for field in ("translated_text", "detected_tone", "cultural_note"):
        assert field in body
    assert body["meta"]["history_used"] == 1
    assert body["meta"]["mode"] == "mock"
    assert body["meta"]["passthrough"] is False


def test_tone_detection_mock(client):
    body = post_translate(client, message="lol that was wild").json()
    assert "casual" in body["detected_tone"]


def test_emoji_only_is_passthrough(client):
    body = post_translate(client, message="🔥🔥🔥").json()
    assert body["meta"]["passthrough"] is True
    assert body["translated_text"] == "🔥🔥🔥"
    assert body["meta"]["history_used"] == 0


def test_validation_error_does_not_echo_message(client):
    response = client.post(
        "/v1/translate",
        json={"message": "", "target_language": "en"},
    )
    assert response.status_code == 422
    body = response.json()
    assert body["error"]["code"] == "invalid_request"
    assert "input" not in response.text


def test_message_too_long():
    with TestClient(create_app(make_settings(max_message_chars=10))) as client:
        response = post_translate(client, message="a" * 40)
        assert response.status_code == 413
        assert response.json()["error"]["code"] == "message_too_long"


def test_history_is_trimmed_and_target_deduplicated():
    settings = make_settings(max_history_messages=3)
    with TestClient(create_app(settings)) as client:
        history = [
            {"role": "other", "text": f"line {i}"}
            for i in range(1, 4)
        ]
        response = post_translate(client, message="line 3", history=history)
        assert response.status_code == 200
        # Last history line equals the target message, so it is dropped.
        assert response.json()["meta"]["history_used"] == 2


def test_cache_hit(client):
    payload = {"message": "hola amigo", "target_language": "en"}
    first = client.post("/v1/translate", json=payload).json()
    second = client.post("/v1/translate", json=payload).json()
    assert first["meta"]["cached"] is False
    assert second["meta"]["cached"] is True
    assert second["meta"]["latency_ms"] == 0
    assert second["translated_text"] == first["translated_text"]


def test_rate_limit():
    with TestClient(create_app(make_settings(rate_limit_per_minute=1))) as client:
        assert post_translate(client).status_code == 200
        response = post_translate(client)
        assert response.status_code == 429
        assert response.json()["error"]["code"] == "rate_limited"
        assert "Retry-After" in response.headers


def test_bidi_override_is_stripped(client):
    body = post_translate(client, message="he\u202ello").json()
    assert "\u202e" not in body["translated_text"]


def test_languages_endpoint(client):
    response = client.get("/v1/languages")
    assert response.status_code == 200
    codes = {entry["code"] for entry in response.json()}
    assert {"en", "es", "pt-BR", "ja"} <= codes


def test_target_language_alias(client):
    body = post_translate(client, message="olá", target_language="pt-br").json()
    assert body["translated_text"].startswith("[Brazilian Portuguese]")


def test_invalid_target_language(client):
    response = post_translate(client, message="hi", target_language="   ")
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "invalid_language"
