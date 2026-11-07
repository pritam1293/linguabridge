# Architecture

LinguaBridge is two cooperating processes and one message contract.

```
 ┌────────────────────────────── Browser ──────────────────────────────┐
 │                                                                    │
 │  Telegram / WhatsApp Web page                                    │
 │  ┌───────────────────────────────────────────────┐                 │
 │  │ content script (isolated world)               │                 │
 │  │  • adapter detects WebA/WebK/WhatsApp         │                 │
 │  │  • MutationObserver + 5s safety sweep         │                 │
 │  │  • injects shadow-DOM badges / panels         │                 │
 │  │  • builds the 3–5 turn context window          │                 │
 │  └───────────────┬───────────────────────────────┘                 │
 │                  │ chrome.runtime.sendMessage                      │
 │  ┌───────────────▼───────────────────────────────┐                 │
 │  │ MV3 service worker (background.js)            │                 │
 │  │  • owns host_permission for the backend       │                 │
 │  │  • validates / normalises payloads            │                 │
 │  │  • retry, in-flight dedupe, session cache     │                 │
 │  └───────────────┬───────────────────────────────┘                 │
 └──────────────────┼─────────────────────────────────────────────────┘
                    │ POST http://127.0.0.1:8787/v1/translate
 ┌──────────────────▼─────────────────────────────────────────────────┐
 │ FastAPI backend                                                     │
 │  rate limit → sanitise → context window → cache → prompt → LLM      │
 │  → schema validation (one repair attempt) → response                │
 └──────────────────┬─────────────────────────────────────────────────┘
                    │ POST http://127.0.0.1:11434/api/chat (JSON schema)
 ┌──────────────────▼─────────────────────────────────────────────────┐
 │ Ollama + local model (qwen2.5:7b by default)                       │
 └────────────────────────────────────────────────────────────────────┘
```

## Why the service worker does the HTTP

Content scripts inherit the page's origin and CORS rules. A fetch from a content script to
`http://127.0.0.1:8787` would be a cross-origin request from `web.telegram.org` or
`web.whatsapp.com`, which their CSP or the browser can block. The extension service worker
has
`host_permissions` for loopback and can fetch freely; the content script only exchanges
messages with it.

## Content script

### Adapter detection

`lib/adapter-a.js`, `lib/adapter-k.js` and `lib/adapter-wa.js` are **data only**
(selector maps). `lib/adapter-registry.js` builds one adapter interface and decides which
client it is:

1. `body[data-lb-client]` / `html[data-lb-client]` override (used by the harness pages).
2. Hostname: `web.whatsapp.com` → WhatsApp.
3. URL path: `/a/…` → WebA, `/k/…` → WebK.
4. DOM sniffing as a last resort.

Each adapter also declares its `platform` (`telegram` or `whatsapp`), which is attached to
translation requests so the service worker can enforce the matching popup switch.

The adapter exposes `getRoot`, `getMessages`, `getMessageId`, `getMessageText`,
`getBubble`, `getSenderName`, `isOutgoing`, `getChatType`, `findOwner`. All callers are
client-agnostic.

### Message eligibility

A message gets a badge only when all of these hold:

- it is inside the detected message root,
- it is visible (`getClientRects().length > 0`),
- it is **not** outgoing (class token or geometry fallback),
- its extracted text contains at least one letter or number (`\p{L}`/`\p{N}`).

Outgoing and emoji-only messages have any previously injected UI removed. Edited messages
are detected by a text hash stored on the badge host; the old badge and panel are removed
and rebuilt.

### Observation

A single `MutationObserver` on `document.body` watches child-list and character-data
changes. Callbacks are coalesced (`schedule()` with a short timeout) and throttled
(`lastReconcile`), so virtualised-list churn cannot cause an injection storm. Mutations
inside injected UI (`[data-lb-ui]`) are ignored. A 5-second interval re-sweeps visible
pages to recover from missed mutations, and visibility/hash/popstate changes trigger a
refresh.

### Context window

On click, `lib/context-window.js` walks back from the target message through the visible
message list:

