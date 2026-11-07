from __future__ import annotations

from app.sanitize import clean_speaker, clean_text, has_translatable_content


def test_strips_bidi_and_zero_width_space():
    assert clean_text("he\u202ello") == "hello"
    assert clean_text("a\u200bb") == "ab"


def test_preserves_emoji_joiner_and_zwnj():
    family = "👨\u200d👩\u200d👧"
    assert clean_text(family) == family
    # ZWNJ is meaningful in Persian and several Indic scripts.
    assert clean_text("می\u200cخواهم") == "می\u200cخواهم"


def test_control_chars_and_nbsp():
    assert clean_text("a\x00b\x07c") == "abc"
    assert clean_text("a\u00a0b") == "a b"


def test_newlines_are_bounded():
    assert clean_text("a\n\n\n\nb") == "a\n\nb"
    assert clean_text("a\nb", keep_newlines=False) == "a b"


def test_truncation_adds_ellipsis():
    assert clean_text("abcdefghij", max_chars=5) == "abcd\u2026"


def test_has_translatable_content():
    assert has_translatable_content("hello")
    assert has_translatable_content("¿Qué?")
    assert has_translatable_content("ありがとう")
    assert has_translatable_content("123")
    assert not has_translatable_content("🔥🔥")
    assert not has_translatable_content("...")


def test_clean_speaker():
    assert clean_speaker("  Ana:  ") == "Ana"
    assert len(clean_speaker("x" * 100)) == 32
