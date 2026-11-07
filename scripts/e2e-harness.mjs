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
  assert(
    await evaluate(
      `getComputedStyle(document.querySelector('[data-mid="a-3"] .message-content')).position === 'relative'`
    ),
    "bubble is positioned for the absolute badge"
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
  assert(
    await evaluate(
      `document.querySelector('[data-mid="k-1"] .lb-badge-host').classList.contains('lb-dark')`
    ),
    "badge host receives the dark-theme class"
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
  assert(badgesWa === 4, `4 incoming text messages get a badge (got ${badgesWa})`);
  assert(
    await evaluate(`!document.querySelector('[data-id="true_1234567890@c.us_WA2"] .lb-badge-host')`),
    "outgoing WhatsApp message has no badge"
  );
  assert(
    await evaluate(`!document.querySelector('[data-id="false_1234567890@c.us_WA6"] .lb-badge-host')`),
    "emoji-only WhatsApp message has no badge"
  );
  assert(
    await evaluate(
      `getComputedStyle(document.querySelector('[data-id="false_1234567890@c.us_WA1"] .copyable-text')).position === 'relative'`
    ),
    "WhatsApp bubble is positioned for the absolute badge"
  );

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

  console.log("\nAll harness checks passed.");
  socket.close();
}

main().catch((error) => {
  console.error("\nHarness test failed:", error.message);
  process.exit(1);
});
