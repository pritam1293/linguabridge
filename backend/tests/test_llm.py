from __future__ import annotations

import json

import httpx
import pytest

from app.config import Settings
from app.errors import APIError
from app.llm import OllamaClient, parse_json_object


def make_ollama() -> OllamaClient:
    return OllamaClient(
        Settings(
            llm_mode="ollama",
            ollama_model="qwen2.5:7b",
            ollama_base_url="http://127.0.0.1:11434",
            ollama_timeout_s=10,
            temperature=0.2,
            ollama_num_ctx=4096,
        )
    )


async def with_transport(client: OllamaClient, handler) -> OllamaClient:
    await client._client.aclose()
    client._client = httpx.AsyncClient(
        base_url="http://127.0.0.1:11434",
        transport=httpx.MockTransport(handler),
    )
    return client


SCHEMA = {"type": "object", "properties": {}, "required": []}
MESSAGES = [{"role": "user", "content": "translate this"}]


async def test_complete_json_sends_schema_and_parses_content():
    seen: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["path"] = request.url.path
        seen["body"] = json.loads(request.content)
        payload = {
            "translated_text": "Hello",
            "detected_tone": "neutral",
            "cultural_note": "",
            "source_language": "Spanish",
        }
        return httpx.Response(
            200,
            json={"message": {"role": "assistant", "content": json.dumps(payload)}},
        )

    client = await with_transport(make_ollama(), handler)
    try:
        result = await client.complete_json(MESSAGES, SCHEMA)
    finally:
        await client.aclose()

    assert seen["path"] == "/api/chat"
    body = seen["body"]
    assert body["model"] == "qwen2.5:7b"
    assert body["stream"] is False
    assert body["format"] == SCHEMA
    assert body["messages"] == MESSAGES
    assert body["options"] == {"temperature": 0.2, "num_ctx": 4096}
    assert body["keep_alive"] == "30m"
    assert result["translated_text"] == "Hello"


async def test_complete_json_tolerates_code_fences():
    def handler(_: httpx.Request) -> httpx.Response:
        content = '```json\n{"translated_text": "Hola", "detected_tone": "neutral", "cultural_note": "", "source_language": "English"}\n```'
        return httpx.Response(200, json={"message": {"content": content}})

    client = await with_transport(make_ollama(), handler)
    try:
        result = await client.complete_json(MESSAGES, SCHEMA)
    finally:
        await client.aclose()
    assert result["translated_text"] == "Hola"


async def test_missing_model_maps_to_model_not_found():
    def handler(_: httpx.Request) -> httpx.Response:
        return httpx.Response(404, json={"error": "model not found"})

    client = await with_transport(make_ollama(), handler)
    try:
        with pytest.raises(APIError) as excinfo:
            await client.complete_json(MESSAGES, SCHEMA)
    finally:
        await client.aclose()
    assert excinfo.value.status_code == 503
    assert excinfo.value.code == "model_not_found"


async def test_connection_error_maps_to_llm_unreachable():
    def handler(_: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("connection refused")

    client = await with_transport(make_ollama(), handler)
    try:
        with pytest.raises(APIError) as excinfo:
            await client.complete_json(MESSAGES, SCHEMA)
    finally:
        await client.aclose()
    assert excinfo.value.status_code == 503
    assert excinfo.value.code == "llm_unreachable"


async def test_timeout_maps_to_llm_timeout():
    def handler(_: httpx.Request) -> httpx.Response:
        raise httpx.ReadTimeout("too slow")

    client = await with_transport(make_ollama(), handler)
    try:
        with pytest.raises(APIError) as excinfo:
            await client.complete_json(MESSAGES, SCHEMA)
    finally:
        await client.aclose()
    assert excinfo.value.status_code == 504
    assert excinfo.value.code == "llm_timeout"


async def test_empty_content_is_an_error():
    def handler(_: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"message": {"content": "   "}})

    client = await with_transport(make_ollama(), handler)
    try:
        with pytest.raises(APIError) as excinfo:
            await client.complete_json(MESSAGES, SCHEMA)
    finally:
        await client.aclose()
    assert excinfo.value.code == "llm_empty_response"


async def test_deep_health_detects_model_by_family():
    def handler(_: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"models": [{"name": "qwen2.5:7b-instruct-q4_K_M"}]})

    client = await with_transport(make_ollama(), handler)
    try:
        health = await client.health()
    finally:
        await client.aclose()
    assert health["ollama"] == "up"
    assert health["model_present"] is True
    assert health["hint"] is None


async def test_deep_health_reports_missing_model():
    def handler(_: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"models": [{"name": "llama3.1:8b"}]})

    client = await with_transport(make_ollama(), handler)
    try:
        health = await client.health()
    finally:
        await client.aclose()
    assert health["model_present"] is False
    assert health["hint"]
    assert "ollama" not in health["hint"].lower()


async def test_deep_health_never_raises():
    def handler(_: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("down")

    client = await with_transport(make_ollama(), handler)
    try:
        health = await client.health()
    finally:
        await client.aclose()
    assert health["ollama"] == "down"
    assert health["model_present"] is False


def test_parse_json_object_rejects_prose_only():
    with pytest.raises(APIError) as excinfo:
        parse_json_object("Sorry, I cannot do that.")
    assert excinfo.value.code == "llm_invalid_output"


def test_parse_json_object_extracts_object_from_prose():
    assert parse_json_object('Sure! {"a": 1} hope that helps') == {"a": 1}
