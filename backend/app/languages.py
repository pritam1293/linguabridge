"""Language codes and display names used by the extension and the prompt."""

from __future__ import annotations

import re

# Canonical code -> English display name. Order is used by the popup.
LANGUAGES: dict[str, str] = {
    "en": "English",
    "es": "Spanish",
    "pt": "Portuguese",
    "pt-BR": "Brazilian Portuguese",
    "fr": "French",
    "de": "German",
    "it": "Italian",
    "nl": "Dutch",
    "ru": "Russian",
    "uk": "Ukrainian",
    "pl": "Polish",
    "cs": "Czech",
    "sk": "Slovak",
    "ro": "Romanian",
    "hu": "Hungarian",
    "el": "Greek",
    "tr": "Turkish",
    "ar": "Arabic",
    "he": "Hebrew",
    "fa": "Persian",
    "ur": "Urdu",
    "hi": "Hindi",
    "bn": "Bengali",
    "ta": "Tamil",
    "te": "Telugu",
    "mr": "Marathi",
    "gu": "Gujarati",
    "pa": "Punjabi",
    "th": "Thai",
    "vi": "Vietnamese",
    "id": "Indonesian",
    "ms": "Malay",
    "tl": "Filipino",
    "zh": "Chinese (Simplified)",
    "zh-TW": "Chinese (Traditional)",
    "ja": "Japanese",
    "ko": "Korean",
    "sv": "Swedish",
    "no": "Norwegian",
    "da": "Danish",
    "fi": "Finnish",
    "et": "Estonian",
    "lv": "Latvian",
    "lt": "Lithuanian",
    "sr": "Serbian",
    "hr": "Croatian",
    "bg": "Bulgarian",
    "ca": "Catalan",
    "eu": "Basque",
    "gl": "Galician",
    "sw": "Swahili",
    "af": "Afrikaans",
    "am": "Amharic",
    "yo": "Yoruba",
    "ha": "Hausa",
    "zu": "Zulu",
    "sq": "Albanian",
    "mk": "Macedonian",
    "sl": "Slovenian",
    "is": "Icelandic",
    "ga": "Irish",
    "cy": "Welsh",
    "az": "Azerbaijani",
    "kk": "Kazakh",
    "uz": "Uzbek",
    "hy": "Armenian",
    "ka": "Georgian",
    "ne": "Nepali",
    "si": "Sinhala",
    "km": "Khmer",
    "lo": "Lao",
    "my": "Burmese",
    "mn": "Mongolian",
}

_ALIASES: dict[str, str] = {
    "pt_br": "pt-BR",
    "ptbr": "pt-BR",
    "brazilian": "pt-BR",
    "br": "pt-BR",
    "zh_cn": "zh",
    "zhcn": "zh",
    "zh-hans": "zh",
    "zh_hans": "zh",
    "zh-tw": "zh-TW",
    "zh_tw": "zh-TW",
    "zh-hant": "zh-TW",
    "zh_hant": "zh-TW",
    "farsi": "fa",
    "castilian": "es",
    "mandarin": "zh",
    "cantonese": "zh-TW",
    "tagalog": "tl",
    "norwegian bokmal": "no",
    "nb": "no",
}

_ALLOWED = re.compile(r"[^A-Za-z0-9 _\-]")


def normalize_language(raw: str) -> tuple[str, str]:
    """Return ``(canonical_code, english_name)``.

    Unknown values are sanitised and passed through so users can request any
    language the model understands without a backend release.
    """

    value = _ALLOWED.sub("", (raw or "").strip())[:40].strip()
    if not value:
        return "auto", "auto"

    lowered = value.lower().replace("_", "-")
    if lowered in _ALIASES:
        lowered = _ALIASES[lowered].lower()

    for code, name in LANGUAGES.items():
        if code.lower() == lowered or name.lower() == lowered:
            return code, name

    # Accept "pt-BR" style casing after alias lookup.
    for code in LANGUAGES:
        if code.lower() == lowered:
            return code, LANGUAGES[code]

    # Unknown but plausible language: keep it, title-cased for the prompt.
    return value, value


def language_options() -> list[dict[str, str]]:
    return [{"code": code, "name": name} for code, name in LANGUAGES.items()]
