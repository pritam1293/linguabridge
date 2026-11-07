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

  function getStyles() {
    if (!stylesPromise) {
      stylesPromise = fetch(chrome.runtime.getURL("styles.css"))
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

  function attachBadge(bubble, meta, onActivate) {
    ensurePositioned(bubble);
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

    host.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (host.dataset.lbBusy === "1") return;
      if (typeof onActivate === "function") onActivate();
    });

    bubble.appendChild(host);
    return { host, shadow, button, bubble };
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

  function errorHint(code) {
    switch (code) {
      case "backend_unreachable":
        return "The local backend is not reachable. Start it with backend/run.sh.";
      case "backend_timeout":
        return "The model took too long. Try again, or use a smaller model.";
      case "llm_unreachable":
        return "Ollama is not running. Start it with `ollama serve`.";
      case "model_not_found":
        return "Pull the configured model with `ollama pull <model>`.";
      case "rate_limited":
        return "A few seconds of rest, then try again.";
      case "message_too_long":
        return "This message is too long for one request.";
      default:
        return "";
    }
  }

  function showError(bubble, error, options) {
    clearPanels(bubble);
    const opts = options || {};
    const { host, shadow } = makeHost("lb-panel-host", "panel");
    const panel = makeElement("div", "lb-panel lb-panel--error");
    panel.setAttribute("role", "alert");
    panel.appendChild(makeElement("span", "lb-panel__brand", "LinguaBridge"));

    const message = makeElement(
      "p",
      "lb-error",
      (error && error.message) || "Translation failed."
    );
    const hint = errorHint(error && error.code);
    if (hint) message.appendChild(makeElement("span", "lb-error__hint", hint));
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
    restorePositions();
  }

  LB.ui = {
    attachBadge,
    setBadgeState,
    showPanel,
    showLoading,
    showError,
    clearPanels,
    clearAll,
    isDarkTheme
  };
})();
