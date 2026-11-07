# Telegram DOM selectors

Telegram Web has two independent clients with different markup. LinguaBridge isolates
every selector in two data files:

- `frontend/lib/adapter-a.js` — `web.telegram.org/a/` (React client)
- `frontend/lib/adapter-k.js` — `web.telegram.org/k/` (WebK client)

`frontend/lib/adapter-registry.js` contains all behaviour. If Telegram ships a redesign,
you should only need to edit the data files.

## Shared contract

Both clients put a numeric message id on a message anchor. LinguaBridge uses
**`[data-mid]`** as the primary anchor in both clients.

| Field | Meaning |
| ----- | ------- |
| `rootSelectors` | Ordered candidates for the scroll/message container. First visible one that contains a message wins. |
| `messageSelector` | Element that owns one message (`[data-mid]`). Nested matches are collapsed to the outermost. |
| `textSelectors` | Candidates for the text/caption node. The longest extracted candidate wins. |
| `bubbleSelectors` | Visual bubble wrapper; the badge host is appended here. |
| `senderSelectors` | Group sender name nodes. |
| `stripSelectors` | Nodes removed from a clone before text extraction (times, reactions, quotes, forwards, icons). |
| `outgoingTokens` | Class tokens marking own messages. |
| `outgoingAttributes` | Attributes marking own messages (presence check). |

## WebA (`adapter-a.js`)

```js
rootSelectors: [
  "#MiddleColumn .messages-container",
  "#MiddleColumn .MessageList",
  "#MiddleColumn",
  ".MessageList",
  ".messages-container"
],
messageSelector: "[data-mid]",
textSelectors: [".text-content", ".message-text", ".Message .message", ".message"],
bubbleSelectors: [".message-content", ".content-inner", ".bubble", ".Message"],
senderSelectors: [".peer-title", ".sender-name", ".name"],
outgoingTokens: ["is-out", "out", "own", "sent", "is-sent"],
outgoingAttributes: ["data-out"]
```

## WebK (`adapter-k.js`)

```js
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
outgoingTokens: ["is-out", "out", "own", "sent", "is-sent"],
outgoingAttributes: ["data-out"]
```

`stripSelectors` is identical in both files and covers `time`, `.time`,
`.message-time`, `.MessageMeta`, `.sent-time`, `.edited`, reactions, `.tgico`, `svg`,
link previews, replies/quotes, forwards, and sender names.

## How extraction works

1. The adapter clones each candidate text node.
2. `stripSelectors` nodes are removed from the clone.
3. `<br>` becomes `\n`; images / custom emoji contribute their `alt` text.
4. Text is sanitised (NFC, control/bidi removal, whitespace bounds).
5. The longest non-empty candidate is returned.

This means a selector can be broad (`.message`) without leaking timestamps into the
translation prompt.

## Outgoing detection

1. Walk up to 8 ancestors looking for an `outgoingTokens` class or an
   `outgoingAttributes` attribute.
2. If not found, inspect the bubble.
3. Final fallback: compare bubble centre to the container centre. A bubble whose centre is
   on the right half is treated as outgoing.

The geometry fallback is why the harness can use `.own` for WebA and `.is-out` for WebK
without special-casing: the class token covers it, and geometry would cover a redesign.

## Updating selectors

1. Open the client in Chrome DevTools.
2. Inspect a message row. Confirm `data-mid` exists on the row/owner.
3. Inspect the text node. Prefer a class that contains only message text, not metadata.
4. Inspect an own message and note its distinguishing class/attribute.
5. Update the corresponding `adapter-*.js`.
6. Reload the extension on `chrome://extensions` and retest.
7. Mirror the new shape in `frontend/debug/harness-*.html`, then run
   `node scripts/e2e-harness.mjs`.

Keep the files as **data**. Behaviour changes belong in `adapter-registry.js` so both
clients benefit.

## Harness pages

The fixtures intentionally use different markup shapes:

- `harness-a.html` — `.Message` rows, `.message-content` bubbles, `.own` for outgoing,
  `.MessageMeta` timestamp, one emoji-only message, one Arabic RTL message.
- `harness-k.html` — `.bubble` owners carrying `data-mid`, `.is-out` for outgoing,
  `.time` timestamps, dark background for theme detection.

They set `data-lb-client="a"` / `"k"` on `<body>` so the registry selects the adapter
without needing URL paths. Serve them on port `8788`; the manifest's `include_globs`
restricts local injection to that port.

## Known fragility

- Class names are minified in production and change between releases.
- `data-mid` is the most stable anchor; prefer it over structural selectors.
- Message lists are virtualised; off-screen messages may not exist in the DOM. The
  context window therefore uses only visible preceding messages, which is exactly what the
  user sees.
- If both clients change at once, add new candidates at the **front** of the arrays and
  keep old ones as fallbacks.
