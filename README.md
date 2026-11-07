# LinguaBridge

Context-aware AI translation for **Telegram Web**, running entirely on your own machine.

LinguaBridge is a Manifest V3 Chrome extension plus a small FastAPI backend. Incoming
messages get a subtle translate badge; clicking one sends that message — together with the
few messages before it — to a **local Ollama model**. The model returns a natural
translation and how long it took.

Nothing is translated automatically. Nothing leaves your computer.

```
Telegram Web  ──click──▶  content script  ──▶  service worker  ──HTTP──▶  FastAPI  ──▶  Ollama
   (WebA/WebK)              (badge + panel)        (host permission)      127.0.0.1:8787
```

## Features

- **Opt-in only.** Every incoming text message gets a green badge. Translation starts when
  you click it, never before.
- **Incoming messages only.** Your own messages are intentionally left alone.
- **Conversational context.** The previous 3–5 visible messages are sent with the target
  message, speaker-labelled, so sarcasm, slang and pronouns resolve correctly.
- **Hinglish and romanised Indic languages.** Hinglish, Tanglish, Benglish, Roman Urdu and
  other Latin-script forms of Indian languages are understood and translated by meaning —
  `"ye sab thik ho gaya hai"` becomes "It's all sorted out", not a word-by-word reading.
- **Idioms handled, not mangled.** A matching idiom is used when one exists; otherwise the
  meaning is translated with a short explanation in the target language.
- **Minimal result.** The panel shows the translation and `Translated in X.Y seconds`.
  Nothing else — no model name, tone tags or dialect labels.
- **Standalone text translator.** A dedicated page translates any sentence or paragraph you
  type, up to 250 characters, so manual translations stay short and fast.
- **Both Telegram clients.** Works on `web.telegram.org/a/` (WebA, React) and
  `web.telegram.org/k/` (WebK).
- **Local-first.** No cloud LLM, no API keys, no analytics. The backend binds to
  `127.0.0.1` only.
- **Resilient.** TTL cache, request de-duplication, automatic retry, rate limiting, and
  prompt-injection defences.
- **Deterministic mock mode.** Develop the UI without pulling a model.

## Requirements

| Component | Version |
| --------- | ------- |
| Chrome / Chromium | 116+ (Manifest V3, `chrome.storage.session`) |
| Python | 3.10+ |
| Ollama | any recent release |

A GPU is nice but not required. A 7–8B quantised model needs roughly 5–6 GB of RAM/VRAM.

## Quick start

### 1. Ollama

```bash
ollama serve            # usually already running as a service
ollama pull qwen2.5:7b  # good multilingual quality/size trade-off
```

