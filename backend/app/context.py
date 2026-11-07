"""Sliding-window conversation context assembly."""

from __future__ import annotations

from dataclasses import dataclass

from .sanitize import clean_speaker, clean_text
from .schemas import HistoryMessage


@dataclass(frozen=True)
class ContextLine:
    index: int
    speaker: str
    text: str


@dataclass(frozen=True)
class PreparedHistory:
    lines: tuple[ContextLine, ...]
    used: int

    @property
    def empty(self) -> bool:
        return not self.lines


def prepare_history(
    history: list[HistoryMessage],
    *,
    max_messages: int,
    max_total_chars: int,
    max_message_chars: int,
) -> PreparedHistory:
    """Take the most recent messages that fit the context budget.

    Order is oldest -> newest, matching how a human reads a chat. Older
    messages are dropped first; the newest message is always kept (truncated
    if necessary) because it carries the most disambiguating context.
    """

    if max_messages <= 0 or not history:
        return PreparedHistory((), 0)

    candidates = history[-max_messages:]
    cleaned: list[tuple[str, str]] = []
    for item in candidates:
        text = clean_text(item.text)
        if not text:
            continue
        speaker = clean_speaker(item.speaker) or ("Me" if item.role == "self" else "Other")
        cleaned.append((speaker, text))

    kept: list[tuple[str, str]] = []
    total = 0
    for speaker, text in reversed(cleaned):  # newest first
        if len(text) > max_message_chars:
            text = clean_text(text, max_chars=max_message_chars)
        cost = len(text) + len(speaker) + 8
        remaining = max_total_chars - total
        if cost > remaining:
            if not kept and remaining > 40:
                # Keep at least the newest line, trimmed to the remaining budget.
                text = clean_text(text, max_chars=max(16, remaining - len(speaker) - 8))
                kept.append((speaker, text))
            break
        kept.append((speaker, text))
        total += cost

    kept.reverse()
    lines = tuple(
        ContextLine(index=index + 1, speaker=speaker, text=text)
        for index, (speaker, text) in enumerate(kept)
    )
    return PreparedHistory(lines=lines, used=len(lines))


def format_transcript(prepared: PreparedHistory) -> str:
    if prepared.empty:
        return "(none)"
    rendered = []
    for line in prepared.lines:
        continuation = line.text.replace("\n", "\n    ")
        rendered.append(f"[{line.index}] {line.speaker}: {continuation}")
    return "\n".join(rendered)
