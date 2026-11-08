#!/usr/bin/env node
/* Optional end-to-end smoke test for the DOM adapters.
 *
 * Prerequisites:
 *   python3 -m http.server 8788 --directory frontend/debug
 *   backend running on 127.0.0.1:8787 (LB_LLM_MODE=mock is enough)
 *   Chrome started with:
 *     --headless=new --remote-debugging-port=9222 \
 *     --disable-extensions-except=$PWD/frontend --load-extension=$PWD/frontend
 *
 * Then: node scripts/e2e-harness.mjs
 */

const CDP_PORT = Number(process.env.CDP_PORT || 9222);
const BASE = process.env.HARNESS_BASE || "http://127.0.0.1:8788";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
  const page = targets.find((target) => target.type === "page");
  if (!page) throw new Error("No page target. Is Chrome running with --remote-debugging-port?");

  const socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });

  let nextId = 1;
  const pending = new Map();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (!message.id) return;
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.error) waiter.reject(new Error(message.error.message));
    else waiter.resolve(message.result);
  });

  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({ id, method, params }));
    });

  const evaluate = async (expression) => {
    const result = await send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.text || "Evaluation failed");
    }
    return result.result.value;
  };

  const waitFor = async (expression, timeout = 15000) => {
    const started = Date.now();
    while (Date.now() - started < timeout) {
      if (await evaluate(expression)) return true;
      await sleep(150);
    }
    throw new Error(`Timed out waiting for: ${expression}`);
  };

  const assert = (condition, label) => {
    if (!condition) throw new Error(`Assertion failed: ${label}`);
    console.log(`  ok  ${label}`);
  };

  await send("Page.enable");
  await send("Runtime.enable");

  async function visit(path) {
    await send("Page.navigate", { url: `${BASE}/${path}` });
    await sleep(700);
    await waitFor(`document.readyState === "complete"`);
    await sleep(1200); // content script + stylesheet fetch
  }

  console.log("WebA harness");
  await visit("harness-a.html");
  const badgesA = await evaluate(`document.querySelectorAll('[data-lb-ui="badge"]').length`);
  assert(badgesA === 4, `4 incoming text messages get a badge (got ${badgesA})`);
  assert(
    await evaluate(`!document.querySelector('[data-mid="a-2"] .lb-badge-host')`),
    "outgoing message has no badge"
  );
  assert(
    await evaluate(`!document.querySelector('[data-mid="a-4"] .lb-badge-host')`),
    "emoji-only message has no badge"
  );
  const aLayout = await evaluate(`(() => {
    const bubble = document.querySelector('[data-mid="a-3"] .message-content');
    const host = bubble && bubble.querySelector(':scope > [data-lb-ui="badge"]');
    if (!host) {
      return { ok: false, reason: 'badge is not inside the bubble' };
    }
    const badgeRect = host.getBoundingClientRect();
    const bubbleRect = bubble.getBoundingClientRect();
    const hostStyle = getComputedStyle(host);
    return {
      ok: true,
      before: badgeRect.right <= bubbleRect.left + 0.5,
      gap: bubbleRect.left - badgeRect.right,
      position: hostStyle.position,
      zIndex: Number(hostStyle.zIndex)
    };
  })()`);
  assert(aLayout.ok, `WebA badge is mounted on the bubble (${aLayout.reason || "ok"})`);
  assert(aLayout.before, "WebA badge sits to the left of the bubble");
  assert(aLayout.position === "absolute", "WebA badge is absolutely positioned");
  assert(aLayout.zIndex >= 10, `WebA badge has z-index >= 10 (got ${aLayout.zIndex})`);

  // Adding/removing the badge must not move the message text. Telegram
  // re-renders rows often; an in-flow badge would make messages jump sideways.
  const aShift = await evaluate(`(() => {
    const bubble = document.querySelector('[data-mid="a-3"] .message-content');
    const host = bubble.querySelector(':scope > [data-lb-ui="badge"]');
    const before = bubble.getBoundingClientRect().left;
    host.remove();
    const after = bubble.getBoundingClientRect().left;
    return { before, after };
  })()`);
  assert(
    Math.abs(aShift.after - aShift.before) < 0.5,
    `removing the WebA badge does not shift the bubble (${aShift.before} -> ${aShift.after})`
  );
  await waitFor(`!!document.querySelector('[data-mid="a-3"] .lb-badge-host')`);
  const aStable = await evaluate(
    `document.querySelector('[data-mid="a-3"] .message-content').getBoundingClientRect().left`
  );
  assert(
    Math.abs(aStable - aShift.before) < 0.5,
    `WebA badge re-attach does not shift the bubble (${aShift.before} -> ${aStable})`
  );

  await evaluate(`document.querySelector('[data-mid="a-3"] .lb-badge-host').click(); true`);
  // The panel host appears immediately with a loading skeleton; wait for the
  // real translation before reading it.
  await waitFor(
    `!!document.querySelector('[data-mid="a-3"] .lb-panel-host')?.shadowRoot?.querySelector('.lb-translation')`
  );
  const panelA = await evaluate(
    `document.querySelector('[data-mid="a-3"] .lb-panel-host').shadowRoot.querySelector('.lb-panel').textContent`
  );
  assert(panelA.includes("[English]"), "panel renders the translated text");
  assert(/Translated in \d+\.\d seconds/.test(panelA), "panel shows the translation time");
  assert(
    !panelA.includes("LinguaBridge") && !panelA.includes("qwen"),
    "panel shows only the translation and the time"
  );

  await evaluate(`document.querySelector('[data-mid="a-3"] .lb-badge-host').click(); true`);
  await waitFor(`!document.querySelector('[data-mid="a-3"] .lb-panel-host')`);
  assert(true, "clicking the badge again closes the panel");

  // Telegram virtualises rows, so badges get rebuilt. A cached result must
  // mark the new badge as done without re-opening the panel (opt-in stays).
  await evaluate(
    `document.querySelectorAll('[data-mid="a-3"] [data-lb-ui]').forEach((n) => n.remove()); true`
  );
  await waitFor(
    `!!document.querySelector('[data-mid="a-3"] .lb-badge-host')?.shadowRoot?.querySelector('.lb-badge--done')`
  );
  assert(
    await evaluate(`!document.querySelector('[data-mid="a-3"] .lb-panel-host')`),
    "cached badge does not auto-open a panel after re-render"
  );

  console.log("WebK harness");
  await visit("harness-k.html");
  const badgesK = await evaluate(`document.querySelectorAll('[data-lb-ui="badge"]').length`);
  assert(badgesK === 3, `3 incoming text messages get a badge (got ${badgesK})`);
  assert(
    await evaluate(`!document.querySelector('[data-mid="k-2"] .lb-badge-host')`),
    "outgoing message has no badge (is-out)"
  );
  assert(
    await evaluate(`!document.querySelector('[data-mid="k-6"] .lb-badge-host')`),
    "emoji-only message has no badge"
  );
  assert(
    await evaluate(
      `document.body.classList.contains('lb-dark') === false`
    ),
    "dark theme is detected from the page background, not a body class"
  );
  const kLayout = await evaluate(`(() => {
    const bubble = document.querySelector('[data-mid="k-1"]');
    const host = bubble && bubble.querySelector(':scope > [data-lb-ui="badge"]');
    if (!host) {
      return { ok: false, reason: 'badge is not inside the bubble' };
    }
    const badgeRect = host.getBoundingClientRect();
    const bubbleRect = bubble.getBoundingClientRect();
    const hostStyle = getComputedStyle(host);
    const containerStyle = getComputedStyle(bubble.parentElement);
    return {
      ok: true,
      before: badgeRect.right <= bubbleRect.left + 0.5,
      gap: bubbleRect.left - badgeRect.right,
      position: hostStyle.position,
      zIndex: Number(hostStyle.zIndex),
      dark: host.classList.contains('lb-dark'),
      containerDirection: containerStyle.flexDirection
    };
  })()`);
  assert(kLayout.ok, `WebK badge is mounted on the bubble (${kLayout.reason || "ok"})`);
  assert(kLayout.before, "WebK badge sits to the left of the bubble");
  assert(kLayout.position === "absolute", "WebK badge is absolutely positioned");
  assert(kLayout.dark, "badge host receives the dark-theme class");
  assert(
    kLayout.containerDirection === "column",
    "WebK chat container keeps its column layout"
  );
  assert(kLayout.zIndex >= 10, `WebK badge has z-index >= 10 (got ${kLayout.zIndex})`);

  // WebK re-renders rows often too; removing the badge must not move text.
  const kShift = await evaluate(`(() => {
    const bubble = document.querySelector('[data-mid="k-1"]');
    const host = bubble.querySelector(':scope > [data-lb-ui="badge"]');
    const before = bubble.getBoundingClientRect().left;
    host.remove();
    const after = bubble.getBoundingClientRect().left;
    return { before, after };
  })()`);
  assert(
    Math.abs(kShift.after - kShift.before) < 0.5,
    `removing the WebK badge does not shift the bubble (${kShift.before} -> ${kShift.after})`
  );
  await waitFor(`!!document.querySelector('[data-mid="k-1"] .lb-badge-host')`);
  const kStable = await evaluate(
    `document.querySelector('[data-mid="k-1"]').getBoundingClientRect().left`
  );
  assert(
    Math.abs(kStable - kShift.before) < 0.5,
    `WebK badge re-attach does not shift the bubble (${kShift.before} -> ${kStable})`
  );

  await evaluate(`document.querySelector('[data-mid="k-1"] .lb-badge-host').click(); true`);
  await waitFor(
    `!!document.querySelector('[data-mid="k-1"] .lb-panel-host')?.shadowRoot?.querySelector('.lb-translation')`
  );
  const panelK = await evaluate(
    `document.querySelector('[data-mid="k-1"] .lb-panel-host').shadowRoot.querySelector('.lb-panel').textContent`
  );
  assert(panelK.includes("[English]"), "WebK panel renders the translation");
  assert(
    /Translated in \d+\.\d seconds/.test(panelK) && !panelK.includes("LinguaBridge"),
    "WebK panel shows the translation time and nothing else"
  );

  console.log("WhatsApp harness");
  await visit("harness-wa.html");
  const badgesWa = await evaluate(`document.querySelectorAll('[data-lb-ui="badge"]').length`);
  assert(badgesWa === 8, `8 incoming text messages get a badge (got ${badgesWa})`);
  assert(
    await evaluate(`!document.querySelector('[data-id="true_1234567890@c.us_WA2"] .lb-badge-host')`),
    "outgoing WhatsApp message has no badge"
  );
  assert(
    await evaluate(`!document.querySelector('[data-id="false_1234567890@c.us_WA6"] .lb-badge-host')`),
    "emoji-only WhatsApp message has no badge"
  );
  const waLayout = await evaluate(`(() => {
    const bubble = document.querySelector('[data-id="false_1234567890@c.us_WA1"] .copyable-text');
    const host = bubble && bubble.previousElementSibling;
    if (!host || host.dataset.lbUi !== 'badge') {
      return { ok: false, reason: 'badge is not the bubble previous element sibling' };
    }
    const badgeRect = host.getBoundingClientRect();
    const bubbleRect = bubble.getBoundingClientRect();
    const hostStyle = getComputedStyle(host);
    const rowStyle = getComputedStyle(host.parentElement);
    return {
      ok: true,
      before: badgeRect.right <= bubbleRect.left + 0.5,
      gap: bubbleRect.left - badgeRect.right,
      position: hostStyle.position,
      zIndex: Number(hostStyle.zIndex),
      display: rowStyle.display,
      direction: rowStyle.flexDirection,
      align: rowStyle.alignItems,
      rowGap: rowStyle.gap
    };
  })()`);
  assert(waLayout.ok, `WhatsApp badge is mounted before the bubble (${waLayout.reason || "ok"})`);
  assert(waLayout.before, "WhatsApp badge sits to the left of the bubble");
  assert(
    waLayout.position === "static" && waLayout.display.includes("flex"),
    "WhatsApp badge is a static flex sibling of the bubble"
  );
  assert(
    waLayout.direction === "row" && waLayout.align === "center",
    "WhatsApp message row aligns the badge and bubble on one centered row"
  );
  assert(
    waLayout.rowGap === "6px" && waLayout.gap >= 2 && waLayout.gap <= 10,
    `WhatsApp badge and bubble are separated by the row gap (gap ${waLayout.rowGap}, measured ${waLayout.gap})`
  );
  assert(waLayout.zIndex >= 10, `WhatsApp badge has z-index >= 10 (got ${waLayout.zIndex})`);

  // Clicking the badge must not reach WhatsApp's delegated row handlers.
  await evaluate(`window.__lbRowClicks = 0; window.__lbRowPointerDowns = 0; true`);
  await evaluate(
    `document.querySelector('[data-id="false_1234567890@c.us_WA1"] .lb-badge-host').click(); true`
  );
  await evaluate(`(() => {
    const host = document.querySelector('[data-id="false_1234567890@c.us_WA1"] .lb-badge-host');
    host.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, composed: true }));
    return true;
  })()`);
  const isolation = await evaluate(
    `({ clicks: window.__lbRowClicks, pointers: window.__lbRowPointerDowns })`
  );
  assert(isolation.clicks === 0, "badge click does not reach WhatsApp row handlers");
  assert(isolation.pointers === 0, "badge pointerdown does not reach WhatsApp row handlers");
  await evaluate(`window.__lbRowClicks = 0; true`);
  await evaluate(
    `document.querySelector('[data-id="false_1234567890@c.us_WA1"] .selectable-text').click(); true`
  );
  assert(
    (await evaluate(`window.__lbRowClicks`)) === 1,
    "WhatsApp row click handler still works outside the badge"
  );

  // WhatsApp can drop our sibling badge while re-rendering a row. It must come
  // back without waiting for the 5s safety-net interval.
  await evaluate(
    `document.querySelector('[data-id="false_1234567890@c.us_WA1"] .lb-badge-host').remove(); true`
  );
  await waitFor(
    `document.querySelector('[data-id="false_1234567890@c.us_WA1"] .copyable-text')?.previousElementSibling?.dataset?.lbUi === 'badge'`,
    3000
  );
  assert(true, "removed WhatsApp badge is re-attached after a row re-render");

  // A reply contains a quoted span before the real text. The quote must be
  // excluded so only the message body is sent for translation.
  await evaluate(
    `document.querySelector('[data-id="false_1234567890@c.us_WA4"] .lb-badge-host').click(); true`
  );
  await waitFor(
    `!!document.querySelector('[data-id="false_1234567890@c.us_WA4"] .lb-panel-host')?.shadowRoot?.querySelector('.lb-translation')`
  );
  const panelWa = await evaluate(
    `document.querySelector('[data-id="false_1234567890@c.us_WA4"] .lb-panel-host').shadowRoot.querySelector('.lb-panel').textContent`
  );
  assert(panelWa.includes("[English]"), "WhatsApp panel renders the translation");
  assert(
    panelWa.includes("Totalmente de acuerdo"),
    "WhatsApp reply translates the message body"
  );
  assert(
    !panelWa.includes("This quoted text"),
    "WhatsApp quoted reply text is excluded"
  );

  // Current WhatsApp Web drops the legacy selectable-text class and uses a
  // bare message id. The adapter must still find and translate the text.
  await evaluate(
    `document.querySelector('[data-id="2A327AC82CD56D95E087"] .lb-badge-host').click(); true`
  );
  await waitFor(
    `!!document.querySelector('[data-id="2A327AC82CD56D95E087"] .lb-panel-host')?.shadowRoot?.querySelector('.lb-translation')`
  );
  const panelCurrentWa = await evaluate(
    `document.querySelector('[data-id="2A327AC82CD56D95E087"] .lb-panel-host').shadowRoot.querySelector('.lb-panel').textContent`
  );
  assert(
    panelCurrentWa.includes("[English]") && panelCurrentWa.includes("nos vemos"),
    "current WhatsApp markup is detected and translated"
  );
  assert(
    !panelCurrentWa.includes("Ana"),
    "current WhatsApp sender label is not translated"
  );

  // Timestamps must never reach the model, even when WhatsApp uses a generated
  // class (no `.message-time`, no test id) for them.
  await evaluate(
    `document.querySelector('[data-id="false_1234567890@c.us_WA7"] .lb-badge-host').click(); true`
  );
  await waitFor(
    `!!document.querySelector('[data-id="false_1234567890@c.us_WA7"] .lb-panel-host')?.shadowRoot?.querySelector('.lb-translation')`
  );
  const panelTimestampWa = await evaluate(
    `document.querySelector('[data-id="false_1234567890@c.us_WA7"] .lb-panel-host').shadowRoot.querySelector('.lb-panel').textContent`
  );
  assert(
    panelTimestampWa.includes("Tumhari") && !/\b\d{1,2}:\d{2}\b/.test(panelTimestampWa),
    "WhatsApp generated-class timestamp is excluded from the translation"
  );

  // No known text selector matches this body, so only the bubble fallback is
  // available. The time-only leaf still has to be stripped.
  await evaluate(
    `document.querySelector('[data-id="false_1234567890@c.us_WA8"] .lb-badge-host').click(); true`
  );
  await waitFor(
    `!!document.querySelector('[data-id="false_1234567890@c.us_WA8"] .lb-panel-host')?.shadowRoot?.querySelector('.lb-translation')`
  );
  const panelFallbackWa = await evaluate(
    `document.querySelector('[data-id="false_1234567890@c.us_WA8"] .lb-panel-host').shadowRoot.querySelector('.lb-panel').textContent`
  );
  assert(
    panelFallbackWa.includes("nueve") && !/\b\d{1,2}:\d{2}\b/.test(panelFallbackWa),
    "WhatsApp bubble fallback strips a time-only leaf"
  );

  // Newest WhatsApp Web rows can have no data-id at all. They must still be
  // discovered through conv-msg-* / copyable-text anchors.
  assert(
    await evaluate(`!!document.querySelector('[data-testid="conv-msg-7A1"] .lb-badge-host')`),
    "conv-msg row without data-id gets a badge"
  );
  assert(
    await evaluate(`(() => {
      const bubble = document.querySelector(
        '.copyable-text[data-pre-plain-text="[21:10, 07/11/2026] Ana: "]'
      );
      return !!bubble && bubble.previousElementSibling?.dataset?.lbUi === 'badge';
    })()`),
    "copyable-text-only row gets a badge"
  );
  await evaluate(
    `document.querySelector('[data-testid="conv-msg-7A1"] .lb-badge-host').click(); true`
  );
  await waitFor(
    `!!document.querySelector('[data-testid="conv-msg-7A1"] .lb-panel-host')?.shadowRoot?.querySelector('.lb-translation')`
  );
  const panelConvWa = await evaluate(
    `document.querySelector('[data-testid="conv-msg-7A1"] .lb-panel-host').shadowRoot.querySelector('.lb-panel').textContent`
  );
  assert(
    panelConvWa.includes("[English]") && panelConvWa.includes("Dónde"),
    "conv-msg row without data-id is translated"
  );

  console.log("\nAll harness checks passed.");
  socket.close();
}

main().catch((error) => {
  console.error("\nHarness test failed:", error.message);
  process.exit(1);
});
