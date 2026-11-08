/* Chat DOM adapter (Telegram WebA/WebK and WhatsApp Web).
 *
 * Each client has different markup, but this module provides one interface
 * and keeps every selector-specific decision inside the per-client config
 * files.
 *
 * Interface:
 *   getRoot()            scroll/message container (re-resolved on every call)
 *   getMessages()        visible message owners in document order
 *   getMessageId(el)     platform message id, when available
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

  // A bare clock time (optionally with AM/PM and/or a date), e.g. `12:45`,
  // `9:05 PM` or `12:45, 07/11/2026`. WhatsApp keeps this in a span whose class
  // changes between builds, so class-based stripping alone is not enough.
  const TIMESTAMP_ONLY =
    /^\[?\s*\d{1,2}:\d{2}(?::\d{2})?(?:\s*[ap]\.?m\.?)?\s*(?:[,·•|]\s*\d{1,4}[/.-]\d{1,2}[/.-]\d{1,4})?\s*\]?$/i;

  function stripTimestampLeaves(clone) {
    const leaves = Array.from(clone.querySelectorAll("*")).filter(
      (element) => element.children.length === 0
    );
    const timestamps = leaves.filter((element) =>
      TIMESTAMP_ONLY.test((element.textContent || "").trim())
    );
    if (!timestamps.length) return;
    // Keep a message whose whole body is a time (for example "12:45" sent as
    // chat text); only drop metadata when real text remains.
    let rest = clone.textContent || "";
    for (const element of timestamps) rest = rest.replace(element.textContent, "");
    if (!/\S/.test(rest)) return;
    timestamps.forEach((element) => element.remove());
  }

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
    if (config.stripTimestampLeaves) stripTimestampLeaves(clone);
    return LB.sanitize.clean(clone.textContent || "");
  }

  function buildAdapter(config) {
    const idAttribute = config.messageIdAttribute || "data-mid";

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

    function isExcludedMessage(node, root) {
      const selectors = config.messageExcludeSelectors || [];
      for (const selector of selectors) {
        try {
          const excluded = node.closest(selector);
          if (excluded && root.contains(excluded)) return true;
        } catch (_error) {
          // Ignore invalid optional selector.
        }
      }
      return false;
    }

    function getMessages() {
      const root = getRoot();
      if (!root) return [];
      const nodes = Array.from(root.querySelectorAll(config.messageSelector)).filter(
        (node) => !isExcludedMessage(node, root)
      );
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
        const id = node.getAttribute(idAttribute);
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
      const owner = element.closest(config.messageSelector) || element;
      // Message containers can wrap the element that actually carries the id.
      const carrier =
        (owner.hasAttribute && owner.hasAttribute(idAttribute) && owner) ||
        (owner.querySelector && owner.querySelector(`[${idAttribute}]`)) ||
        owner;
      return (
        (carrier && carrier.getAttribute && carrier.getAttribute(idAttribute)) ||
        element.getAttribute(idAttribute) ||
        ""
      );
    }

    function isExcludedTextNode(node) {
      const selectors = config.textExcludeSelectors || [];
      for (const selector of selectors) {
        try {
          if (node.closest(selector)) return true;
        } catch (_error) {
          // Ignore invalid optional selector.
        }
      }
      return false;
    }

    function getMessageText(element) {
      if (!element) return "";
      const groups = [];
      for (const selector of config.textSelectors) {
        let nodes = [];
        try {
          nodes = Array.from(element.querySelectorAll(selector));
          if (element.matches(selector)) nodes.unshift(element);
        } catch (_error) {
          nodes = [];
        }
        // Configs with quote/reply exclusions need to inspect every candidate
        // (WhatsApp puts the quoted text in a separate selectable span).
        if (config.textExcludeSelectors) {
          const parts = [];
          // If a selector matches nested nodes, keep only the outermost so the
          // same text is not appended twice.
          const topLevel = nodes.filter(
            (node) => !nodes.some((other) => other !== node && other.contains(node))
          );
          for (const node of topLevel) {
            if (isExcludedTextNode(node)) continue;
            const text = stripCloneText(node, config);
            if (text && !parts.includes(text)) parts.push(text);
          }
          if (parts.length) groups.push(LB.sanitize.clean(parts.join(" ")));
        } else if (nodes[0]) {
          groups.push(stripCloneText(nodes[0], config));
        }
      }
      groups.push(stripCloneText(element, config));

      // WhatsApp: prefer the narrowest text selector instead of the longest
      // candidate. The whole-bubble clone can contain timestamp spans whose
      // class names are generated per build, which must never be translated.
      if (config.preferTextSelectors) {
        for (const candidate of groups) {
          if (candidate) return candidate;
        }
        return "";
      }

      let best = "";
      for (const candidate of groups) {
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
        if (config.outgoingIdPrefix) {
          const id = current.getAttribute(idAttribute) || "";
          if (id.startsWith(config.outgoingIdPrefix)) return true;
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

      // WhatsApp keeps the sender in data-pre-plain-text instead of a node.
      if (config.senderAttribute) {
        const attr = `[${config.senderAttribute}]`;
        let node = null;
        try {
          node = element.matches(attr) ? element : element.querySelector(attr);
        } catch (_error) {
          node = null;
        }
        const raw = node ? node.getAttribute(config.senderAttribute) || "" : "";
        const match = raw.match(/\]\s*([^:]+):\s*$/);
        if (match) {
          const name = LB.sanitize
            .clean(match[1], { maxChars: 32, keepNewlines: false })
            .trim();
          if (name) return name;
        }
      }
      return "";
    }

    function hasGroupMarker() {
      for (const selector of config.groupSelectors || []) {
        try {
          if (document.querySelector(selector)) return true;
        } catch (_error) {
          // Ignore invalid optional selector.
        }
      }
      return false;
    }

    function getChatType() {
      if (hasGroupMarker()) return "group";
      const senders = new Set();
      for (const message of getMessages().slice(-20)) {
        if (isOutgoing(message)) continue;
        const name = getSenderName(message);
        if (name) senders.add(name);
      }
      return senders.size >= 2 ? "group" : "private";
    }

    function findOwner(node) {
      if (!node || !node.closest) return null;
      return node.closest(config.messageSelector);
    }

    return {
      name: config.name,
      label: config.label,
      platform: config.platform || "telegram",
      // "inside" appends the badge to the bubble; "before" mounts it as a flex
      // sibling ahead of the bubble; "left" overlays it on the bubble's left
      // edge without changing the page's message flow (Telegram).
      badgePlacement: config.badgePlacement || "inside",
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

    if ((forced === "a" || forced === "k" || forced === "wa") && configs[forced]) {
      return buildAdapter(configs[forced]);
    }

    const host = window.location.hostname;
    if (/(^|\.)whatsapp\.com$/i.test(host) && configs.wa) {
      return buildAdapter(configs.wa);
    }

    const path = window.location.pathname;
    if (path.startsWith("/k") && configs.k) return buildAdapter(configs.k);
    if (path.startsWith("/a") && configs.a) return buildAdapter(configs.a);

    // Last resort: inspect the DOM (useful for locally saved pages).
    if (document.querySelector("#main [data-id], #main .message-in, #main .message-out")) {
      return configs.wa ? buildAdapter(configs.wa) : null;
    }
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
