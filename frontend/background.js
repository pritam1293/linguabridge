/* MV3 service worker: settings, HTTP, retry, dedupe and cache.
 *
 * Content scripts cannot reliably fetch http://127.0.0.1 because they inherit
 * the page's CORS rules. This worker has host_permissions for the local
 * backend and is the only place that talks to it.
 */
(() => {
  const DEFAULT_SETTINGS = {
    enabled: true,
    targetLanguage: "en",
    contextTurns: 5,
    backendUrl: "http://127.0.0.1:8787",
    showTone: true,
    showCulturalNote: true
  };

  const CACHE_PREFIX = "lb_cache:";
  const CACHE_TTL_MS = 60 * 60 * 1000;
  const MAX_CACHE_ENTRIES = 200;
  const REQUEST_TIMEOUT_MS = 90_000;
  const inflight = new Map();

  function normalizeSettings(raw) {
    const value = { ...DEFAULT_SETTINGS, ...(raw || {}) };
    value.enabled = value.enabled !== false;
    value.showTone = value.showTone !== false;
    value.showCulturalNote = value.showCulturalNote !== false;
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
    const stored = await chrome.storage.sync.get(DEFAULT_SETTINGS);
    return normalizeSettings(stored);
  }

  async function seedDefaults() {
    const stored = await chrome.storage.sync.get(null);
    const missing = {};
    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
      if (!(key in stored)) missing[key] = value;
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
  function buildBody(payload) {
    if (!payload || typeof payload !== "object") {
      return { error: { code: "invalid_request", message: "Missing translation payload." } };
    }
    if (typeof payload.message !== "string" || !payload.message.trim()) {
      return { error: { code: "invalid_request", message: "Message text is required." } };
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
            message: detail.message || `Backend returned HTTP ${response.status}.`,
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
            message: "The backend returned an unexpected response."
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
            message: `The backend did not answer within ${Math.round(REQUEST_TIMEOUT_MS / 1000)}s.`
          }
        };
      }
      return {
        ok: false,
        retryable: true,
        error: {
          code: "backend_unreachable",
          message: `Could not reach ${url}. Is the LinguaBridge backend running?`
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
          message: "The backend URL in settings is not a valid http(s) URL."
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

  async function handleTranslate(payload) {
    const settings = await getSettings();
    if (!settings.enabled) {
      return { ok: false, error: { code: "disabled", message: "LinguaBridge is turned off." } };
    }

    const built = buildBody(payload);
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
        error: { code: "invalid_backend_url", message: "Enter a valid http(s) backend URL." }
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
            message: `Backend returned HTTP ${response.status}.`,
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
            ? "The backend did not answer within 5s."
            : `Could not reach ${url}. Start the backend with backend/run.sh.`
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
          error: { code: "internal_error", message: "Unexpected extension error." }
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

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || typeof message.type !== "string") return undefined;

    if (message.type === "LB_TRANSLATE") {
      respond(handleTranslate(message.payload), sendResponse);
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