- at most 25 DOM nodes are scanned,
- at most `contextTurns` (3–5, configurable) translatable messages are kept,
- each message is clipped to 600 characters and the total to 2400,
- speaker labels are extracted ("Me" for own messages, sender name or "Other" otherwise),
- the target message is never duplicated into history.

The result is `{ history, chat_type, target_text }`.

### UI

`lib/ui.js` creates a `div` host with an **open shadow root** and loads `styles.css` into
it via `chrome.runtime.getURL`. Shadow DOM isolates the badge and panel from Telegram's or
WhatsApp's CSS (`all: initial` on the host, explicit component styles inside). The
document-level copy of `styles.css` only positions the hosts.

All model-provided strings (`translated_text`, `detected_tone`, `cultural_note`, source
language) are written with `textContent`, never `innerHTML`. The only `innerHTML` use is
the static SVG icon. The success panel renders only the translation and a
`Translated in X.Y seconds` line; tone, notes, dialect and model metadata stay in the API
response but are not shown.

Badge states: idle (green) → loading (spinner) → done (blue) or error (red, panel with retry).
Clicking the badge while a panel is open closes it.

### Standalone translator

`translator/translator.html` is a normal extension page opened from the popup. It shares
the language catalogue with the popup (`lib/languages.js`) and sends
`LB_TRANSLATE_TEXT` to the service worker. Input is capped at **250 characters** in the
textarea, checked again in `background.js`, so the backend never receives a long manual
translation. Unlike the platform badges, the page works while both `telegramEnabled` and
`whatsappEnabled` are off. The result shows only the translation and its response time.

### Theme

Dark mode is detected from `theme-dark`/`dark`/`night` classes on `<html>`/`<body>`, then
from the computed page background luminance. The boolean becomes `lb-dark` on the shadow
host, and `:host(.lb-dark)` rules style the components.

## Service worker

Responsibilities:

- read/normalise `chrome.storage.sync` settings, including independent
  `telegramEnabled` / `whatsappEnabled` switches (legacy `enabled` migrates to both),
- validate payload shape and clamp lengths (message 8000, history 8 entries / 2000 chars),
- reject badge requests when the sender's platform switch is off (the platform is derived
  from the sender URL, not trusted solely from the payload),
- return cached results immediately (`chrome.storage.session`, 1 hour TTL, LRU-ish eviction),
- de-duplicate concurrent identical requests via an in-flight map,
- `POST /v1/translate`, with one retry after 600 ms for transport/5xx errors,
- a 90 s abort timeout,
- `LB_PING` for the popup connection test (`/health/deep`, 5 s timeout); the popup shows
  only a friendly connected / not-connected message, never the URL or model,
- `LB_TRANSLATE_TEXT` for the standalone translator, ignoring the platform switches
  and enforcing a 250-character input limit.

Errors are normalised to `{ ok: false, error: { code, message, ... } }` for the content
script, which maps codes to human hints.

## Backend

### Request lifecycle (`app/service.py`)

1. **Rate limit** — sliding window per client IP (loopback, so effectively per browser).
2. **Normalise language** — aliases (`pt-br`, `brazilian`, `mandarin`, …) to canonical
   code + English name; unknown values pass through sanitised.
3. **Sanitise** — NFC, control/bidi removal, whitespace bounds. Emoji joiners and ZWNJ are
   preserved. Empty/emoji-only messages short-circuit to a passthrough response.
4. **History** — drop the target message if it was accidentally included, then build the
   sliding window (newest first, budget-aware; max 6 messages / 3000 chars).
5. **Cache** — SHA-256 over prompt version, model, message, target, source, chat type and
   prepared history. Cache hits return `meta.cached = true`.
6. **Prompt** — system rules + a user prompt with a random nonce delimiting
   `UNTRUSTED_HISTORY` and `UNTRUSTED_MESSAGE` blocks.
7. **Model call** — Ollama `/api/chat` with `format` set to a JSON schema and
   `temperature`/`num_ctx` options.
8. **Validation / repair** — parse to `LLMOutput`; on schema failure make exactly one
   repair request. In mock mode a failure is returned as an error instead of looping.
9. **Response** — clamp output, fill `meta`, store in the TTL cache.

