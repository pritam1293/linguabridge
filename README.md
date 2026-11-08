# LinguaBridge

**LinguaBridge - contextual AI translation for chatting apps.**

A Manifest V3 Chrome extension plus a local FastAPI backend. Translates incoming Telegram Web and WhatsApp Web messages on click, using the preceding messages as context. Runs entirely on your machine — no cloud LLM, no API keys, no analytics.

```
Telegram / WhatsApp Web ──click badge──▶ content script ──▶ service worker ──HTTP──▶ FastAPI ──▶ Ollama
   (WebA / WebK / WhatsApp)              (badge + panel)      (127.0.0.1:8787)                   127.0.0.1:11434
```

## What it does

- Adds a small badge to **incoming** messages only; translation starts when you click it.
- Sends the clicked message plus the previous 3–5 visible messages for context.
- Handles slang, idioms, Hinglish and other romanised Indic languages by meaning, not word-for-word.
- Shows only the translation and `Translated in X.Y seconds`.
- Has a standalone text translator page (up to 250 characters).
- Separate on/off switches for Telegram and WhatsApp.
- Everything stays on loopback: extension → `127.0.0.1:8787` → Ollama → `127.0.0.1:11434`.

## Supported sites

| Site | URL |
| ---- | --- |
| Telegram WebA | `https://web.telegram.org/a/` |
| Telegram WebK | `https://web.telegram.org/k/` |
| WhatsApp Web | `https://web.whatsapp.com/` |

## Models

