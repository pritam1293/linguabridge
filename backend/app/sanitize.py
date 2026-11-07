"""Input sanitisation.

Goals:
* remove invisible/format characters that enable spoofing and confuse tokenizers,
* keep characters that carry meaning (ZWJ in emoji, ZWNJ in Persian/Indic text),
* bound every string that reaches a prompt.
"""

from __future__ import annotations

import re
import unicodedata

# C0/C1 controls except TAB (\t) and LINE FEED (\n).
_CONTROL = re.compile("[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]")
# Bidi overrides / isolates / marks and zero-width space / BOM.
# NOTE: U+200C (ZWNJ) and U+200D (ZWJ) are intentionally preserved.
_BIDI = re.compile("[\u061c\u200b\u200e\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]")
_HORIZONTAL_RUN = re.compile(r"[ \t]{2,}")
_MULTI_NEWLINE = re.compile(r"\n{3,}")


def clean_text(
    value: str,
    *,
    max_chars: int | None = None,
    keep_newlines: bool = True,
) -> str:
    """Normalise untrusted text without destroying meaning.

    ``max_chars`` truncates with an ellipsis and is meant for *context*
    strings. The target message is length-checked before it is ever truncated
    so that a translation is never silently computed from a partial message.
    """

    if not isinstance(value, str):  # defensive: callers may pass None
        value = "" if value is None else str(value)

    value = unicodedata.normalize("NFC", value)
    value = value.replace("\r\n", "\n").replace("\r", "\n")
    value = _CONTROL.sub("", value)
    value = _BIDI.sub("", value)
    value = value.replace("\u00a0", " ").replace("\u202f", " ")

    if keep_newlines:
        value = "\n".join(line.rstrip() for line in value.split("\n"))
        value = _MULTI_NEWLINE.sub("\n\n", value)
    else:
        value = value.replace("\n", " ")

    value = _HORIZONTAL_RUN.sub(" ", value).strip()

    if max_chars is not None and len(value) > max_chars:
        value = value[: max(0, max_chars - 1)].rstrip() + "\u2026"

    return value


def has_translatable_content(text: str) -> bool:
    """False for emoji/punctuation/whitespace-only messages."""
    return any(ch.isalpha() or ch.isdigit() for ch in text)


def clean_speaker(value: str, *, max_chars: int = 32) -> str:
    """Short display label for a conversation participant."""
    cleaned = clean_text(value, max_chars=max_chars, keep_newlines=False)
    return cleaned.rstrip(":").strip()
