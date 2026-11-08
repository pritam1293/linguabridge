/* Content-script entry point: adapter detection, observation, click handling. */
(() => {
  const LB = globalThis.LB;
  if (!LB || !LB.registry) return;

  const adapter = LB.registry.detect();
  if (!adapter) {
    console.info("[LinguaBridge] Chat message list not detected; idle.");
    return;
  }

  const platform = adapter.platform === "whatsapp" ? "whatsapp" : "telegram";
  const DEFAULT_SETTINGS = {
    telegramEnabled: true,
    whatsappEnabled: true,
    targetLanguage: "en",
    contextTurns: 5,
    backendUrl: "http://127.0.0.1:8787"
  };

  function platformEnabled() {
    return platform === "whatsapp"
      ? settings.whatsappEnabled !== false
      : settings.telegramEnabled !== false;
  }

  let settings = { ...DEFAULT_SETTINGS };
  let enabled = true;
  let timer = null;
  let lastReconcile = 0;
  let observer = null;
  let interval = null;
  let stopped = false;

  // Reloading/updating the unpacked extension leaves content scripts from the
  // old context in already-open tabs. Chrome then throws "Extension context
  // invalidated" on the next runtime call. Detect it once, remove our UI and
  // shut down quietly; a tab refresh injects the new content script.
  function extensionAlive() {
    try {
      return Boolean(chrome && chrome.runtime && chrome.runtime.id);
    } catch (_error) {
      return false;
    }
  }

  function stopForInvalidContext() {
    if (stopped) return;
    stopped = true;
    enabled = false;
    if (timer) {
      window.clearTimeout(timer);
      timer = null;
    }
    if (observer) {
      observer.disconnect();
      observer = null;
    }
    if (interval) {
      window.clearInterval(interval);
      interval = null;
    }
    LB.ui.clearAll();
    console.info(
      "[LinguaBridge] Extension was reloaded or updated; refresh this tab to reactivate translation."
    );
  }

  function safeListen(getEvent, handler) {
    try {
      getEvent().addListener(handler);
    } catch (_error) {
      stopForInvalidContext();
    }
  }

  function invalidContextResponse(response) {
    const message = response && response.error && response.error.message;
    return typeof message === "string" && /extension context invalidated/i.test(message);
  }

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
    LB.ui.clearUi(bubble);
  }

  function schedule(delay) {
    if (stopped || timer) return;
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
    if (stopped || !enabled) return;
    if (!extensionAlive()) {
      stopForInvalidContext();
      return;
    }
    const now = performance.now();
    if (now - lastReconcile < 40) return;
    lastReconcile = now;

    LB.ui.pruneBadges();

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
      const existing = LB.ui.findBadge(bubble);
      if (existing) {
        // Edited message: discard the stale badge/translation.
        if (existing.dataset.lbTextHash === textHash) continue;
        removeUi(bubble);
      }

      const badge = LB.ui.attachBadge(
        bubble,
        { textHash, messageId },
        () => activate(element, bubble, badge),
        { placement: adapter.badgePlacement }
      );
      if (!badge) continue;

      const cached = translationCache.get(cacheKey(messageId, textHash));
      if (cached) {
        // The user has translated this message before. Mark the badge as done,
        // but do not open the panel: translation stays opt-in after re-renders.
        LB.ui.setBadgeState(badge, "done");
      }
    }
  }

  async function activate(owner, bubble, badge) {
    if (stopped || !enabled || !bubble || !bubble.isConnected) return;
    if (!extensionAlive()) {
      stopForInvalidContext();
      return;
    }

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
      message_id: messageId,
      platform
    };

    LB.ui.setBadgeState(badge, "loading");
    LB.ui.showLoading(bubble);
    const response = await LB.messaging.translate(payload);
    if (invalidContextResponse(response) || !extensionAlive()) {
      stopForInvalidContext();
      return;
    }
    const ok = Boolean(response && response.ok && response.data);
    // Cache before the detached-row check: virtualised message rows often
    // detach mid-request, and the result should survive the re-render.
    if (ok) remember(key, response.data);
    // Permission may have been turned off while the request was in flight.
    if (!enabled) return;
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
          if (node.closest && node.closest("[data-lb-ui]")) {
            // Our own UI mutations are ignored, except when the page removed a
            // sibling-mounted badge but left its bubble in place: re-attach it
            // promptly instead of waiting for the periodic safety net.
            if (node.matches && node.matches('[data-lb-ui="badge"]')) {
              const bubble = node.__lbBubble;
              if (bubble && bubble.isConnected) {
                schedule();
                return;
              }
            }
            continue;
          }
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
    if (invalidContextResponse(response)) {
      stopForInvalidContext();
      return;
    }
    if (response && response.ok && response.data) {
      settings = { ...DEFAULT_SETTINGS, ...response.data };
    }
    enabled = platformEnabled();
  }

  async function boot() {
    await refreshSettings();
    if (stopped || !extensionAlive()) {
      stopForInvalidContext();
      return;
    }
    startObserver();
    schedule(60);

    // One-shot diagnostic for WhatsApp, whose markup changes often. It appears
    // once per page load and helps narrow down selector regressions.
    if (platform === "whatsapp") {
      window.setTimeout(() => {
        if (stopped) return;
        let root = null;
        let count = 0;
        try {
          root = adapter.getRoot();
          count = adapter.getMessages().length;
        } catch (_error) {
          // Ignore; the log below still reports the failure state.
        }
        console.info(
          `[LinguaBridge] WhatsApp adapter: ${count} message(s) detected, root ${
            root ? root.tagName.toLowerCase() + (root.id ? `#${root.id}` : "") : "not found"
          }, switch ${enabled ? "on" : "off"}.`
        );
      }, 4000);
    }

    // Safety net for virtualised lists and missed mutations.
    interval = window.setInterval(() => {
      if (enabled && document.visibilityState === "visible") schedule(10);
    }, 5000);

    window.addEventListener("hashchange", () => schedule(250));
    window.addEventListener("popstate", () => schedule(250));
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") schedule(100);
    });

    safeListen(() => chrome.storage.onChanged, async (_changes, area) => {
      if (area !== "sync") return;
      await refreshSettings();
      LB.ui.clearAll();
      if (enabled) schedule(60);
    });

    safeListen(() => chrome.runtime.onMessage, (message) => {
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
