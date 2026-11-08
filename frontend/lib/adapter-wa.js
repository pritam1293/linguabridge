/* Selector map for web.whatsapp.com (WhatsApp Web).
 * Kept as data only; all logic lives in adapter-registry.js.
 *
 * WhatsApp uses generated class names, so the stable anchors here are
 * `data-id` (message id), `data-pre-plain-text` (sender + timestamp) and
 * `role`/`dir`/`data-testid` hints. If WhatsApp ships a redesign, update this
 * file and docs/selectors.md.
 */
(() => {
  const LB = (globalThis.LB = globalThis.LB || {});
  LB.adapterConfigs = LB.adapterConfigs || {};

  LB.adapterConfigs.wa = {
    name: "wa",
    label: "WhatsApp Web",
    platform: "whatsapp",
    rootSelectors: [
      '#main [data-testid="conversation-panel-messages"]',
      '[data-testid="conversation-panel-messages"]',
      '#main [role="application"]',
      "#main .copyable-area",
      "#main"
    ],
    messageIdAttribute: "data-id",
    // Newer WhatsApp builds dropped `data-id` from some message rows. Keep every
    // anchor seen in the wild: legacy id rows, `msg-container`, the newer
    // `conv-msg-*` row test ids, and the copyable-text wrapper that carries the
    // sender/timestamp metadata.
    messageSelector: [
      "[data-id]",
      '[data-testid="msg-container"]',
      '[data-testid^="conv-msg-"]',
      'div[role="row"] .copyable-text[data-pre-plain-text]',
      ".copyable-text[data-pre-plain-text]",
      "div.message-in",
      "div.message-out",
      // Last resort: the bubble wrapper itself, even without metadata attrs.
      "div.copyable-text"
    ].join(", "),
    // Quoted replies reuse `.copyable-text[data-pre-plain-text]`; never treat
    // them as standalone messages.
    messageExcludeSelectors: [
      '[data-testid="quoted-message"]',
      '[data-testid="quoted-message-container"]',
      '[data-testid="msg-quote"]',
      ".quoted-message",
      ".quoted-mention"
    ],
    textSelectors: [
      // Current WhatsApp Web uses these test ids and may drop `.selectable-text`.
      // `[data-testid~=...]` covers markup where the test id carries extra tokens.
      '[data-testid="selectable-text"]:not([title])',
      '[data-testid~="selectable-text"]',
      '[data-testid="conversation-text"]',
      '[data-testid="msg-text"]',
      "div.copyable-text span.selectable-text:not([title])",
      "span.selectable-text:not([title])",
      'span[dir="ltr"]',
      'span[dir="rtl"]',
      ".copyable-text[data-pre-plain-text]",
      "div.copyable-text"
    ],
    // Prefer the first selector that yields text (narrowest first) because the
    // whole-bubble clone can include timestamp spans with generated class names.
    preferTextSelectors: true,
    // Last-resort safety net for builds where only the bubble wrapper matches:
    // remove leaf nodes whose entire text is just a clock time.
    stripTimestampLeaves: true,
    textExcludeSelectors: [
      '[data-testid="quoted-message"]',
      '[data-testid="quoted-message-container"]',
      '[data-testid="msg-quote"]',
      ".quoted-message",
      ".quoted-mention"
    ],
    bubbleSelectors: [
      // Prefer the copyable-text wrapper: it is the painted bubble and is less
      // likely than msg-container to clip absolutely positioned children.
      "div.copyable-text",
      '[data-testid="msg-container"]',
      ".message-in",
      ".message-out"
    ],
    // WhatsApp renders its action-menu chevron at the bubble's top-right.
    // Mount the badge as a flex sibling *before* the bubble so it stays on the
    // far left and never competes with that menu.
    badgePlacement: "before",
    senderSelectors: [],
    senderAttribute: "data-pre-plain-text",
    stripSelectors: [
      "[data-lb-ui]",
      '[data-testid="quoted-message"]',
      '[data-testid="quoted-message-container"]',
      '[data-testid="msg-quote"]',
      ".quoted-message",
      ".quoted-mention",
      '[data-testid="msg-meta"]',
      '[data-testid="msg-time"]',
      "[data-icon]",
      ".sender",
      ".message-time",
      "time",
      "svg",
      "button",
      '[role="button"]'
    ],
    outgoingTokens: ["message-out"],
    outgoingAttributes: [],
    // Legacy WhatsApp rows prefix the data-id with true_ for own messages.
    outgoingIdPrefix: "true_",
    groupSelectors: [
      '#main header [data-icon="default-group"]',
      '#main header [data-icon="group"]'
    ]
  };
})();
