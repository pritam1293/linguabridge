/* Selector map for web.telegram.org/a/ (WebA / React client).
 * Kept as data only; all logic lives in adapter-registry.js.
 */
(() => {
  const LB = (globalThis.LB = globalThis.LB || {});
  LB.adapterConfigs = LB.adapterConfigs || {};

  LB.adapterConfigs.a = {
    name: "a",
    label: "Telegram WebA",
    platform: "telegram",
    rootSelectors: [
      "#MiddleColumn .messages-container",
      "#MiddleColumn .MessageList",
      "#MiddleColumn",
      ".MessageList",
      ".messages-container"
    ],
    messageSelector: "[data-mid]",
    textSelectors: [
      ".text-content",
      ".message-text",
      ".Message .message",
      ".message"
    ],
    bubbleSelectors: [".message-content", ".content-inner", ".bubble", ".Message"],
    // `.Message` is already a flex row, but inserting the badge into that row
    // shifts the bubble whenever Telegram re-renders. Overlay it on the left
    // edge instead so re-renders never move the message text.
    badgePlacement: "left",
    senderSelectors: [".peer-title", ".sender-name", ".name"],
    stripSelectors: [
      "[data-lb-ui]",
      ".MessageMeta",
      ".message-time",
      ".time",
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
