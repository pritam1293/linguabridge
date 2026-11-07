/* Content-script entry point: adapter detection, observation, click handling. */
(() => {
  const LB = globalThis.LB;
  if (!LB || !LB.registry) return;

  const adapter = LB.registry.detect();
  if (!adapter) {
    console.info("[LinguaBridge] Telegram message list not detected; idle.");
    return;
  }

  const DEFAULT_SETTINGS = {
    enabled: true,
    targetLanguage: "en",
    contextTurns: 5,
    backendUrl: "http://127.0.0.1:8787"
  };

  let settings = { ...DEFAULT_SETTINGS };
  let enabled = true;
  let timer = null;
  let lastReconcile = 0;
  let observer = null;

  const translationCache = new Map();
  const MAX_LOCAL_CACHE = 100;

  // Telegram reuses message ids across chats, so scope local entries by route.
  function chatScope() {
    return `${window.location.pathname}${window.location.search}${window.location.hash}`;
  }

  function cacheKey(messageId, textHash) {
    return `${chatScope()}|${messageId}|${textHash}|${settings.targetLanguage}`;
  }

  function remember(key, value) {
    translationCache.delete(key);
    translationCache.set(key, value);
    while (translationCache.size > MAX_LOCAL_CACHE) {
      translationCache.delete(translationCache.keys().next().value);
    }
  }

  function removeUi(bubble) {
    if (!bubble) return;
    bubble.querySelectorAll(':scope > [data-lb-ui]').forEach((node) => node.remove());
  }

  function schedule(delay) {
    if (timer) return;
    timer = window.setTimeout(() => {
      timer = null;
      reconcile();
    }, typeof delay === "number" ? delay : 140);
  }

  function resolveOwner(messageId, fallback) {
    if (!messageId) return fallback;
    const found = adapter.getMessages().find((element) => adapter.getMessageId(element) === messageId);
    return found || fallback;
  }

  function reconcile() {
    if (!enabled) return;
    const now = performance.now();
    if (now - lastReconcile < 40) return;
    lastReconcile = now;

    let messages;
    try {
      messages = adapter.getMessages();
    } catch (_error) {
      return;
    }

    for (const element of messages) {
      if (!element.isConnected) continue;
      const bubble = adapter.getBubble(element);
      if (!bubble || !bubble.isConnected) continue;

      // Product decision: badges appear on incoming messages only.
      if (adapter.isOutgoing(element)) {
        removeUi(bubble);
        continue;
      }

      const text = adapter.getMessageText(element);
      if (!text || !LB.sanitize.hasTranslatable(text)) {
        removeUi(bubble);
        continue;
      }

      const textHash = LB.sanitize.hash(text);
      const messageId = adapter.getMessageId(element) || `t:${textHash}`;
      const existing = bubble.querySelector(':scope > [data-lb-ui="badge"]');
      if (existing) {
        // Edited message: discard the stale badge/translation.
        if (existing.dataset.lbTextHash === textHash) continue;
        removeUi(bubble);
      }

      const badge = LB.ui.attachBadge(
        bubble,
        { textHash, messageId },
        () => activate(element, bubble, badge)
      );

      const cached = translationCache.get(cacheKey(messageId, textHash));
      if (cached) {
        // The user has translated this message before. Mark the badge as done,
        // but do not open the panel: translation stays opt-in after re-renders.
        LB.ui.setBadgeState(badge, "done");
      }
    }
  }

  async function activate(owner, bubble, badge) {
    if (!enabled || !bubble || !bubble.isConnected) return;

    // Badge doubles as a toggle: clicking while a result is open closes it.
    if (bubble.querySelector(':scope > [data-lb-ui="panel"]')) {
      LB.ui.clearPanels(bubble);
      LB.ui.setBadgeState(badge, "idle");
      return;
    }

    const current = resolveOwner(adapter.getMessageId(owner), owner);
    const text = adapter.getMessageText(current);
    if (!text || !LB.sanitize.hasTranslatable(text)) return;

    const textHash = LB.sanitize.hash(text);
    const messageId = adapter.getMessageId(current) || `t:${textHash}`;
    const key = cacheKey(messageId, textHash);

    const cached = translationCache.get(key);
    if (cached) {
      LB.ui.showPanel(bubble, cached);
      LB.ui.setBadgeState(badge, "done");
      return;
    }

    if (badge.host.dataset.lbBusy === "1") return;

    const context = LB.contextWindow.build(adapter, current, {
      turns: settings.contextTurns
    });
    const payload = {
      message: text,
      history: context.history,
      target_language: settings.targetLanguage,
      source_language: "auto",
      chat_type: context.chat_type,
      message_id: messageId
    };

    LB.ui.setBadgeState(badge, "loading");
    LB.ui.showLoading(bubble);
    const response = await LB.messaging.translate(payload);
    const ok = Boolean(response && response.ok && response.data);
    // Cache before the detached-row check: virtualised message rows often
    // detach mid-request, and the result should survive the re-render.
    if (ok) remember(key, response.data);
    if (!bubble.isConnected) return;

    if (ok) {
      LB.ui.showPanel(bubble, response.data);
      LB.ui.setBadgeState(badge, "done");
      return;
    }

    const error =
      response && response.error
        ? response.error
        : { code: "unknown", message: "Translation failed." };
    LB.ui.setBadgeState(badge, "error");
    LB.ui.showError(bubble, error, {
      onRetry: () => activate(current, bubble, badge)
    });
  }

  function startObserver() {
    if (observer || !document.body) return;
    observer = new MutationObserver((mutations) => {
      if (!enabled) return;
      for (const mutation of mutations) {
        if (mutation.type === "characterData") {
          const parent = mutation.target.parentElement || mutation.target;
          const owner = adapter.findOwner(parent);
          if (owner) {
            removeUi(adapter.getBubble(owner));
            schedule();
          }
          continue;
        }
        const nodes = [...mutation.addedNodes, ...mutation.removedNodes];
        for (const node of nodes) {
          if (node.nodeType !== 1) {
            schedule();
            return;
          }
          if (node.closest && node.closest("[data-lb-ui]")) continue;
          schedule();
          return;
        }
      }
    });
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true
    });
  }

  async function refreshSettings() {
    const response = await LB.messaging.getSettings();
    if (response && response.ok && response.data) {
      settings = { ...DEFAULT_SETTINGS, ...response.data };
    }
    enabled = settings.enabled !== false;
  }

  async function boot() {
    await refreshSettings();
    startObserver();
    schedule(60);

    // Safety net for virtualised lists and missed mutations.
    window.setInterval(() => {
      if (enabled && document.visibilityState === "visible") schedule(10);
    }, 5000);

    window.addEventListener("hashchange", () => schedule(250));
    window.addEventListener("popstate", () => schedule(250));
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") schedule(100);
    });

    chrome.storage.onChanged.addListener(async (_changes, area) => {
      if (area !== "sync") return;
      await refreshSettings();
      LB.ui.clearAll();
      if (enabled) schedule(60);
    });

    chrome.runtime.onMessage.addListener((message) => {
      if (message && message.type === "LB_RESCAN") {
        LB.ui.clearAll();
        schedule(40);
      }
    });
  }

  boot().catch((error) => {
    console.warn("[LinguaBridge] boot failed:", error && error.message ? error.message : error);
  });
})();