`llama3.1:8b`, `gemma2:9b`, `mistral-nemo` and similar multilingual models also work.
Set the model in `backend/.env` (see [Configuration](#configuration)).

`qwen2.5:7b` is a ~4.7 GB download and runs fully on GPU in about 4.8 GB of VRAM with a
4k context. Warm translations typically take 1–3 s; the first request after the model
unloads takes longer while the weights are read.

### 2. Backend

```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate
pip install -e ".[dev]"
cp .env.example .env
./run.sh
```

Verify:

```bash
curl http://127.0.0.1:8787/health
curl http://127.0.0.1:8787/health/deep
```

`/health/deep` reports whether Ollama is reachable and whether the configured model is
present.

**No model yet?** Run in mock mode — same API, deterministic placeholder output:

```bash
LB_LLM_MODE=mock ./run.sh
```

### 3. Extension

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. **Load unpacked** → select the `frontend/` directory.
4. Open <https://web.telegram.org/a/> or <https://web.telegram.org/k/> and reload the tab.
5. Incoming messages now show a small badge.

On first install the extension opens its settings page and asks **which language you
want to read in**. Pick it there (or click the toolbar icon anytime); the choice is
global and saved immediately, not per message.

The popup (toolbar icon) asks which language you want to read in using a searchable
combobox over an alphabetical list, lets you change the context window (3/4/5), and tests
the backend connection with a plain “connected” or “couldn't connect” result. **Test
connection** never shows the endpoint or model name.

Click **Text translator** in the popup to open the standalone translator page. Type or
paste up to 250 characters, pick a target language, and press **Translate** (or
`Ctrl`/`Cmd`+`Enter`). The result appears below with its response time. The translator
works even when Telegram badges are switched off.

## Usage

| Action | Result |
| ------ | ------ |
| Click a message badge | Translates that message using the preceding turns |
| Click again | Closes the panel |
| Text translator (popup) | Opens the 250-character standalone translator |
| Edited message | Badge is refreshed and the stale translation discarded |
| Switching chats | Badges re-render; cache keys are scoped per chat |

Badges appear only on **incoming** text messages. Emoji-only, sticker, media-only and
service messages are skipped. A **green** badge means "ready to translate"; it turns
**blue** once that message has been translated, shows a spinner while waiting, and turns
red with a retry panel on error.

## Configuration

Backend settings are environment variables prefixed with `LB_` (see
`backend/.env.example`). The most useful ones:

| Variable | Default | Purpose |
| -------- | ------- | ------- |
| `LB_LLM_MODE` | `ollama` | `ollama` or `mock` |
| `LB_OLLAMA_BASE_URL` | `http://127.0.0.1:11434` | Ollama endpoint |
| `LB_OLLAMA_MODEL` | `qwen2.5:7b` | Any pulled model |
| `LB_OLLAMA_TIMEOUT_S` | `90` | Cold-start allowance |
| `LB_TEMPERATURE` | `0.2` | Lower is more literal |
| `LB_MAX_MESSAGE_CHARS` | `4000` | Per-message input cap |
| `LB_MAX_HISTORY_MESSAGES` | `6` | Hard cap on context turns |
| `LB_RATE_LIMIT_PER_MINUTE` | `30` | Local request budget |
| `LB_CACHE_TTL_S` | `3600` | Translation cache lifetime |
| `LB_HOST` / `LB_PORT` | `127.0.0.1` / `8787` | Bind address |

Extension settings live in `chrome.storage.sync` and are edited in the popup:
`enabled`, `targetLanguage`, `contextTurns` (plus a one-time `onboardingDone` flag). The
backend URL defaults to `http://127.0.0.1:8787` and is no longer shown in the popup; host
permissions cover every loopback port. If you change `LB_PORT`, set the new URL from the
service-worker console (`chrome://extensions` → LinguaBridge → **service worker**):

```js
chrome.storage.sync.set({ backendUrl: "http://127.0.0.1:9000" });
```

## API

The backend exposes four endpoints:

| Method | Path | Description |
| ------ | ---- | ----------- |
| `GET` | `/health` | Liveness |
| `GET` | `/health/deep` | Liveness + Ollama/model status |
| `GET` | `/v1/languages` | Supported language codes and names |
| `POST` | `/v1/translate` | Translate one message with context |

Request:

```json
{
  "message": "No mames, obvio que no.",
  "target_language": "en",
  "source_language": "auto",
  "chat_type": "private",
  "history": [
    { "role": "other", "speaker": "Ana", "text": "¿Vienes a la fiesta?" },
    { "role": "self",  "speaker": "Me",  "text": "Depende, ¿va a estar tu hermano?" }
  ],
  "message_id": "1234"
}
```

Response:

```json
{
  "translated_text": "No way, obviously not.",
  "detected_tone": "casual, emphatic",
  "cultural_note": "\"No mames\" is a very informal Mexican expression of disbelief.",
  "meta": {
    "cached": false,
    "passthrough": false,
    "latency_ms": 812,
    "model": "qwen2.5:7b",
    "mode": "ollama",
    "history_used": 2,
    "source_language_detected": "Spanish"
  }
}
```

Errors use a stable envelope: `{"error": {"code": "...", "message": "..."}}` with
`429`/`413`/`422`/`502`/`503`/`504` status codes.

Interactive docs: <http://127.0.0.1:8787/docs>.

## Privacy and safety

- Only messages you explicitly click are sent, plus the preceding visible turns.
- Requests go to `127.0.0.1:8787`, which talks to Ollama on `127.0.0.1:11434`. Nothing is
  forwarded to a cloud provider.
- The backend does not log message content; logs contain counts, target language, mode and
  latency.
- Model output is inserted with `textContent`, never `innerHTML`.
- Input is sanitised (control/bidi characters stripped) and bounded. A random nonce
  delimits untrusted message and history blocks, and the system prompt instructs the model
  to treat them strictly as data.
- CORS is restricted to the extension origin, `web.telegram.org`, and loopback.
- The backend must stay bound to loopback. Do not expose port 8787.

## Development

```bash
# backend tests (48 tests)
cd backend && .venv/bin/python -m pytest -q

# JS syntax
node --check frontend/content.js

# icons
python3 scripts/make_icons.py
```

### DOM harness

Deterministic fixture pages stand in for both Telegram clients:

```bash
python3 -m http.server 8788 --directory frontend/debug
```

Open `http://127.0.0.1:8788/harness-a.html` or `harness-k.html` with the extension loaded.
Content-script match patterns cannot contain ports, so the manifest uses
`http://127.0.0.1/*` matches narrowed by `include_globs` to port `8788`.

### End-to-end smoke test

`scripts/e2e-harness.mjs` drives a real Chrome over CDP and asserts badge injection,
incoming-only behaviour, bubble positioning, panel rendering, the time line and theming on
both
harness pages.

```bash
# prerequisites: harness server on :8788, backend on :8787, Chrome with CDP on :9222
node scripts/e2e-harness.mjs
```

> Branded Google Chrome ignores `--load-extension`. Use Chrome for Testing (or Chromium):
> `npx @puppeteer/browsers install chrome@stable`, then launch with
> `--disable-extensions-except=$PWD/frontend --load-extension=$PWD/frontend`.

### Packaging

```bash
make package   # -> dist/linguabridge-extension-0.1.0.zip (debug pages excluded)
```

## Project layout

```
backend/
  app/            FastAPI app, LLM adapters, prompts, sanitisation, cache
  tests/          pytest suite
  .env.example    configuration reference
  run.sh          dev server launcher
frontend/
  manifest.json   MV3 manifest
  content.js      observation, badge lifecycle, click handling
  background.js   HTTP, retry, dedupe, cache
  styles.css      shadow-DOM component styles
  lib/            adapter registry, UI, context window, sanitising, messaging,
                  shared language catalogue
  popup/          settings UI
  translator/     standalone 250-character translator page
  debug/          local DOM fixtures (not packaged)
  icons/          generated PNGs
docs/
  architecture.md
  selectors.md
  manual-test-plan.md
scripts/
  make_icons.py
  e2e-harness.mjs
```

## Troubleshooting

| Symptom | Fix |
| ------- | --- |
| No badges | Reload the Telegram tab after loading the extension. Confirm the URL is `/a/` or `/k/`. |
| "Backend is up, but Ollama is not reachable" | Start Ollama (`ollama serve`) and re-test from the popup. |
| "model is not pulled" | `ollama pull <model>` matching `LB_OLLAMA_MODEL`. |
| First click is slow | Cold model load. Increase `LB_OLLAMA_TIMEOUT_S` or send one warm-up request. |
| Wrong or echoed translation | The backend retries once when a model returns the source unchanged; a stronger model (7B+) avoids most cases. |
| `backend_unreachable` | Backend not running, or URL/port in the popup does not match `LB_PORT`. |
| Badges on local pages | Local injection is limited to port 8788 by `include_globs`. |
| CORS errors in the page console | All HTTP is done by the service worker; if you see page-level fetches, reload the extension. |

See [docs/architecture.md](docs/architecture.md) for the request lifecycle and
[docs/manual-test-plan.md](docs/manual-test-plan.md) for the full test checklist.
