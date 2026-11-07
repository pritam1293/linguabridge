/* Standalone 250-character translator page. */
(() => {
  const MAX_CHARS = 250;
  const DEFAULT_TARGET = "en";
  const FALLBACK_ERROR = "Something went wrong while translating. Please try again.";

  const FRIENDLY_ERRORS = {
    message_too_long: `Please keep the text to ${MAX_CHARS} characters or fewer.`,
    backend_unreachable:
      "Couldn't reach the translation server. Make sure the LinguaBridge server is running and try again.",
    backend_timeout:
      "The translation server took too long to respond. Try a shorter text.",
    rate_limited: "Too many requests right now. Wait a moment and try again.",
    invalid_request: "Type some text and choose a language first.",
    disabled: "Translation is turned off in settings."
  };

  const $ = (id) => document.getElementById(id);

  let busy = false;
  let resetCopyTimer = null;

  function setStatus(text, kind) {
    const status = $("status");
    status.textContent = text || "";
    status.dataset.kind = kind || "";
  }

  function updateCounter() {
    const source = $("sourceText");
    const counter = $("counter");
    const length = source.value.length;
    counter.textContent = `${length} / ${MAX_CHARS}`;
    counter.classList.toggle("is-near", length >= MAX_CHARS - 25 && length < MAX_CHARS);
    counter.classList.toggle("is-limit", length >= MAX_CHARS);
    $("translate").disabled = busy || !source.value.trim() || length > MAX_CHARS;
    $("translate").textContent = busy ? "Translating…" : "Translate";
  }

  function populateTarget(selected) {
    const select = $("targetLanguage");
    const entries = (globalThis.LB && globalThis.LB.languages && globalThis.LB.languages.all) || [];
    const known = new Set();
    select.textContent = "";

    for (const [code, name] of entries) {
      known.add(code);
      const option = document.createElement("option");
      option.value = code;
      option.textContent = `${name} (${code})`;
      select.appendChild(option);
    }

    if (selected && !known.has(selected)) {
      const option = document.createElement("option");
      option.value = selected;
      option.textContent = selected;
      select.appendChild(option);
    }

    select.value = selected || DEFAULT_TARGET;
  }

  function friendlyError(error) {
    const code = error && error.code;
    return FRIENDLY_ERRORS[code] || FALLBACK_ERROR;
  }

  function sendMessage(message) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(message, (reply) => {
        const error = chrome.runtime.lastError;
        if (error) resolve({ ok: false, error: { code: "no_response" } });
        else resolve(reply || { ok: false, error: { code: "no_response" } });
      });
    });
  }

  function showResult(data) {
    const resultCard = $("resultCard");
    const resultText = $("resultText");
    const resultMeta = $("resultMeta");
    const meta = data.meta || {};

    resultText.textContent = data.translated_text;
    if (meta.cached) {
      resultMeta.textContent = "Translated instantly (cached)";
    } else if (typeof meta.latency_ms === "number" && meta.latency_ms > 0) {
      resultMeta.textContent = `Translated in ${(meta.latency_ms / 1000).toFixed(1)} seconds`;
    } else {
      resultMeta.textContent = "";
    }

    resultCard.hidden = false;
    resultCard.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }

  async function translateText() {
    if (busy) return;
    const source = $("sourceText");
    const text = source.value.trim();
    if (!text) {
      setStatus("Type something to translate.", "err");
      source.focus();
      return;
    }
    if (source.value.length > MAX_CHARS) {
      setStatus(FRIENDLY_ERRORS.message_too_long, "err");
      return;
    }

    busy = true;
    updateCounter();
    setStatus("Translating…", "");
    $("resultCard").hidden = true;

    const response = await sendMessage({
      type: "LB_TRANSLATE_TEXT",
      payload: {
        message: text,
        target_language: $("targetLanguage").value || DEFAULT_TARGET
      }
    });

    busy = false;
    updateCounter();

    if (!response || !response.ok) {
      setStatus(friendlyError(response && response.error), "err");
      return;
    }

    const data = response.data || {};
    if (typeof data.translated_text !== "string" || !data.translated_text) {
      setStatus(FALLBACK_ERROR, "err");
      return;
    }

    setStatus("", "");
    showResult(data);
  }

  function clearAll() {
    const source = $("sourceText");
    source.value = "";
    $("resultCard").hidden = true;
    $("resultText").textContent = "";
    $("resultMeta").textContent = "";
    setStatus("", "");
    updateCounter();
    source.focus();
  }

  async function copyResult() {
    const text = $("resultText").textContent || "";
    if (!text) return;
    const copy = $("copy");
    try {
      await navigator.clipboard.writeText(text);
      copy.textContent = "Copied";
      clearTimeout(resetCopyTimer);
      resetCopyTimer = setTimeout(() => {
        copy.textContent = "Copy";
      }, 1400);
    } catch (_error) {
      copy.textContent = "Select and copy";
      clearTimeout(resetCopyTimer);
      resetCopyTimer = setTimeout(() => {
        copy.textContent = "Copy";
      }, 1800);
    }
  }

  async function init() {
    let stored = { targetLanguage: DEFAULT_TARGET };
    try {
      stored = await chrome.storage.sync.get({ targetLanguage: DEFAULT_TARGET });
    } catch (_error) {
      // Extension storage can be unavailable in a plain browser tab; the page
      // still works with the default target language.
    }

    populateTarget(stored.targetLanguage || DEFAULT_TARGET);
    updateCounter();

    $("sourceText").addEventListener("input", () => {
      updateCounter();
      const status = $("status");
      if (status.dataset.kind === "err") setStatus("", "");
    });

    $("sourceText").addEventListener("keydown", (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
        event.preventDefault();
        translateText();
      }
    });

    $("translate").addEventListener("click", translateText);
    $("clear").addEventListener("click", clearAll);
    $("copy").addEventListener("click", copyResult);

    $("targetLanguage").addEventListener("change", (event) => {
      chrome.storage.sync.set({ targetLanguage: event.target.value });
    });
  }

  document.addEventListener("DOMContentLoaded", init);
})();
