/* Builds the 3-5 turn sliding window that gives the model conversational context. */
(() => {
  const LB = (globalThis.LB = globalThis.LB || {});

  const MAX_LOOKBACK = 25; // scan bound, keeps click latency predictable
  const MAX_PER_MESSAGE = 600;
  const MAX_TOTAL = 2400;

  function build(adapter, targetElement, options) {
    const opts = options || {};
    const turns = Math.max(1, Math.min(8, Number(opts.turns) || 5));
    const all = adapter.getMessages();
    const index = all.indexOf(targetElement);
    const end = index === -1 ? all.length : index;
    const start = Math.max(0, end - MAX_LOOKBACK);
    const prior = all.slice(start, end);

    const picked = [];
    let total = 0;
    for (let i = prior.length - 1; i >= 0 && picked.length < turns; i -= 1) {
      const element = prior[i];
      const text = adapter.getMessageText(element);
      if (!text || !LB.sanitize.hasTranslatable(text)) continue;
      const clipped = LB.sanitize.clean(text, { maxChars: MAX_PER_MESSAGE });
      total += clipped.length;
      if (total > MAX_TOTAL) break;
      const role = adapter.isOutgoing(element) ? "self" : "other";
      let speaker = role === "self" ? "Me" : adapter.getSenderName(element) || "Other";
      speaker = LB.sanitize.clean(speaker, { maxChars: 32, keepNewlines: false }) || "Other";
      picked.unshift({ role, speaker, text: clipped });
    }

    const targetText = adapter.getMessageText(targetElement);
    // Defensive: never send the target message twice.
    if (picked.length && picked[picked.length - 1].text === targetText) {
      picked.pop();
    }

    return {
      history: picked,
      chat_type: adapter.getChatType(),
      target_text: targetText
    };
  }

  LB.contextWindow = { build };
})();
