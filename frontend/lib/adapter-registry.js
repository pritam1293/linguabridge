/* Telegram DOM adapter.
 *
 * The two Telegram clients share almost nothing structurally, but both expose
 * `[data-mid]` on message rows. This module provides one interface and keeps
 * every selector-specific decision inside the per-client config files.
 *
 * Interface:
 *   getRoot()            scroll/message container (re-resolved on every call)
 *   getMessages()        visible message owners in document order
 *   getMessageId(el)     Telegram message id, when available
 *   getMessageText(el)   text/caption only (no timestamps, sender names, quotes)
 *   getBubble(el)        element that visually wraps the message
 *   getSenderName(el)    group sender name, or ""
 *   isOutgoing(el)       own message detection (class first, geometry fallback)
 *   getChatType()        "group" | "private"
 *   findOwner(node)      nearest [data-mid] ancestor
 */
(() => {
  const LB = (globalThis.LB = globalThis.LB || {});
  const configs = LB.adapterConfigs || {};

  function stripCloneText(node, config) {
    const clone = node.cloneNode(true);
    clone.querySelectorAll(config.stripSelectors.join(",")).forEach((element) => element.remove());
    // Telegram renders line breaks as <br>.
    clone.querySelectorAll("br").forEach((br) => br.replaceWith("\n"));
    // Custom emoji / images sometimes carry the character in alt text.
    clone.querySelectorAll("img[alt], tg-emoji[alt]").forEach((element) => {
      const alt = element.getAttribute("alt") || "";
      element.replaceWith(document.createTextNode(alt));
    });
    return LB.sanitize.clean(clone.textContent || "");
  }

  function buildAdapter(config) {
    function getRoot() {
      let fallback = null;
      for (const selector of config.rootSelectors) {
        const nodes = document.querySelectorAll(selector);
        for (const node of nodes) {
          if (!(node instanceof HTMLElement)) continue;
          if (node.getClientRects().length === 0) continue;
          if (!fallback) fallback = node;
          if (node.querySelector(config.messageSelector)) return node;
        }
      }
      return fallback;
    }

    function getMessages() {
      const root = getRoot();
      if (!root) return [];
      const nodes = Array.from(root.querySelectorAll(config.messageSelector));
      const visible = nodes.filter(
        (node) => node instanceof HTMLElement && node.getClientRects().length > 0
      );
      // Both clients sometimes nest [data-mid] (row + bubble). Keep the outer.
      const outermost = visible.filter((node) => {
        let parent = node.parentElement;
        while (parent && parent !== root) {
          if (parent.matches && parent.matches(config.messageSelector)) return false;
          parent = parent.parentElement;
        }
        return true;
      });
      const seen = new Set();
      const result = [];
      for (const node of outermost) {
        const id = node.getAttribute("data-mid");
        if (id) {
          if (seen.has(id)) continue;
          seen.add(id);
        }
        result.push(node);
      }
      return result;
    }

    function getMessageId(element) {
      if (!element) return "";
      const owner = element.closest(config.messageSelector);
      return (owner && owner.getAttribute("data-mid")) || element.getAttribute("data-mid") || "";
    }

    function getMessageText(element) {
      if (!element) return "";
      const candidates = [];
      for (const selector of config.textSelectors) {
        let node = null;
        try {
          node = element.matches(selector) ? element : element.querySelector(selector);
        } catch (_error) {
          node = null;
        }
        if (node) candidates.push(stripCloneText(node, config));
      }
      candidates.push(stripCloneText(element, config));
      let best = "";
      for (const candidate of candidates) {
        if (candidate && candidate.length > best.length) best = candidate;
      }
      return best;
    }

    function getBubble(element) {
      if (!element) return null;
      for (const selector of config.bubbleSelectors) {
        if (element.matches && element.matches(selector)) return element;
        const node = element.querySelector(selector);
        if (node) return node;
      }
      return element;
    }

    function hasOutgoingMarker(element) {
      let current = element;
      let depth = 0;
      while (current && current instanceof HTMLElement && depth < 8) {
        for (const token of config.outgoingTokens) {
          if (current.classList && current.classList.contains(token)) return true;
        }
        for (const attribute of config.outgoingAttributes) {
          if (current.hasAttribute(attribute)) return true;
        }
        current = current.parentElement;
        depth += 1;
      }
      const bubble = getBubble(element);
      return Boolean(bubble && bubble !== element && hasClassMarker(bubble));
    }

    function hasClassMarker(element) {
      if (!element || !element.classList) return false;
      return config.outgoingTokens.some((token) => element.classList.contains(token));
    }

    function isOutgoing(element) {
      if (!element) return false;
      if (hasOutgoingMarker(element)) return true;
      // Geometry fallback: the bubble, not the row, is aligned left or right.
      const root = getRoot();
      const bubble = getBubble(element);
      if (!root || !bubble) return false;
      const rootRect = root.getBoundingClientRect();
      const bubbleRect = bubble.getBoundingClientRect();
      if (rootRect.width < 40 || bubbleRect.width < 8) return false;
      const center = bubbleRect.left + bubbleRect.width / 2;
      return center > rootRect.left + rootRect.width / 2;
    }

    function getSenderName(element) {
      if (!element) return "";
      for (const selector of config.senderSelectors) {
        const nodes = element.querySelectorAll(selector);
        for (const node of nodes) {
          if (node.closest(".reply, .quoted, .quote, .webpage, .forward")) continue;
          const name = LB.sanitize
            .clean(node.textContent || "", { maxChars: 32, keepNewlines: false })
            .replace(/:$/, "")
            .trim();
          if (name) return name;
        }
      }
      return "";
    }

    function getChatType() {
      const messages = getMessages().slice(-20);
      let incoming = 0;
      let named = 0;
      for (const message of messages) {
        if (isOutgoing(message)) continue;
        incoming += 1;
        if (getSenderName(message)) named += 1;
      }
      return incoming >= 2 && named >= Math.min(2, incoming) ? "group" : "private";
    }

    function findOwner(node) {
      if (!node || !node.closest) return null;
      return node.closest(config.messageSelector);
    }

    return {
      name: config.name,
      label: config.label,
      getRoot,
      getMessages,
      getMessageId,
      getMessageText,
      getBubble,
      getSenderName,
      isOutgoing,
      getChatType,
      findOwner
    };
  }

  function detect() {
    const forced =
      (document.body && document.body.dataset && document.body.dataset.lbClient) ||
      (document.documentElement &&
        document.documentElement.dataset &&
        document.documentElement.dataset.lbClient);

    if ((forced === "a" || forced === "k") && configs[forced]) {
      return buildAdapter(configs[forced]);
    }

    const path = window.location.pathname;
    if (path.startsWith("/k") && configs.k) return buildAdapter(configs.k);
    if (path.startsWith("/a") && configs.a) return buildAdapter(configs.a);

    // Last resort: inspect the DOM (useful for locally saved pages).
    if (document.querySelector(".Message[data-mid], .MessageList")) {
      return configs.a ? buildAdapter(configs.a) : null;
    }
    if (document.querySelector(".bubble[data-mid], #chat-messages")) {
      return configs.k ? buildAdapter(configs.k) : null;
    }
    return null;
  }

  LB.registry = { detect };
})();
