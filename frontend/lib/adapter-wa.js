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
    // `data-id` is still present on current WhatsApp rows, but newer builds can
    // put it on a descendant. `msg-container` is the documented stable wrapper.
    messageSelector: '[data-id], [data-testid="msg-container"]',
    textSelectors: [
      // Current WhatsApp Web uses these test ids and may drop `.selectable-text`.
      '[data-testid="selectable-text"]:not([title])',
      '[data-testid="conversation-text"]',
      '[data-testid="msg-text"]',
      'div.copyable-text span.selectable-text:not([title])',
      'span.selectable-text:not([title])',
      'span[dir="ltr"]',
      'span[dir="rtl"]',
      "div.copyable-text"
    ],
    textExcludeSelectors: [
      '[data-testid="quoted-message"]',
      '[data-testid="quoted-message-container"]',
      '[data-testid="msg-quote"]',
      ".quoted-message",
      ".quoted-mention"
    ],
    bubbleSelectors: [
      '[data-testid="msg-container"]',
      "div.copyable-text",
      ".message-in",
      ".message-out"
    ],
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
    outgoingTokens: ["message-out", "out"],
    outgoingAttributes: [],
    // Legacy WhatsApp rows prefix the data-id with true_ for own messages.
    outgoingIdPrefix: "true_",
    groupSelectors: [
      '#main header [data-icon="default-group"]',
      '#main header [data-icon="group"]'
    ]
  };
})();
