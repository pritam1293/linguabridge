SHELL := /bin/bash
VERSION := 0.2.0
EXT_DIR := frontend
DIST := dist/linguabridge-extension-$(VERSION).zip
PY := backend/.venv/bin/python
STAMP := backend/.venv/.installed

.PHONY: help setup backend backend-mock test check icons harness e2e package clean clean-venv

help:
	@echo "LinguaBridge"
	@echo
	@echo "  make setup         Create the backend virtualenv and install deps"
	@echo "  make backend       Run the backend (Ollama mode) on 127.0.0.1:8787"
	@echo "  make backend-mock  Run the backend in deterministic mock mode"
	@echo "  make test          Run backend tests"
	@echo "  make check         Validate manifest, JS syntax and Python imports"
	@echo "  make icons         Regenerate extension icons"
	@echo "  make harness       Serve the DOM fixtures on 127.0.0.1:8788"
	@echo "  make e2e           Run the CDP browser smoke test (see README)"
	@echo "  make package       Build $(DIST)"
	@echo "  make clean         Remove dist and caches"
	@echo "  make clean-venv    Remove the backend virtualenv"

$(STAMP):
	python3 -m venv backend/.venv
	backend/.venv/bin/pip install -q --upgrade pip
	cd backend && .venv/bin/pip install -q -e ".[dev]"
	touch $(STAMP)

setup: $(STAMP)

backend: $(STAMP)
	cd backend && .venv/bin/uvicorn app.main:app --host 127.0.0.1 --port 8787 --reload

backend-mock: $(STAMP)
	cd backend && LB_LLM_MODE=mock .venv/bin/uvicorn app.main:app --host 127.0.0.1 --port 8787 --reload

test: $(STAMP)
	cd backend && .venv/bin/python -m pytest -q

check: $(STAMP)
	python3 -m json.tool $(EXT_DIR)/manifest.json > /dev/null
	@for f in $(EXT_DIR)/background.js $(EXT_DIR)/content.js \
	          $(EXT_DIR)/lib/*.js $(EXT_DIR)/popup/popup.js \
	          $(EXT_DIR)/translator/*.js; do \
	  node --check "$$f" || exit 1; \
	done
	$(PY) -m compileall -q backend/app backend/tests
	@echo "manifest, JS and Python syntax OK"

icons:
	python3 scripts/make_icons.py

harness:
	python3 -m http.server 8788 --directory $(EXT_DIR)/debug

e2e: check
	node scripts/e2e-harness.mjs

package: check
	mkdir -p dist
	rm -f $(DIST)
	cd $(EXT_DIR) && zip -qr ../$(DIST) . -x 'debug/*' -x '*.DS_Store'
	@echo "built $(DIST)"
	@unzip -l $(DIST) | tail -1

clean:
	rm -rf dist
	find backend -type d -name __pycache__ -prune -exec rm -rf {} +
	rm -rf backend/.pytest_cache

clean-venv:
	rm -rf backend/.venv
