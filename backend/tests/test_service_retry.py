from __future__ import annotations

from app.cache import TTLCache
from app.config import Settings
from app.ratelimit import SlidingWindowRateLimiter
from app.schemas import TranslateRequest
from app.service import TranslationService, _looks_like_echo, _same_language

SOURCE = "No mames, obvio que no. Se pone insoportable después de las dos cervezas 😂"
ECHO = {
    "translated_text": SOURCE,
    "detected_tone": "sarcastic, casual",
    "cultural_note": "",
    "source_language": "Spanish",
}
FIXED = {
    "translated_text": "Damn it, of course not. He gets unbearable after two beers 😂",
    "detected_tone": "sarcastic, casual",
    "cultural_note": "No mames is informal Spanish slang.",
    "source_language": "Spanish",
}


class ScriptedClient:
    """Returns canned JSON objects and records each prompt it receives."""

    def __init__(self, outputs: list[dict]) -> None:
        self._outputs = list(outputs)
        self.calls: list[list[dict[str, str]]] = []

    async def complete_json(self, messages, schema):  # noqa: ANN001, ANN201
        self.calls.append(messages)
        if not self._outputs:
            raise AssertionError("the service made more LLM calls than the test scripted")
        return self._outputs.pop(0)

    async def health(self) -> dict:
        return {"ollama": "up", "model_present": True}

    async def aclose(self) -> None:
        return None


def make_service(client: ScriptedClient) -> TranslationService:
    settings = Settings(
        llm_mode="ollama",
        ollama_model="qwen2.5:7b",
        rate_limit_per_minute=1000,
        cache_ttl_s=60,
        max_message_chars=4000,
    )
    return TranslationService(
        settings,
        client,
        TTLCache(16, 60),
        SlidingWindowRateLimiter(1000),
    )


async def run(client: ScriptedClient, **overrides):
    payload = {"message": SOURCE, "target_language": "en"}
    payload.update(overrides)
    return await make_service(client).translate(TranslateRequest(**payload), client_key="test")


async def test_echo_triggers_one_history_free_retry():
    client = ScriptedClient([ECHO, FIXED])
    response = await run(client)

    assert response.translated_text == FIXED["translated_text"]
    assert response.detected_tone == "sarcastic, casual"
    assert response.cultural_note == FIXED["cultural_note"]
    assert len(client.calls) == 2

    retry_prompt = client.calls[1][-1]["content"]
    assert "previous answer returned the message unchanged" in retry_prompt
    assert "UNTRUSTED_HISTORY" not in retry_prompt


async def test_failed_retry_keeps_the_first_result():
    client = ScriptedClient([ECHO, dict(ECHO)])
    response = await run(client)

    assert len(client.calls) == 2
    assert response.translated_text == SOURCE
    assert response.detected_tone == "sarcastic, casual"


async def test_same_language_echo_is_not_retried():
    text = "This is already English."
    output = {
        "translated_text": text,
        "detected_tone": "neutral",
        "cultural_note": "",
        "source_language": "English",
    }
    client = ScriptedClient([output])
    response = await run(client, message=text)

    assert response.translated_text == text
    assert len(client.calls) == 1


async def test_normal_translation_makes_a_single_call():
    output = {
        "translated_text": "Hello, how are you?",
        "detected_tone": "neutral",
        "cultural_note": "",
        "source_language": "Spanish",
    }
    client = ScriptedClient([output])
    response = await run(client, message="Hola, ¿cómo estás?")

    assert response.translated_text == "Hello, how are you?"
    assert len(client.calls) == 1


def test_looks_like_echo_is_lenient_about_punctuation_and_case():
    assert _looks_like_echo("Hola, amigo!", "hola amigo")
    assert _looks_like_echo(SOURCE, SOURCE.replace(" 😂", ""))
    assert not _looks_like_echo("Hola, ¿cómo estás?", "Hello, how are you?")
    assert not _looks_like_echo("OK", "OK")  # too short to judge
    assert not _looks_like_echo("ممكن نتكلم بعدين؟", "Can we talk later?")


def test_same_language_recognises_names_and_codes():
    assert _same_language("English", "en", "English")
    assert _same_language("en", "en", "English")
    assert _same_language("Spanish", "es", "Spanish")
    assert not _same_language("Spanish", "en", "English")
    assert not _same_language("auto", "en", "English")