### Multilingual and idiom policy

The system prompt treats romanised Indic text (Hinglish, Tanglish, Benglish, Roman Urdu,
Arabizi, Pinyin) as the underlying language, not as English-looking tokens, and tolerates
inconsistent spelling (`hogaya` / `ho gaya` / `hogaaya`). When the target is Hinglish the
model must answer in Latin script, never Devanagari.

Idioms, proverbs and fixed expressions are never translated word-for-word. If the target
language has a natural equivalent, the model uses it; otherwise it translates the sense
and adds a short parenthetical explanation in the target language, so the meaning is not
lost even though the UI hides `cultural_note`. A small set of examples in the system
prompt demonstrates these rules.

### LLM adapters (`app/llm.py`)

`LLMClient` is a protocol with `complete_json`, `health`, `aclose`.

- `OllamaClient` posts to `/api/chat`, maps HTTP/timeout/connection failures to typed
  `APIError`s with actionable messages, strips code fences if a model disobeys, and checks
  model presence via `/api/tags` for deep health.
- `MockClient` extracts the message block from the prompt and returns
  `translated_text = "[<Target>] <original>"` with a simple tone heuristic. It is used only
  when `LB_LLM_MODE=mock`.

Swapping providers means implementing this protocol; nothing else changes.

### Prompt-injection posture

- Untrusted content is always between nonce-delimited markers.
- The system prompt states the blocks are data and that instructions inside must be
  ignored.
- The request schema forbids extra fields; control and bidi characters are stripped.
- History is bounded, so an attacker cannot flood the context.
- Model output is validated against a schema before it is trusted.

**Known limitation:** a small local model can still partially obey an embedded instruction —
for example, dropping part of the message and emitting only the token it was told to output.
The nonce delimiters and prompt rules reduce this class of failure but are not a security
boundary. Do not treat translated output as instructions, links or code to execute.

### Output quality guards

- Invalid structured output gets one repair request that reuses the same prompt plus the
  bad JSON and an explicit correction instruction.
- If the model returns the source unchanged while the detected source language differs from
  the target, the service makes one extra history-free attempt with an explicit
  "translate, never repeat the original" instruction. The first result is kept when the
  retry is no better, so a retry can never make a response worse.
- Emoji-only or otherwise untranslatable messages short-circuit to passthrough and never
  reach the model.

### Errors

`APIError(status, code, message, retry_after)` plus handlers for validation and unexpected
errors produce one envelope:

```json
{ "error": { "code": "rate_limited", "message": "…" } }
```

Validation errors never echo submitted text, because it may be a private message.

## Data contract

The response contract is deliberately small and stable:

```
translated_text : string   (required, non-empty)
detected_tone   : string   (1–3 comma-separated tags)
cultural_note   : string   (may be empty)
meta            : object   (cached, passthrough, latency_ms, model, mode,
                            history_used, source_language_detected)
```

`meta` is additive; clients must ignore unknown fields. The prompt schema additionally
requires `source_language` from the model; it is folded into
`meta.source_language_detected`.

## Performance notes

- Translation is bounded by model speed. The 90 s timeout covers CPU cold starts; a warm
  7B model on GPU typically answers in well under a second.
- Two cache layers (worker session cache, backend TTL cache) make repeated clicks
  effectively instant.
- Reconcile work is throttled; badge injection is O(visible messages) per mutation burst,
  not per DOM node.
- `contain: layout style` on hosts limits layout impact.

## Failure modes and recovery

| Layer | Failure | Behaviour |
| ----- | ------- | --------- |
| Backend | Ollama down | `503 llm_unreachable`, retry panel with hint |
| Backend | model missing | `503 model_not_found`, pull hint |
| Backend | timeout | `504 llm_timeout` |
| Backend | bad model JSON | one repair call, then `502 llm_invalid_output` |
| Worker | backend down | one retry, then `backend_unreachable` |
| Worker | slow backend | abort at 90 s → `backend_timeout` |
| Content | panel closes / navigation | response discarded when bubble detaches |
| Content | edited message | hash mismatch removes stale UI and re-renders |
