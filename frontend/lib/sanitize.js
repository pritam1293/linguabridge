/* Shared sanitisation helpers (content-script side). */
(() => {
  const LB = (globalThis.LB = globalThis.LB || {});

  // C0/C1 controls except tab/newline.
  const CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g;
  // Bidi overrides/isolates, LRM/RLM/ALM, ZWSP and BOM.
  // ZWNJ (U+200C) and ZWJ (U+200D) are kept: they carry meaning.
  const BIDI = /[\u061c\u200b\u200e\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g;

  function clean(value, options) {
    const opts = options || {};
    const keepNewlines = opts.keepNewlines !== false;
    let text = String(value == null ? "" : value);
    text = text.replace(/\r\n?/g, "\n");
    text = text.replace(CONTROL, "").replace(BIDI, "");
    text = text.replace(/\u00a0|\u202f/g, " ");
    text = keepNewlines ? text : text.replace(/\n/g, " ");
    text = text
      .split("\n")
      .map((line) => line.replace(/[ \t]+$/g, ""))
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .replace(/[ \t]{2,}/g, " ")
      .trim();
    const max = opts.maxChars;
    if (typeof max === "number" && text.length > max) {
      text = text.slice(0, Math.max(0, max - 1)).replace(/\s+$/g, "") + "\u2026";
    }
    return text;
  }

  function hasTranslatable(text) {
    return /[\p{L}\p{N}]/u.test(text || "");
  }

  // FNV-1a 32-bit, stable and cheap; used only for local cache keys.
  function hash(text) {
    let h = 0x811c9dc5;
    const value = String(text || "");
    for (let i = 0; i < value.length; i += 1) {
      h ^= value.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(16).padStart(8, "0");
  }

  LB.sanitize = { clean, hasTranslatable, hash };
})();
