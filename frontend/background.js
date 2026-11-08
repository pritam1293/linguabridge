/* MV3 service worker: settings, HTTP, retry, dedupe and cache.
 *
 * Content scripts cannot reliably fetch http://127.0.0.1 because they inherit
 * the page's CORS rules. This worker has host_permissions for the local
 * backend and is the only place that talks to it.
 */
(() => {
  const DEFAULT_SETTINGS = {
    telegramEnabled: true,
    whatsappEnabled: true,
    targetLanguage: "en",
    contextTurns: 5,
    backendUrl: "http://127.0.0.1:8787"
  };

  const CACHE_PREFIX = "lb_cache:";
  const CACHE_TTL_MS = 60 * 60 * 1000;
  const MAX_CACHE_ENTRIES = 200;
  const REQUEST_TIMEOUT_MS = 90_000;
  const inflight = new Map();

  function normalizeSettings(raw) {
    const source = raw || {};
    // Before per-site toggles there was one global `enabled` flag. Migrate it
    // to both sites unless the user already has an explicit per-site value.
    const legacyEnabled = source.enabled !== false;
    const value = { ...DEFAULT_SETTINGS, ...source };
    value.telegramEnabled =
      typeof source.telegramEnabled === "boolean"
        ? source.telegramEnabled
        : legacyEnabled;
    value.whatsappEnabled =
      typeof source.whatsappEnabled === "boolean"
        ? source.whatsappEnabled
        : legacyEnabled;
    delete value.enabled;
    value.targetLanguage =
      typeof value.targetLanguage === "string" && value.targetLanguage.trim()
        ? value.targetLanguage.trim().slice(0, 40)
        : DEFAULT_SETTINGS.targetLanguage;
    const turns = Number(value.contextTurns);
    value.contextTurns = Number.isFinite(turns)
      ? Math.min(8, Math.max(1, Math.round(turns)))
      : DEFAULT_SETTINGS.contextTurns;
    value.backendUrl =
      typeof value.backendUrl === "string" && value.backendUrl.trim()
        ? normalizeUrl(value.backendUrl)
        : DEFAULT_SETTINGS.backendUrl;
    return value;
  }

  function normalizeUrl(value) {
    return String(value).trim().replace(/\/+$/, "");
  }

  function isHttpUrl(value) {
    try {
      const url = new URL(value);
      return url.protocol === "http:" || url.protocol === "https:";
    } catch (_error) {
      return false;
    }
  }

  async function getSettings() {
    const stored = await chrome.storage.sync.get(null);
    const settings = normalizeSettings(stored);
    const patch = {};
    if (typeof stored.telegramEnabled !== "boolean") {
      patch.telegramEnabled = settings.telegramEnabled;
    }
    if (typeof stored.whatsappEnabled !== "boolean") {
      patch.whatsappEnabled = settings.whatsappEnabled;
    }
    if (Object.keys(patch).length) {
      try {
        await chrome.storage.sync.set(patch);
      } catch (_error) {
        // Keep serving normalised in-memory values even if persistence fails.
      }
    }
    return settings;
  }

  async function seedDefaults() {
    const stored = await chrome.storage.sync.get(null);
    const legacyEnabled = stored.enabled !== false;
    const missing = {};
    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
      if (key in stored) continue;
      missing[key] =
        key === "telegramEnabled" || key === "whatsappEnabled"
          ? legacyEnabled
          : value;
    }
    if (Object.keys(missing).length) await chrome.storage.sync.set(missing);
  }

  async function sha256(text) {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
    return Array.from(new Uint8Array(digest))
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
  }

  // ---------------------------------------------------------------- cache
  async function cacheGet(key) {
    const storageKey = CACHE_PREFIX + key;
    try {
      const result = await chrome.storage.session.get(storageKey);
      const entry = result[storageKey];
      if (!entry) return null;
      if (!entry.expiresAt || Date.now() > entry.expiresAt) {
        await chrome.storage.session.remove(storageKey);
        return null;
      }
      return entry.value;
    } catch (_error) {
      return null;
    }
  }

  async function cacheSet(key, value) {
    const storageKey = CACHE_PREFIX + key;
    try {
      const all = await chrome.storage.session.get(null);
      const keys = Object.keys(all).filter((item) => item.startsWith(CACHE_PREFIX));
      if (keys.length >= MAX_CACHE_ENTRIES) {
        keys.sort((a, b) => (all[a]?.storedAt || 0) - (all[b]?.storedAt || 0));
        const drop = keys.slice(0, Math.max(1, Math.ceil(keys.length * 0.2)));
        await chrome.storage.session.remove(drop);
      }
      await chrome.storage.session.set({
        [storageKey]: {
          value,
          expiresAt: Date.now() + CACHE_TTL_MS,
          storedAt: Date.now()
        }
      });
    } catch (_error) {
      // Storage quota/session availability is best-effort only.
    }
  }

  async function clearCache() {
    try {
      const all = await chrome.storage.session.get(null);
      const keys = Object.keys(all).filter((item) => item.startsWith(CACHE_PREFIX));
      if (keys.length) await chrome.storage.session.remove(keys);
    } catch (_error) {
      // ignore
    }
  }

  // -------------------------------------------------------------- payload
  function buildBody(payload, maxMessageChars = 0) {
    if (!payload || typeof payload !== "object") {
      return { error: { code: "invalid_request", message: "Missing translation payload." } };
    }
    if (typeof payload.message !== "string" || !payload.message.trim()) {
      return { error: { code: "invalid_request", message: "Message text is required." } };
    }
    if (maxMessageChars > 0 && payload.message.length > maxMessageChars) {
      return {
        error: {
          code: "message_too_long",
          message: `Text must be ${maxMessageChars} characters or fewer.`
        }
      };
    }
    if (
      typeof payload.target_language !== "string" ||
      !payload.target_language.trim() ||
      payload.target_language.length > 40
    ) {
      return { error: { code: "invalid_request", message: "A valid target language is required." } };
    }

    const history = Array.isArray(payload.history)
      ? payload.history
          .slice(-8)
          .filter(
            (item) =>
              item &&
              typeof item.text === "string" &&
              item.text.trim() &&
              (item.role === "self" || item.role === "other")
          )
          .map((item) => ({
            role: item.role,
            speaker:
              typeof item.speaker === "string" ? item.speaker.slice(0, 48) : "",
            text: item.text.slice(0, 2000)
          }))
      : [];

    const body = {
      message: payload.message.slice(0, 8000),
      target_language: payload.target_language.trim().slice(0, 40),
      source_language:
        typeof payload.source_language === "string" && payload.source_language.trim()
          ? payload.source_language.trim().slice(0, 40)
          : "auto",
      chat_type: payload.chat_type === "group" ? "group" : "private",
      history
    };
    if (typeof payload.message_id === "string" && payload.message_id) {
      body.message_id = payload.message_id.slice(0, 128);
    }
    return { body };
  }

  // ---------------------------------------------------------------- fetch
  function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function fetchOnce(url, body) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(`${url}/v1/translate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal
      });

      const raw = await response.text();
      let parsed = null;
      try {
        parsed = raw ? JSON.parse(raw) : null;
      } catch (_error) {
        parsed = null;
      }

      if (!response.ok) {
        const detail = (parsed && parsed.error) || {};
        return {
          ok: false,
          retryable: response.status >= 500,
          error: {
            code: detail.code || "backend_error",
            message: "Translation is temporarily unavailable. Please try again.",
            status: response.status,
            retryAfter: response.headers.get("Retry-After") || undefined
          }
        };
      }
      if (!parsed || typeof parsed.translated_text !== "string") {
        return {
          ok: false,
          retryable: true,
          error: {
            code: "invalid_backend_response",
            message: "Something went wrong while translating. Please try again."
          }
        };
      }
      return { ok: true, data: parsed };
    } catch (error) {
      if (error && error.name === "AbortError") {
        return {
          ok: false,
          retryable: false,
          error: {
            code: "backend_timeout",
            message: "Translation took too long. Please try again."
          }
        };
      }
      return {
        ok: false,
        retryable: true,
        error: {
          code: "backend_unreachable",
          message: "Couldn't connect to the translation service. Please try again."
        }
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  async function requestTranslation(settings, body) {
    const url = settings.backendUrl;
    if (!isHttpUrl(url)) {
      return {
        ok: false,
        error: {
          code: "invalid_backend_url",
          message: "The translation service isn't configured correctly. Please try again later."
        }
      };
    }

    let first = await fetchOnce(url, body);
    if (first.ok) return first;
    if (!first.retryable) return first;
    await delay(600);
    first = await fetchOnce(url, body);
    return first;
  }

  function platformFromSender(sender) {
    try {
      const url = new URL(sender && sender.url ? sender.url : "");
      if (/(^|\.)whatsapp\.com$/i.test(url.hostname)) return "whatsapp";
      if (/(^|\.)telegram\.org$/i.test(url.hostname)) return "telegram";
    } catch (_error) {
      // No sender URL (popup/extension page): fall back to the payload hint.
    }
    return "";
  }

  async function handleTranslate(payload, options = {}) {
    const { ignoreEnabled = false, maxMessageChars = 0, platformHint = "" } = options;
    const settings = await getSettings();
    const platform =
      platformHint || (payload && payload.platform === "whatsapp" ? "whatsapp" : "telegram");
    const platformOn =
      platform === "whatsapp" ? settings.whatsappEnabled : settings.telegramEnabled;
    if (!ignoreEnabled && !platformOn) {
      return {
        ok: false,
        error: {
          code: "disabled",
          message:
            platform === "whatsapp"
              ? "LinguaBridge is turned off for WhatsApp."
              : "LinguaBridge is turned off for Telegram."
        }
      };
    }

    const built = buildBody(payload, maxMessageChars);
    if (built.error) return { ok: false, error: built.error };

    const key = await sha256(JSON.stringify({ url: settings.backendUrl, body: built.body }));
    const cached = await cacheGet(key);
    if (cached) {
      return {
        ok: true,
        data: {
          ...cached,
          meta: { ...(cached.meta || {}), cached: true, latency_ms: 0 }
        }
      };
    }

    if (inflight.has(key)) return inflight.get(key);

    const promise = (async () => {
      const result = await requestTranslation(settings, built.body);
      if (result.ok && result.data) await cacheSet(key, result.data);
      return result;
    })();

    inflight.set(key, promise);
    try {
      return await promise;
    } finally {
      inflight.delete(key);
    }
  }

  async function handlePing(payload) {
    const settings = await getSettings();
    const raw =
      payload && typeof payload.backendUrl === "string" && payload.backendUrl.trim()
        ? payload.backendUrl.trim()
        : settings.backendUrl;
    const url = normalizeUrl(raw);
    if (!isHttpUrl(url)) {
      return {
        ok: false,
        error: { code: "invalid_backend_url", message: "The translation service address isn't valid." }
      };
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    try {
      const response = await fetch(`${url}/health/deep`, { signal: controller.signal });
      let data = null;
      try {
        data = await response.json();
      } catch (_error) {
        data = null;
      }
      if (!response.ok || !data) {
        return {
          ok: false,
          error: {
            code: "backend_error",
            message: "The translation service is temporarily unavailable. Please try again.",
            status: response.status
          }
        };
      }
      return { ok: true, data };
    } catch (error) {
      const aborted = error && error.name === "AbortError";
      return {
        ok: false,
        error: {
          code: aborted ? "backend_timeout" : "backend_unreachable",
          message: aborted
            ? "The translation service didn't respond. Please try again."
            : "Couldn't connect to the translation service. Please try again."
        }
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  function respond(promise, sendResponse) {
    promise
      .then(sendResponse)
      .catch(() =>
        sendResponse({
          ok: false,
          error: { code: "internal_error", message: "Something went wrong. Please try again." }
        })
      );
  }

  chrome.runtime.onInstalled.addListener((details) => {
    seedDefaults();
    // First install: open the settings page so the user is asked which
    // language they want to read translations in.
    if (details && details.reason === "install") {
      chrome.tabs.create({ url: chrome.runtime.getURL("popup/popup.html?welcome=1") });
    }
  });

  chrome.runtime.onStartup.addListener(() => {
    seedDefaults();
  });

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || typeof message.type !== "string") return undefined;

    if (message.type === "LB_TRANSLATE") {
      respond(
        handleTranslate(message.payload, {
          platformHint: platformFromSender(sender)
        }),
        sendResponse
      );
      return true;
    }
    if (message.type === "LB_TRANSLATE_TEXT") {
      // The standalone translator works even when both platform switches are
      // off, and enforces a short input so the backend never receives a long text.
      respond(
        handleTranslate(message.payload, { ignoreEnabled: true, maxMessageChars: 250 }),
        sendResponse
      );
      return true;
    }
    if (message.type === "LB_GET_SETTINGS") {
      respond(
        getSettings().then((data) => ({ ok: true, data })),
        sendResponse
      );
      return true;
    }
    if (message.type === "LB_PING") {
      respond(handlePing(message.payload), sendResponse);
      return true;
    }
    if (message.type === "LB_CLEAR_CACHE") {
      respond(clearCache().then(() => ({ ok: true, data: { cleared: true } })), sendResponse);
      return true;
    }
    return undefined;
  });
})();
