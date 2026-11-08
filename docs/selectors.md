# Telegram and WhatsApp DOM selectors

Telegram Web has two independent clients with different markup, and WhatsApp Web has its
own generated-class layout. LinguaBridge isolates every selector in data files:

- `frontend/lib/adapter-a.js` — `web.telegram.org/a/` (React client)
- `frontend/lib/adapter-k.js` — `web.telegram.org/k/` (WebK client)
- `frontend/lib/adapter-wa.js` — `web.whatsapp.com`

`frontend/lib/adapter-registry.js` contains all behaviour. If a client ships a redesign,
you should only need to edit its data file.

## Shared contract

Telegram clients put a numeric message id on a message anchor, and LinguaBridge uses
**`[data-mid]`** as the primary anchor. WhatsApp exposes a different id attribute, so the
adapter config names it explicitly.

| Field | Meaning |
| ----- | ------- |
| `platform` | Platform key used to enforce the matching popup switch (`telegram` / `whatsapp`). |
| `rootSelectors` | Ordered candidates for the scroll/message container. First visible one that contains a message wins. |
| `messageIdAttribute` | Attribute carrying the message id (defaults to `data-mid`). |
| `messageSelector` | Element that owns one message. Nested matches are collapsed to the outermost. |
| `textSelectors` | Candidates for the text/caption node. The longest extracted candidate wins unless `preferTextSelectors` is set. |
| `preferTextSelectors` | When true, use the first (narrowest) selector that yields text instead of the longest candidate. Avoids whole-bubble clones on WhatsApp. |
| `textExcludeSelectors` | Optional nodes to ignore entirely while extracting text (for example quoted replies). |
| `bubbleSelectors` | Visual bubble wrapper; the badge host and translation panel are attached relative to it. |
| `badgePlacement` | `inside` (default) appends the badge to the bubble; `before` mounts it as a flex sibling ahead of the bubble; `left` overlays it on the bubble's left edge without affecting layout. |
| `stripTimestampLeaves` | Optional safe net: remove leaf nodes whose entire text is just a clock time (WhatsApp generated classes). |
| `senderSelectors` | Group sender name nodes. |
| `senderAttribute` | Optional attribute containing sender metadata when the name is not a node (WhatsApp). |
| `stripSelectors` | Nodes removed from a clone before text extraction (times, reactions, quotes, forwards, icons). |
| `outgoingTokens` | Class tokens marking own messages. |
| `outgoingAttributes` | Attributes marking own messages (presence check). |
| `outgoingIdPrefix` | Optional `data-id` prefix marking own messages (WhatsApp `true_`). |
| `groupSelectors` | Optional DOM markers for group chats; otherwise distinct senders are used. |

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
badgePlacement: "left",
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
badgePlacement: "left",
senderSelectors: [".peer-title", ".sender-name", ".name"],
outgoingTokens: ["is-out", "out", "own", "sent", "is-sent"],
outgoingAttributes: ["data-out"]
```

Telegram rows are virtualised and re-rendered often. Both clients use
`badgePlacement: "left"`, which appends the badge to the bubble but positions it
absolutely on the left edge. The badge therefore stays out of the flex flow: a row
re-render can remove and re-add it without shifting the message text sideways.

`stripSelectors` is identical in both Telegram files and covers `time`, `.time`,
`.message-time`, `.MessageMeta`, `.sent-time`, `.edited`, reactions, `.tgico`, `svg`,
link previews, replies/quotes, forwards, and sender names.

## WhatsApp (`adapter-wa.js`)

```js
rootSelectors: [
  '#main [data-testid="conversation-panel-messages"]',
  '[data-testid="conversation-panel-messages"]',
  '#main [role="application"]',
  "#main .copyable-area",
  "#main"
],
messageIdAttribute: "data-id",
messageSelector: [
  "[data-id]",
  '[data-testid="msg-container"]',
  '[data-testid^="conv-msg-"]',
  'div[role="row"] .copyable-text[data-pre-plain-text]',
  ".copyable-text[data-pre-plain-text]",
  "div.message-in",
  "div.message-out",
  "div.copyable-text"
].join(", "),
messageExcludeSelectors: [
  '[data-testid="quoted-message"]',
  '[data-testid="quoted-message-container"]',
  '[data-testid="msg-quote"]',
  ".quoted-message",
  ".quoted-mention"
],
textSelectors: [
  '[data-testid="selectable-text"]:not([title])',
  '[data-testid~="selectable-text"]',
  '[data-testid="conversation-text"]',
  '[data-testid="msg-text"]',
  'div.copyable-text span.selectable-text:not([title])',
  'span.selectable-text:not([title])',
  'span[dir="ltr"]',
  'span[dir="rtl"]',
  ".copyable-text[data-pre-plain-text]",
  "div.copyable-text"
],
preferTextSelectors: true,
stripTimestampLeaves: true,
textExcludeSelectors: [
  '[data-testid="quoted-message"]',
  '[data-testid="quoted-message-container"]',
  '[data-testid="msg-quote"]',
  ".quoted-message",
  ".quoted-mention"
],
bubbleSelectors: ["div.copyable-text", '[data-testid="msg-container"]', ".message-in", ".message-out"],
badgePlacement: "before",
senderAttribute: "data-pre-plain-text",
outgoingTokens: ["message-out"],
outgoingIdPrefix: "true_",
groupSelectors: ['#main header [data-icon="default-group"]', '#main header [data-icon="group"]']
```

WhatsApp class names are generated, so the stable anchors are `data-id`,
`data-pre-plain-text`, `role`, `dir` and `data-testid`. Builds differ in which of those
survive: some keep `data-id`, some only expose `msg-container`, and newer builds key rows
with `conv-msg-*` test ids or only expose the `.copyable-text[data-pre-plain-text]`
wrapper. The adapter accepts all of them so a markup rollout does not hide every badge.
Message text may be a `selectable-text` class, a `[data-testid="selectable-text"]` node, or
a test id with extra tokens, so both `=` and `~=` forms are matched. The sender name is
parsed from `data-pre-plain-text` (`[time, date] Sender: `). Quoted replies are excluded
from text extraction and are never treated as standalone messages. Own messages are
detected by the `message-out` class, the legacy `true_` id prefix, and a geometry fallback.

WhatsApp's action-menu chevron appears at the bubble's top-right, so the badge is **not**
attached to the bubble. `badgePlacement: "before"` inserts the badge host as a flex
sibling immediately before the bubble and adds `lb-badge-row` to the wrapper
(`display: flex; align-items: center; gap: 6px`), producing
`[ Translate ] [ Message bubble ]` on the far left. Badge pointer/click events are
stopped and prevented before they reach WhatsApp's delegated row handlers, so opening
the translation never selects the message or opens the native menu. The translation
panel still lives inside the bubble, below its text.

Text extraction prefers the narrowest matching text selector (`preferTextSelectors`) so the
whole-bubble clone is only used as a fallback. When that fallback is needed,
`stripTimestampLeaves` removes any leaf whose entire text is just a clock time, covering
builds that use generated class names for the timestamp. A message whose whole body is a
time (for example `12:45` sent as chat text) is not stripped.

## How extraction works

1. The adapter clones each candidate text node.
2. Candidate nodes inside `textExcludeSelectors` are skipped (WhatsApp quotes).
3. `stripSelectors` nodes are removed from the clone.
4. `<br>` becomes `\n`; images / custom emoji contribute their `alt` text.
5. With `stripTimestampLeaves`, time-only leaf nodes are removed when real text remains.
6. Text is sanitised (control/bidi removal, whitespace bounds).
7. `preferTextSelectors` returns the first non-empty selector group; otherwise the longest
   non-empty candidate is returned.

On WhatsApp the whole-bubble clone can contain timestamp spans with generated class names,
which is why the narrowest selector is preferred. This also means a broad selector can stay
as a last-resort fallback without leaking timestamps into the translation prompt.

## Outgoing detection

1. Walk up to 8 ancestors looking for an `outgoingTokens` class, an
   `outgoingAttributes` attribute, or an `outgoingIdPrefix` on the message id.
2. If not found, inspect the bubble.
3. Final fallback: compare bubble centre to the container centre. A bubble whose centre is
   on the right half is treated as outgoing.

The geometry fallback is why the harness can use `.own` for WebA, `.is-out` for WebK and
`message-out` for WhatsApp without special-casing: the class or id prefix covers it, and
geometry would cover a redesign.

Group detection prefers `groupSelectors` DOM markers. When those are absent, two or more
distinct incoming senders in the visible window mark the chat as a group.

## Updating selectors

1. Open the client in Chrome DevTools.
2. Inspect a message row. Confirm the id attribute exists on the row/owner (`data-mid` for
   Telegram, `data-id` for WhatsApp).
3. Inspect the text node. Prefer a class that contains only message text, not metadata.
4. Inspect an own message and note its distinguishing class/attribute/id prefix.
5. Update the corresponding `adapter-*.js`.
6. Reload the extension on `chrome://extensions` and retest.
7. Mirror the new shape in `frontend/debug/harness-*.html`, then run
   `node scripts/e2e-harness.mjs`.