| Item | Details |
| ---- | ------- |
| Default model | `qwen2.5:7b` (~4.7 GB download) |
| Other options | `llama3.1:8b`, `gemma2:9b`, `mistral-nemo`, or any multilingual model you pull in Ollama |
| Runtime | [Ollama](https://ollama.com) on `http://127.0.0.1:11434` |
| Hardware | GPU optional; a 7–8B quantised model needs ~5–6 GB RAM/VRAM |
| Mock mode | `LB_LLM_MODE=mock` — deterministic output, no model needed |

Warm translations typically take 1–3 s; the first request may take longer while weights load.

## Tech stack

| Layer | Stack |
| ----- | ----- |
| Extension | Chrome Manifest V3, vanilla JavaScript, Shadow DOM, `chrome.storage.sync` |
| Backend | Python 3.10+, FastAPI, Uvicorn, httpx, Pydantic v2, pydantic-settings |
| LLM runtime | Ollama |
| Tests / tooling | pytest, Node.js (`node --check`, CDP E2E), Make |

## Requirements

| Component | Version |
| --------- | ------- |
| Chrome / Chromium | 116+ |
| Python | 3.10+ |
| Ollama | any recent release |
| Node.js | only for dev checks / E2E |

## Setup

### 1. Ollama

```bash
ollama serve
ollama pull qwen2.5:7b
```

Change the model with `LB_OLLAMA_MODEL` in `backend/.env`.

### 2. Backend

```bash
make setup     # creates backend/.venv and installs deps
cp backend/.env.example backend/.env
make backend   # http://127.0.0.1:8787
```

Manual equivalent:

```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate
pip install -e ".[dev]"
cp .env.example .env
./run.sh
```

Mock mode (no Ollama):

```bash
make backend-mock
```

Verify:

```bash
curl http://127.0.0.1:8787/health
curl http://127.0.0.1:8787/health/deep
```

### 3. Extension

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. **Load unpacked** → select `frontend/`.
4. Open Telegram Web or WhatsApp Web and reload the tab.
5. On first install, pick the language you want to read in.

## Usage

| Action | Result |
| ------ | ------ |
| Click a message badge | Translates that message using the preceding turns |
| Click again | Closes the panel |
| Text translator (popup) | Opens the standalone 250-character translator |
| Edited message | Badge refreshes; stale translation is discarded |
| Switching chats | Badges re-render; cache is scoped per chat |

Badges appear only on incoming text messages. Emoji-only, sticker, media-only and service messages are skipped. Green = ready, blue = translated, spinner = waiting, red = error with retry.

## Settings

### Extension (popup / toolbar icon)

| Setting | Options |
| ------- | ------- |
| Read messages in | Target language (searchable list) |
| Telegram | On / off — badges on incoming Telegram messages |
| WhatsApp | On / off — badges on incoming WhatsApp messages |
| Context window | 3, 4 or 5 previous messages |
| Test connection | Checks the backend without showing endpoint or model |
| Text translator | Opens the standalone translator page |
| Clear translation cache | Clears cached translations |

Platform switches save immediately; other settings use **Save**. Settings live in `chrome.storage.sync`.

### Backend (`backend/.env`, all optional)

| Variable | Default | Purpose |
| -------- | ------- | ------- |
| `LB_LLM_MODE` | `ollama` | `ollama` or `mock` |
| `LB_OLLAMA_BASE_URL` | `http://127.0.0.1:11434` | Ollama endpoint |
| `LB_OLLAMA_MODEL` | `qwen2.5:7b` | Any pulled model |
| `LB_OLLAMA_TIMEOUT_S` | `90` | Cold-start allowance |
| `LB_OLLAMA_NUM_CTX` | `4096` | Context size |
| `LB_OLLAMA_KEEP_ALIVE` | `30m` | Model keep-alive |
| `LB_TEMPERATURE` | `0.2` | Lower is more literal |
| `LB_MAX_MESSAGE_CHARS` | `4000` | Per-message input cap |
| `LB_MAX_HISTORY_MESSAGES` | `6` | Hard cap on context turns |
| `LB_MAX_HISTORY_CHARS` | `3000` | History character cap |
| `LB_RATE_LIMIT_PER_MINUTE` | `30` | Local request budget |
| `LB_CACHE_TTL_S` | `3600` | Translation cache lifetime |
| `LB_HOST` / `LB_PORT` | `127.0.0.1` / `8787` | Bind address |
| `LB_LOG_LEVEL` | `INFO` | Log level |

The extension's backend URL defaults to `http://127.0.0.1:8787`. If you change `LB_PORT`, set it from the service-worker console (`chrome://extensions` → LinguaBridge → **service worker**):

```js
chrome.storage.sync.set({ backendUrl: "http://127.0.0.1:9000" });
```

## API

| Method | Path | Description |
| ------ | ---- | ----------- |
| `GET` | `/health` | Liveness |
| `GET` | `/health/deep` | Liveness + Ollama/model status |
| `GET` | `/v1/languages` | Supported language codes and names |
| `POST` | `/v1/translate` | Translate one message with context |

Interactive docs: <http://127.0.0.1:8787/docs>.

## Privacy

- Only messages you click are sent, plus the preceding visible turns.
- All traffic stays on loopback: `127.0.0.1:8787` → Ollama `127.0.0.1:11434`.
- Message content is not logged; logs contain counts, language, mode and latency.
- Model output is inserted with `textContent`, never `innerHTML`.
- Input is sanitised and bounded; a random nonce delimits untrusted message blocks and the prompt treats them as data.
- CORS is restricted to the extension origin, `web.telegram.org`, `web.whatsapp.com` and loopback.
- Do not expose port 8787.

## Development

```bash
make test      # backend pytest suite
make check     # manifest, JS syntax, Python imports
make icons     # regenerate extension icons
make harness   # DOM fixtures on http://127.0.0.1:8788
make e2e       # CDP browser smoke test (requires harness + backend + Chrome CDP on :9222)
make package   # -> dist/linguabridge-extension-0.2.0.zip
make clean
```

Branded Google Chrome ignores `--load-extension`; use Chrome for Testing or Chromium:

```bash
npx @puppeteer/browsers install chrome@stable
```

## Project layout

```
backend/         FastAPI app, Ollama/mock adapters, prompts, cache, tests
frontend/        MV3 extension: content script, service worker, adapters, popup, translator
docs/            architecture, selectors, manual test plan
scripts/         icon generator, CDP E2E harness
Makefile         setup / run / test / package commands
```

## Troubleshooting

| Symptom | Fix |
| ------- | --- |
| No badges | Reload the tab; confirm the site switch is on and the URL is supported. |
| `Extension context invalidated` | Reload the tab after reloading/updating the extension. |
| WhatsApp badges missing | Check the console for the adapter's detected-message count; markup may have changed. |
| Translation unavailable | Start Ollama (`ollama serve`) and run **Test connection**. |
| "model is not pulled" | `ollama pull <model>` matching `LB_OLLAMA_MODEL`. |
| First click slow | Cold model load; raise `LB_OLLAMA_TIMEOUT_S` or send a warm-up request. |
| `backend_unreachable` | Backend not running, or `backendUrl` does not match `LB_PORT`. |
| CORS errors | All HTTP should go through the service worker; reload the extension. |

More: [docs/architecture.md](docs/architecture.md) · [docs/manual-test-plan.md](docs/manual-test-plan.md) · [docs/selectors.md](docs/selectors.md)
