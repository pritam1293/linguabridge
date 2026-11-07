/* Selector map for web.telegram.org/k/ (WebK).
 * Kept as data only; all logic lives in adapter-registry.js.
 *
 * If Telegram ships a redesign, update this file and docs/selectors.md.
 * `[data-mid]` is the primary anchor in both clients.
 */
(() => {
  const LB = (globalThis.LB = globalThis.LB || {});
  LB.adapterConfigs = LB.adapterConfigs || {};

  LB.adapterConfigs.k = {
    name: "k",
    label: "Telegram WebK",
    platform: "telegram",
    rootSelectors: [
      "#column-center .chat-container",
      "#column-center",
      "#chat-messages",
      ".chat-container",
      ".bubbles",
      "#MiddleColumn"
    ],
    messageSelector: "[data-mid]",
    textSelectors: [
      ".translatable-message",
      ".message .text-content",
      ".text-content",
      ".message-text",
      ".message"
    ],
    bubbleSelectors: [".bubble", ".message-content", ".content-inner"],
    senderSelectors: [".peer-title", ".sender-name", ".name"],
    stripSelectors: [
      "[data-lb-ui]",
      ".time",
      ".message-time",
      ".MessageMeta",
      ".sent-time",
      ".edited",
      ".reactions",
      ".reaction",
      ".tgico",
      "svg",
      "time",
      ".webpage",
      ".reply",
      ".quoted",
      ".quote",
      ".forward",
      ".peer-title",
      ".sender-name",
      ".name"
    ],
    outgoingTokens: ["is-out", "out", "own", "sent", "is-sent"],
    outgoingAttributes: ["data-out"]
  };
})();
