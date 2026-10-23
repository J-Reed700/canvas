#!/usr/bin/env bash
# Canvas Forge Studio bootstrap and launcher.
set -euo pipefail

cd "$(dirname "$0")"

if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "✗ Error: 'ffmpeg' is required but was not found on your PATH."
  echo "  Install on macOS : brew install ffmpeg"
  echo "  Install on Ubuntu: sudo apt install ffmpeg"
  exit 1
fi

PYTHON_BIN="${PYTHON:-python3}"
if ! command -v "$PYTHON_BIN" >/dev/null 2>&1; then
  echo "✗ Error: Python 3.10+ is required."
  exit 1
fi

if [ ! -d ".venv" ]; then
  echo "✦ Creating isolated Python virtual environment (.venv)..."
  "$PYTHON_BIN" -m venv .venv
fi

if ! ./.venv/bin/python -c "import cv2, numpy" >/dev/null 2>&1; then
  echo "✦ Installing dependencies (numpy + opencv-python-headless)..."
  ./.venv/bin/pip install --upgrade pip -q
  ./.venv/bin/pip install -e . -q
fi

exec ./.venv/bin/python -m canvasforge "$@"
