from __future__ import annotations

from app.context import format_transcript, prepare_history
from app.schemas import HistoryMessage


def _msg(role: str, text: str, speaker: str = "") -> HistoryMessage:
    return HistoryMessage(role=role, text=text, speaker=speaker)


def test_default_speakers():
    prepared = prepare_history(
        [_msg("self", "hello"), _msg("other", "hey")],
        max_messages=5,
        max_total_chars=1000,
        max_message_chars=500,
    )
    assert [line.speaker for line in prepared.lines] == ["Me", "Other"]


def test_keeps_most_recent_messages():
    history = [_msg("other", f"m{i}") for i in range(10)]
    prepared = prepare_history(
        history,
        max_messages=3,
        max_total_chars=1000,
        max_message_chars=500,
    )
    assert [line.text for line in prepared.lines] == ["m7", "m8", "m9"]
    assert prepared.used == 3


def test_budget_drops_oldest_first():
    history = [_msg("other", "a" * 50), _msg("other", "b" * 50), _msg("other", "c" * 50)]
    prepared = prepare_history(
        history,
        max_messages=3,
        max_total_chars=100,
        max_message_chars=500,
    )
    assert [line.text[0] for line in prepared.lines] == ["c"]


def test_empty_transcript():
    prepared = prepare_history([], max_messages=3, max_total_chars=100, max_message_chars=50)
    assert prepared.empty
    assert format_transcript(prepared) == "(none)"


def test_transcript_numbering_and_indentation():
    prepared = prepare_history(
        [_msg("other", "line one\nline two", "Ana")],
        max_messages=3,
        max_total_chars=500,
        max_message_chars=500,
    )
    transcript = format_transcript(prepared)
    assert transcript.startswith("[1] Ana: line one")
    assert "\n    line two" in transcript
