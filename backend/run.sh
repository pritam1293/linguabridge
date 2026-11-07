#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

PYTHON="${PYTHON:-python3}"

if [ ! -d .venv ]; then
  "$PYTHON" -m venv .venv
fi
# shellcheck disable=SC1091
source .venv/bin/activate

pip install -q -e ".[dev]"

exec uvicorn app.main:app \
  --host "${LB_HOST:-127.0.0.1}" \
  --port "${LB_PORT:-8787}" \
  --reload
