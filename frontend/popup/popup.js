(() => {
  const DEFAULTS = {
    enabled: true,
    targetLanguage: "en",
    contextTurns: 5,
    backendUrl: "http://127.0.0.1:8787",
    showTone: true,
    showCulturalNote: true,
    onboardingDone: false
  };

  // Kept in sync with backend/app/languages.py.
  const LANGUAGES = [
    ["en", "English"],
    ["es", "Spanish"],
    ["pt", "Portuguese"],
    ["pt-BR", "Brazilian Portuguese"],
    ["fr", "French"],
    ["de", "German"],
    ["it", "Italian"],
    ["nl", "Dutch"],
    ["ru", "Russian"],
    ["uk", "Ukrainian"],
    ["pl", "Polish"],
    ["cs", "Czech"],
    ["sk", "Slovak"],
    ["ro", "Romanian"],
    ["hu", "Hungarian"],
    ["el", "Greek"],
    ["tr", "Turkish"],
    ["ar", "Arabic"],
    ["he", "Hebrew"],
    ["fa", "Persian"],
    ["ur", "Urdu"],
    ["hi", "Hindi"],
    ["bn", "Bengali"],
    ["ta", "Tamil"],
    ["te", "Telugu"],
    ["mr", "Marathi"],
    ["gu", "Gujarati"],
    ["pa", "Punjabi"],
    ["th", "Thai"],
    ["vi", "Vietnamese"],
    ["id", "Indonesian"],
    ["ms", "Malay"],
    ["tl", "Filipino"],
    ["zh", "Chinese (Simplified)"],
    ["zh-TW", "Chinese (Traditional)"],
    ["ja", "Japanese"],
    ["ko", "Korean"],
    ["sv", "Swedish"],
    ["no", "Norwegian"],
    ["da", "Danish"],
    ["fi", "Finnish"],
    ["et", "Estonian"],
    ["lv", "Latvian"],
    ["lt", "Lithuanian"],
    ["sr", "Serbian"],
    ["hr", "Croatian"],
    ["bg", "Bulgarian"],
    ["ca", "Catalan"],
    ["eu", "Basque"],
    ["gl", "Galician"],
    ["sw", "Swahili"],
    ["af", "Afrikaans"],
    ["am", "Amharic"],
    ["yo", "Yoruba"],
    ["ha", "Hausa"],
    ["zu", "Zulu"],
    ["sq", "Albanian"],
    ["mk", "Macedonian"],
    ["sl", "Slovenian"],
    ["is", "Icelandic"],
    ["ga", "Irish"],
    ["cy", "Welsh"],
    ["az", "Azerbaijani"],
    ["kk", "Kazakh"],
    ["uz", "Uzbek"],
    ["hy", "Armenian"],
    ["ka", "Georgian"],
    ["ne", "Nepali"],
    ["si", "Sinhala"],
    ["km", "Khmer"],
    ["lo", "Lao"],
    ["my", "Burmese"],
    ["mn", "Mongolian"]
  ];

  const $ = (id) => document.getElementById(id);

  function setStatus(text, kind) {
    const status = $("status");
    status.textContent = text || "";
    status.dataset.kind = kind || "";
  }

  function populateLanguages(selected) {
    const select = $("targetLanguage");
    select.textContent = "";
    const known = new Set();
    for (const [code, name] of LANGUAGES) {
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
    select.value = selected || "en";
  }

  function isValidHttpUrl(value) {
    try {
      const url = new URL(value);
      return url.protocol === "http:" || url.protocol === "https:";
    } catch (_error) {
      return false;
    }
  }

  function readForm() {
    const backendUrl = $("backendUrl").value.trim().replace(/\/+$/, "");
    const turns = Number($("contextTurns").value);
    return {
      enabled: $("enabled").checked,
      targetLanguage: $("targetLanguage").value,
      contextTurns: Number.isFinite(turns) ? Math.min(5, Math.max(3, turns)) : 5,
      backendUrl,
      showTone: $("showTone").checked,
      showCulturalNote: $("showCulturalNote").checked
    };
  }

  function fillForm(settings) {
    $("enabled").checked = settings.enabled !== false;
    populateLanguages(settings.targetLanguage);
    $("welcome").hidden = settings.onboardingDone === true;
    const turns = Number(settings.contextTurns);
    $("contextTurns").value = String(
      Number.isFinite(turns) ? Math.min(5, Math.max(3, turns)) : 5
    );
    $("backendUrl").value = settings.backendUrl || DEFAULTS.backendUrl;
    $("showTone").checked = settings.showTone !== false;
    $("showCulturalNote").checked = settings.showCulturalNote !== false;
  }

  async function save() {
    const settings = readForm();
    if (!isValidHttpUrl(settings.backendUrl)) {
      setStatus("Backend URL must start with http:// or https://.", "err");
      $("backendUrl").focus();
      return;
    }
    await chrome.storage.sync.set({ ...settings, onboardingDone: true });
    $("welcome").hidden = true;
    setStatus("Saved. Open or refresh Telegram Web.", "ok");
  }

  async function saveLanguage() {
    const select = $("targetLanguage");
    const targetLanguage = select.value;
    await chrome.storage.sync.set({ targetLanguage, onboardingDone: true });
    $("welcome").hidden = true;
    const name = select.selectedOptions[0]?.textContent || targetLanguage;
    setStatus(`Saved. Translated messages will be shown in ${name}.`, "ok");
  }

  async function testConnection() {
    const backendUrl = $("backendUrl").value.trim().replace(/\/+$/, "");
    if (!isValidHttpUrl(backendUrl)) {
      setStatus("Enter a valid http(s) backend URL first.", "err");
      return;
    }
    setStatus("Checking backend and model…", "");
    $("test").disabled = true;
    try {
      const response = await new Promise((resolve) => {
        chrome.runtime.sendMessage(
          { type: "LB_PING", payload: { backendUrl } },
          (reply) => {
            const error = chrome.runtime.lastError;
            if (error) resolve({ ok: false, error: { message: error.message } });
            else resolve(reply || { ok: false, error: { message: "No response." } });
          }
        );
      });

      if (!response.ok) {
        setStatus(response.error?.message || "Could not reach the backend.", "err");
        return;
      }
      const data = response.data || {};
      const llm = data.llm || {};
      if (llm.model_present) {
        setStatus(`Connected · ${data.model || "model"} ready (${data.mode || "?"}).`, "ok");
      } else if (llm.ollama === "down") {
        setStatus(
          "Backend is up, but Ollama is not reachable. Start it with `ollama serve`.",
          "warn"
        );
      } else {
        setStatus(
          llm.hint || "Backend is up, but the configured model is not pulled.",
          "warn"
        );
      }
    } finally {
      $("test").disabled = false;
    }
  }

  async function clearCache() {
    const response = await new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: "LB_CLEAR_CACHE" }, (reply) => {
        const error = chrome.runtime.lastError;
        if (error) resolve({ ok: false });
        else resolve(reply || { ok: false });
      });
    });
    setStatus(response.ok ? "Translation cache cleared." : "Could not clear the cache.", response.ok ? "ok" : "err");
  }

  async function init() {
    const stored = await chrome.storage.sync.get(DEFAULTS);
    fillForm({ ...DEFAULTS, ...stored });

    const isFirstRunPage = new URLSearchParams(location.search).get("welcome") === "1";
    if (isFirstRunPage) {
      document.body.classList.add("as-page");
      $("welcome").hidden = false;
      $("targetLanguage").focus();
    }

    $("save").addEventListener("click", save);
    $("targetLanguage").addEventListener("change", saveLanguage);
    $("test").addEventListener("click", testConnection);
    $("clearCache").addEventListener("click", clearCache);
    $("backendUrl").addEventListener("keydown", (event) => {
      if (event.key === "Enter") save();
    });
  }

  document.addEventListener("DOMContentLoaded", init);
})();
