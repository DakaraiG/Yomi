#!/usr/bin/env bash
# Start the sidecar with the vendored detector wired up.
#
# Both variables below are required by app/detector.py, which validates them
# at startup and fails with a message naming whichever one is wrong. Paths are
# resolved against this script's location, not the caller's cwd, so this works
# from anywhere.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
cd "$ROOT"

# Checkout of dmMaze/comic-text-detector (GPL-3.0, not on PyPI -- vendored).
export YOMI_CTD_PATH="${YOMI_CTD_PATH:-$ROOT/vendor/comic-text-detector}"
# Weights from the manga-image-translator beta-0.2.1 release tag.
export YOMI_CTD_MODEL="${YOMI_CTD_MODEL:-$ROOT/weights/comictextdetector.pt}"
# cpu | cuda | mps
export YOMI_DEVICE="${YOMI_DEVICE:-cpu}"

# Prefer the repo venv over whatever uvicorn is on PATH -- a system-wide one
# resolves fine but may be a different interpreter with different packages.
UVICORN="$ROOT/.venv/bin/uvicorn"
[ -x "$UVICORN" ] || UVICORN="uvicorn"

exec "$UVICORN" app.main:app --reload --port "${YOMI_PORT:-8001}"
