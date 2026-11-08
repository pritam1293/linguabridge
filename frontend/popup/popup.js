(() => {
  const DEFAULTS = {
    telegramEnabled: true,
    whatsappEnabled: true,
    targetLanguage: "en",
    contextTurns: 5,
    onboardingDone: false
  };

  // Shared with the text translator; kept in sync with backend/app/languages.py.
  const LANGUAGES = (globalThis.LB && globalThis.LB.languages.all) || [];

  const $ = (id) => document.getElementById(id);

  let selectedCode = DEFAULTS.targetLanguage;
  let activeIndex = 0;

  function setStatus(text, kind) {
    const status = $("status");
    status.textContent = text || "";
    status.dataset.kind = kind || "";
  }

  function languageLabel(code) {
    return globalThis.LB && globalThis.LB.languages
      ? globalThis.LB.languages.label(code)
      : code || "";
  }

  function updateTrigger() {
    $("languageTriggerText").textContent = languageLabel(selectedCode);
  }

  function options() {
    return [...$("languageList").querySelectorAll(".combobox__option")];
  }

  function refreshActive() {
    const items = options();
    items.forEach((item, index) => {
      item.classList.toggle("is-active", index === activeIndex);
    });
    const active = items[activeIndex];
    if (active) active.scrollIntoView({ block: "nearest" });
  }

  function matchesLanguage(code, name, needle) {
    if (!needle) return true;
    const lowerName = name.toLowerCase();
    const lowerCode = code.toLowerCase();
    if (lowerName.startsWith(needle) || lowerCode.startsWith(needle)) return true;
    // Match the start of any word so "hin" finds Hindi/Hinglish but not "Chinese".
    const words = (value) => value.split(/[^a-z0-9]+/).filter(Boolean);
    return (
      words(lowerName).some((word) => word.startsWith(needle)) ||
      words(lowerCode).some((word) => word.startsWith(needle))
    );
  }

  function renderLanguages(query) {
    const list = $("languageList");
    const empty = $("languageEmpty");
    const needle = String(query || "").trim().toLowerCase();
    list.textContent = "";

    const matches = LANGUAGES.filter(
      ([code, name]) => matchesLanguage(code, name, needle)
    );

    // Keep an unknown stored code selectable instead of silently dropping it.
    if (
      !needle &&
      selectedCode &&
      !LANGUAGES.some(([code]) => code === selectedCode)
    ) {
      matches.unshift([selectedCode, selectedCode]);
    }

    for (const [code, name] of matches) {
      const item = document.createElement("li");
      item.className = "combobox__option";
      item.setAttribute("role", "option");
      item.dataset.code = code;
      item.setAttribute("aria-selected", code === selectedCode ? "true" : "false");
      item.classList.toggle("is-selected", code === selectedCode);

      const label = document.createElement("span");
      label.className = "combobox__name";
      label.textContent = name;

      const codeTag = document.createElement("span");
      codeTag.className = "combobox__code";
      codeTag.textContent = code;

      const check = document.createElement("span");
      check.className = "combobox__check";
      check.setAttribute("aria-hidden", "true");
      check.textContent = "✓";

      item.append(label, codeTag, check);
      item.addEventListener("click", () => chooseLanguage(code));
      list.appendChild(item);
    }

    empty.hidden = matches.length > 0;
    const selectedIndex = matches.findIndex(([code]) => code === selectedCode);
    activeIndex = selectedIndex >= 0 ? selectedIndex : 0;
    refreshActive();
  }

  function openMenu() {
    const menu = $("languageMenu");
    if (!menu.hidden) return;
    menu.hidden = false;
    $("languageCombobox").classList.add("is-open");
    $("languageTrigger").setAttribute("aria-expanded", "true");
    $("languageSearch").value = "";
    renderLanguages("");
    $("languageSearch").focus();
  }

  function closeMenu(focusTrigger) {
    const menu = $("languageMenu");
    if (menu.hidden) return;
    menu.hidden = true;
    $("languageCombobox").classList.remove("is-open");
    $("languageTrigger").setAttribute("aria-expanded", "false");
    if (focusTrigger) $("languageTrigger").focus();
  }

  function moveActive(delta) {
    const items = options();
    if (!items.length) return;
    activeIndex = (activeIndex + delta + items.length) % items.length;
    refreshActive();
  }

  async function chooseLanguage(code) {
    selectedCode = code;
    updateTrigger();
    renderLanguages($("languageSearch").value);
    closeMenu(true);
    await chrome.storage.sync.set({ targetLanguage: code, onboardingDone: true });
    $("welcome").hidden = true;
    setStatus(
      `Saved. Translated messages will be shown in ${languageLabel(code)}.`,
      "ok"
    );
  }

  function readForm() {
    const turns = Number($("contextTurns").value);
    return {
      telegramEnabled: $("telegramEnabled").checked,
      whatsappEnabled: $("whatsappEnabled").checked,
      targetLanguage: selectedCode,
      contextTurns: Number.isFinite(turns) ? Math.min(5, Math.max(3, turns)) : 5
    };
  }

  function fillForm(settings) {
    $("telegramEnabled").checked = settings.telegramEnabled !== false;
    $("whatsappEnabled").checked = settings.whatsappEnabled !== false;
    selectedCode = settings.targetLanguage || DEFAULTS.targetLanguage;
    updateTrigger();
    renderLanguages("");
    $("welcome").hidden = settings.onboardingDone === true;
    const turns = Number(settings.contextTurns);
    $("contextTurns").value = String(
      Number.isFinite(turns) ? Math.min(5, Math.max(3, turns)) : 5
    );
  }

  async function save() {
    const settings = readForm();
    if (!settings.targetLanguage) {
      setStatus("Pick a language first.", "err");
      $("languageTrigger").focus();
      return;
    }
    await chrome.storage.sync.set({ ...settings, onboardingDone: true });
    $("welcome").hidden = true;
    setStatus("Saved. Open or refresh Telegram or WhatsApp Web.", "ok");
    // The toolbar popup should dismiss after an explicit save. Extension pages
    // opened in a tab simply ignore/allow this depending on the browser.
    window.close();
  }

  async function savePlatformToggles() {
    await chrome.storage.sync.set({
      telegramEnabled: $("telegramEnabled").checked,
      whatsappEnabled: $("whatsappEnabled").checked
    });
    setStatus("Saved. Open or refresh Telegram or WhatsApp Web.", "ok");
  }

  async function testConnection() {
    setStatus("Checking connection…", "");
    $("test").disabled = true;
    try {
      const response = await new Promise((resolve) => {
        chrome.runtime.sendMessage({ type: "LB_PING" }, (reply) => {
          const error = chrome.runtime.lastError;
          if (error) resolve({ ok: false, error: { code: "extension_error" } });
          else resolve(reply || { ok: false, error: { code: "no_response" } });
        });
      });

      if (!response.ok) {
        setStatus(
          "Couldn't connect to the translation service. Please try again.",
          "err"
        );
        return;
      }

      const llm = (response.data && response.data.llm) || {};
      if (llm.model_present) {
        setStatus("Translation service is ready.", "ok");
      } else {
        setStatus(
          "Translation is temporarily unavailable. Please try again later.",
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
    const stored = await chrome.storage.sync.get(null);
    const legacyEnabled = stored.enabled !== false;
    const settings = { ...DEFAULTS, ...stored };
    if (typeof stored.telegramEnabled !== "boolean") {
      settings.telegramEnabled = legacyEnabled;
    }
    if (typeof stored.whatsappEnabled !== "boolean") {
      settings.whatsappEnabled = legacyEnabled;
    }
    fillForm(settings);

    const isFirstRunPage = new URLSearchParams(location.search).get("welcome") === "1";
    if (isFirstRunPage) {
      document.body.classList.add("as-page");
      $("welcome").hidden = false;
      $("languageTrigger").focus();
    }

    $("save").addEventListener("click", save);
    $("test").addEventListener("click", testConnection);
    $("clearCache").addEventListener("click", clearCache);
    $("telegramEnabled").addEventListener("change", savePlatformToggles);
    $("whatsappEnabled").addEventListener("change", savePlatformToggles);
    $("openTranslator").addEventListener("click", () => {
      chrome.tabs.create({ url: chrome.runtime.getURL("translator/translator.html") });
      window.close();
    });

    const trigger = $("languageTrigger");
    const search = $("languageSearch");
    const combobox = $("languageCombobox");

    trigger.addEventListener("click", () => {
      if ($("languageMenu").hidden) openMenu();
      else closeMenu(true);
    });

    trigger.addEventListener("keydown", (event) => {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        openMenu();
      } else if (event.key === "Escape") {
        closeMenu(false);
      }
    });

    search.addEventListener("input", () => renderLanguages(search.value));

    search.addEventListener("keydown", (event) => {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        moveActive(1);
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        moveActive(-1);
      } else if (event.key === "Enter") {
        event.preventDefault();
        const items = options();
        const item = items[activeIndex] || items[0];
        if (item) item.click();
      } else if (event.key === "Escape") {
        event.preventDefault();
        closeMenu(true);
      }
    });

    document.addEventListener("pointerdown", (event) => {
      if (!combobox.contains(event.target)) closeMenu(false);
    });

    // Close when keyboard focus leaves the combobox entirely (e.g. Tab to Save).
    // relatedTarget is null for non-focusable clicks inside the menu; those are
    // handled by the option's click handler.
    combobox.addEventListener("focusout", (event) => {
      if (event.relatedTarget && !combobox.contains(event.relatedTarget)) {
        closeMenu(false);
      }
    });
  }

  document.addEventListener("DOMContentLoaded", init);
})();
