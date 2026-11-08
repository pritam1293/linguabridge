/* Shadow-DOM badge and translation panel.
 *
 * Shadow DOM keeps Telegram's CSS (button resets, RTL, user-select, etc.) out
 * of our UI and keeps our CSS out of Telegram. All model-provided strings are
 * written with textContent, never innerHTML.
 */
(() => {
  const LB = (globalThis.LB = globalThis.LB || {});

  const ICON = [
    '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">',
    '<path fill="currentColor" opacity=".5" d="M3.5 4.5h9a3 3 0 0 1 3 3v4a3 3 0 0 1-3 3H8l-4.5 3v-3.2A3 3 0 0 1 1 11.5v-4a3 3 0 0 1 3-3Z"/>',
    '<path fill="currentColor" d="M10.5 9.5h9a3 3 0 0 1 3 3v4a3 3 0 0 1-2 2.8V23l-4.5-3h-5.5a3 3 0 0 1-3-3v-4a3 3 0 0 1 3-3Z"/>',
    "</svg>"
  ].join("");

  let stylesPromise = null;

  // The badge is mounted inside the bubble on Telegram, but as a flex sibling
  // before the bubble on WhatsApp (see `placement` in attachBadge). WeakMap
  // keeps the pair together across re-renders without leaking detached rows.
  const badgeByBubble = new WeakMap();

  function getStyles() {
    if (!stylesPromise) {
      // Reloading the unpacked extension invalidates the context of content
      // scripts that are still running in an open tab. getURL() then throws
      // synchronously; fall back to an empty stylesheet instead of spamming
      // the page console (content.js stops the script shortly afterwards).
      let url = "";
      try {
        url = chrome.runtime.getURL("styles.css");
      } catch (_error) {
        stylesPromise = Promise.resolve("");
        return stylesPromise;
      }
      stylesPromise = fetch(url)
        .then((response) => (response.ok ? response.text() : ""))
        .catch(() => "");
    }
    return stylesPromise;
  }

  function isDarkTheme() {
    const roots = [document.documentElement, document.body].filter(Boolean);
    for (const root of roots) {
      const className = root.className;
      if (typeof className === "string" && /(^|\s)(theme-dark|dark|night)(\s|$)/i.test(className)) {
        return true;
      }
    }
    const body = document.body || document.documentElement;
    if (!body) return false;
    const background = getComputedStyle(body).backgroundColor;
    if (/rgba?\(\s*0\s*,\s*0\s*,\s*0\s*,\s*0\s*\)/i.test(background)) {
      return window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
    }
    const parts = background.match(/[\d.]+/g);
    if (!parts || parts.length < 3) return false;
    const [r, g, b] = parts.map(Number);
    return 0.2126 * r + 0.7152 * g + 0.0722 * b < 105;
  }

  function makeHost(className, kind) {
    const host = document.createElement("div");
    host.className = className;
    host.dataset.lbUi = kind;
    host.style.visibility = "hidden";
    host.classList.toggle("lb-dark", isDarkTheme());
    const shadow = host.attachShadow({ mode: "open" });
    getStyles()
      .then((css) => {
        if (!css) return;
        const style = document.createElement("style");
        style.textContent = css;
        shadow.prepend(style);
      })
      .finally(() => {
        host.style.visibility = "";
      });
    return { host, shadow };
  }

  function makeElement(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  }

  function ensurePositioned(bubble) {
    if (!bubble) return;
    if (getComputedStyle(bubble).position !== "static") return;
    if (!bubble.hasAttribute("data-lb-prev-position")) {
      bubble.setAttribute("data-lb-prev-position", bubble.style.position || "");
    }
    bubble.style.position = "relative";
  }

  function clearPanels(bubble) {
    if (!bubble) return;
    bubble.querySelectorAll(':scope > [data-lb-ui="panel"]').forEach((node) => node.remove());
  }

  function cleanupFlexParent(parent) {
    if (!parent || !parent.classList) return;
    if (!parent.querySelector(':scope > [data-lb-ui="badge"]')) {
      parent.classList.remove("lb-badge-row");
    }
  }

  function findBadge(bubble) {
    if (!bubble) return null;
    const tracked = badgeByBubble.get(bubble);
    if (tracked && tracked.host && tracked.host.isConnected) return tracked.host;
    if (tracked) badgeByBubble.delete(bubble);

    // Fallbacks cover badges that survived a re-render outside the WeakMap.
    const inside = bubble.querySelector(':scope > [data-lb-ui="badge"]');
    if (inside) return inside;
    const previous = bubble.previousElementSibling;
    if (previous && previous.matches && previous.matches('[data-lb-ui="badge"]')) return previous;
    return null;
  }

  function removeBadge(bubble) {
    if (!bubble) return;
    const tracked = badgeByBubble.get(bubble);
    badgeByBubble.delete(bubble);
    if (tracked && tracked.host) {
      const parent = tracked.host.parentElement;
      tracked.host.remove();
      cleanupFlexParent(parent);
    }

    const inside = bubble.querySelector(':scope > [data-lb-ui="badge"]');
    if (inside) {
      const parent = inside.parentElement;
      inside.remove();
      cleanupFlexParent(parent);
    }

    const previous = bubble.previousElementSibling;
    if (previous && previous.matches && previous.matches('[data-lb-ui="badge"]')) {
      const parent = previous.parentElement;
      previous.remove();
      cleanupFlexParent(parent);
    }
  }

  function clearUi(bubble) {
    if (!bubble) return;
    removeBadge(bubble);
    clearPanels(bubble);
  }

  function pruneBadges() {
    document.querySelectorAll('[data-lb-ui="badge"]').forEach((host) => {
      const bubble = host.__lbBubble;
      const parent = host.parentElement;
      if (!bubble || !bubble.isConnected) {
        host.remove();
        if (bubble) badgeByBubble.delete(bubble);
        cleanupFlexParent(parent);
        return;
      }
      if (host.dataset.lbMount !== "before") return;
      // The bubble was moved or re-rendered: drop the orphaned sibling and let
      // the next reconcile attach a fresh badge.
      if (bubble.previousElementSibling !== host) {
        host.remove();
        badgeByBubble.delete(bubble);
        cleanupFlexParent(parent);
        return;
      }
      // WhatsApp can rewrite className on the row wrapper.
      if (parent && !parent.classList.contains("lb-badge-row")) {
        parent.classList.add("lb-badge-row");
      }
    });
  }

  function mountBadge(bubble, host, placement) {
    if (placement === "before") {
      const parent = bubble.parentElement;
      if (parent && parent !== document.body && parent !== document.documentElement) {
        parent.insertBefore(host, bubble);
        parent.classList.add("lb-badge-row");
        host.dataset.lbMount = "before";
        host.classList.add("lb-badge-host--before");
        return;
      }
      // No usable row container: keep the badge inside the bubble, on the left.
      ensurePositioned(bubble);
      host.dataset.lbMount = "inside";
      host.classList.add("lb-badge-host--left");
      bubble.appendChild(host);
      return;
    }
    if (placement === "left") {
      // Absolute positioning keeps the badge out of the message flow: page
      // re-renders can remove/re-add it without shifting the bubble text.
      ensurePositioned(bubble);
      host.dataset.lbMount = "inside";
      host.classList.add("lb-badge-host--left");
      bubble.appendChild(host);
      return;
    }
    host.dataset.lbMount = "inside";
    bubble.appendChild(host);
  }

  function isolateEvents(host, onActivate) {
    // WhatsApp opens its context menu / selection on pointer and mouse events.
    // Stop every one of them before they reach the row's delegated handlers.
    const stop = (event) => event.stopPropagation();
    for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup"]) {
      host.addEventListener(type, stop);
    }
    host.addEventListener("touchstart", stop, { passive: true });
    host.addEventListener("touchend", stop, { passive: true });
    host.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      event.stopPropagation();
    });
    host.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (host.dataset.lbBusy === "1") return;
      if (typeof onActivate === "function") onActivate();
    });
  }

  function attachBadge(bubble, meta, onActivate, options) {
    if (!bubble) return null;
    const opts = options || {};
    const placement =
      opts.placement === "before" || opts.placement === "left" ? opts.placement : "inside";

    // An edited message or a re-render can leave a stale badge behind.
    removeBadge(bubble);
    if (placement !== "before") ensurePositioned(bubble);

    const { host, shadow } = makeHost("lb-badge-host", "badge");
    host.dataset.lbTextHash = meta && meta.textHash ? meta.textHash : "";
    host.dataset.lbMessageId = meta && meta.messageId ? meta.messageId : "";
    host.dataset.lbBusy = "0";

    const button = makeElement("button", "lb-badge");
    button.type = "button";
    button.title = "Translate with AI";
    button.setAttribute("aria-label", "Translate this message with AI");
    button.innerHTML = ICON; // static markup only
    shadow.appendChild(button);

    isolateEvents(host, onActivate);
    mountBadge(bubble, host, placement);

    const badge = { host, shadow, button, bubble };
    badgeByBubble.set(bubble, badge);
    host.__lbBubble = bubble;
    return badge;
  }

  function setBadgeState(badge, state) {
    if (!badge || !badge.button) return;
    badge.button.classList.remove("lb-badge--loading", "lb-badge--done", "lb-badge--error");
    if (state === "loading") badge.button.classList.add("lb-badge--loading");
    if (state === "done") badge.button.classList.add("lb-badge--done");
    if (state === "error") badge.button.classList.add("lb-badge--error");
    badge.button.disabled = state === "loading";
    badge.button.setAttribute("aria-busy", state === "loading" ? "true" : "false");
    badge.host.dataset.lbBusy = state === "loading" ? "1" : "0";
  }

  function latencyLine(data) {
    const meta = data.meta || {};
    if (typeof meta.latency_ms !== "number" || !Number.isFinite(meta.latency_ms)) {
      return null;
    }
    const seconds = (meta.latency_ms / 1000).toFixed(1);
    return makeElement("div", "lb-latency", `Translated in ${seconds} seconds`);
  }

  function showPanel(bubble, data) {
    clearPanels(bubble);
    const { host, shadow } = makeHost("lb-panel-host", "panel");
    const panel = makeElement("div", "lb-panel");
    panel.setAttribute("role", "region");
    panel.setAttribute("aria-label", "AI translation");

    const translation = makeElement("p", "lb-translation", data.translated_text || "");
    translation.setAttribute("dir", "auto");
    panel.appendChild(translation);

    const latency = latencyLine(data);
    if (latency) panel.appendChild(latency);

    shadow.appendChild(panel);
    bubble.appendChild(host);
    return host;
  }

  function showLoading(bubble) {
    clearPanels(bubble);
    const { host, shadow } = makeHost("lb-panel-host", "panel");
    const panel = makeElement("div", "lb-panel");
    panel.setAttribute("role", "status");
    panel.setAttribute("aria-busy", "true");
    panel.setAttribute("aria-label", "Translating message");
    const skeleton = makeElement("div", "lb-skeleton");
    skeleton.appendChild(makeElement("span"));
    skeleton.appendChild(makeElement("span"));
    skeleton.appendChild(makeElement("span"));
    panel.appendChild(skeleton);
    shadow.appendChild(panel);
    bubble.appendChild(host);
    return host;
  }

  function friendlyError(error) {
    switch (error && error.code) {
      case "message_too_long":
        return "This message is too long to translate.";
      case "rate_limited":
        return "Too many requests right now. Wait a moment and try again.";
      case "invalid_language":
        return "That language isn't supported. Choose another one.";
      case "disabled":
        return "Translation is turned off for this site.";
      case "backend_unreachable":
      case "llm_unreachable":
      case "llm_transport_error":
        return "Couldn't connect to the translation service. Please try again.";
      case "backend_timeout":
      case "llm_timeout":
        return "Translation took too long. Please try again.";
      case "invalid_backend_url":
      case "invalid_backend_response":
      case "backend_error":
      case "model_not_found":
      case "llm_upstream_error":
      case "llm_invalid_output":
      case "llm_empty_response":
        return "Translation is temporarily unavailable. Please try again later.";
      default:
        return "Something went wrong. Please try again.";
    }
  }

  function showError(bubble, error, options) {
    clearPanels(bubble);
    const opts = options || {};
    const { host, shadow } = makeHost("lb-panel-host", "panel");
    const panel = makeElement("div", "lb-panel lb-panel--error");
    panel.setAttribute("role", "alert");
    panel.appendChild(makeElement("span", "lb-panel__brand", "LinguaBridge"));

    const message = makeElement("p", "lb-error", friendlyError(error));
    panel.appendChild(message);

    const actions = makeElement("div", "lb-actions");
    const retry = makeElement("button", "lb-btn", "Try again");
    retry.type = "button";
    retry.addEventListener("click", (event) => {
      event.stopPropagation();
      if (typeof opts.onRetry === "function") opts.onRetry();
    });
    actions.appendChild(retry);
    panel.appendChild(actions);

    shadow.appendChild(panel);
    bubble.appendChild(host);
    return host;
  }

  function restorePositions() {
    document.querySelectorAll("[data-lb-prev-position]").forEach((element) => {
      element.style.position = element.getAttribute("data-lb-prev-position") || "";
      element.removeAttribute("data-lb-prev-position");
    });
  }

  function clearAll() {
    document.querySelectorAll("[data-lb-ui]").forEach((node) => node.remove());
    // Sibling-mounted badges leave their flex wrapper class behind.
    document.querySelectorAll(".lb-badge-row").forEach((node) => node.classList.remove("lb-badge-row"));
    restorePositions();
  }

  LB.ui = {
    attachBadge,
    findBadge,
    removeBadge,
    clearUi,
    pruneBadges,
    setBadgeState,
    showPanel,
    showLoading,
    showError,
    clearPanels,
    clearAll,
    isDarkTheme
  };
})();