Keep the files as **data**. Behaviour changes belong in `adapter-registry.js` so all
clients benefit.

## Harness pages

The fixtures intentionally use different markup shapes:

- `harness-a.html` — `.Message` rows, `.message-content` bubbles, `.own` for outgoing,
  `.MessageMeta` timestamp, one emoji-only message, one Arabic RTL message.
- `harness-k.html` — `.bubble` owners carrying `data-mid` directly in a column container,
  `.is-out` for outgoing, `.time` timestamps, dark background for theme detection.
- `harness-wa.html` — `.message-in` / `.message-out` rows carrying `data-id`,
  `data-pre-plain-text` sender metadata, a quoted reply that must stay out of the
  translation, an emoji-only message, a current-WhatsApp message using
  `data-testid="selectable-text"` with a bare message id, a newest-build `conv-msg-*` row
  without `data-id`, a row anchored only by `.copyable-text[data-pre-plain-text]`, and two
  messages whose timestamp span uses generated classes (one with a normal text node, one
  where only the bubble fallback matches).

They set `data-lb-client="a"` / `"k"` / `"wa"` on `<body>` so the registry selects the
adapter without needing URL paths. Serve them on port `8788`; the manifest's
`include_globs` restricts local injection to that port.

## Known fragility

- Class names are minified/generated in production and change between releases.
- `data-mid` (Telegram) and `data-id` (WhatsApp) are the most stable anchors; prefer them
  over structural selectors.
- WhatsApp quoted replies and sender labels share text-bearing nodes with the message body,
  so keep `textExcludeSelectors` and `stripSelectors` in sync with the fixture.
- Message lists are virtualised; off-screen messages may not exist in the DOM. The
  context window therefore uses only visible preceding messages, which is exactly what the
  user sees.
- If several clients change at once, add new candidates at the **front** of the arrays and
  keep old ones as fallbacks.
