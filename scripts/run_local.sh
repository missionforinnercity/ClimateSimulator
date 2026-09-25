#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENV_PYTHON="$PROJECT_ROOT/.venv/bin/python"
UVICORN="$PROJECT_ROOT/.venv/bin/uvicorn"

if [[ ! -x "$UVICORN" ]]; then
  echo "Could not find .venv/bin/uvicorn. Set up the environment first:"
  echo "  python3.12 -m venv .venv"
  echo "  .venv/bin/python -m pip install -r requirements-dev.txt"
  exit 1
fi

PORT="${PORT:-8000}"
cd "$PROJECT_ROOT"
echo "Starting Conditions at http://localhost:$PORT (Ctrl+C to stop)"
exec "$UVICORN" server.app:app --host 127.0.0.1 --port "$PORT"
