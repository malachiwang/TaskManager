#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# build-sidecar.sh — Build the Python/FastAPI backend as a Tauri sidecar.
#
# Prerequisites:
#   - Rust toolchain installed (rustc, cargo)
#   - Python venv active with requirements.txt installed (includes pyinstaller)
#   - Run from any directory — script resolves project root automatically.
#
# Output:
#   src-tauri/binaries/taskos-server-<target-triple>
#
# Usage:
#   ./scripts/build-sidecar.sh
# ---------------------------------------------------------------------------
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_ROOT"

# ---------------------------------------------------------------------------
# 1. Validate prerequisites
# ---------------------------------------------------------------------------

if ! command -v rustc &>/dev/null; then
  echo "ERROR: rustc not found. Install the Rust toolchain first:"
  echo "  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh"
  exit 1
fi

if ! command -v pyinstaller &>/dev/null; then
  echo "ERROR: pyinstaller not found. Install it:"
  echo "  pip install -r requirements.txt"
  exit 1
fi

if [ ! -f "backend/server.py" ]; then
  echo "ERROR: backend/server.py not found."
  exit 1
fi

# ---------------------------------------------------------------------------
# 2. Detect Rust target triple
# ---------------------------------------------------------------------------

TARGET_TRIPLE="$(rustc -vV | grep '^host:' | cut -d' ' -f2)"
if [ -z "$TARGET_TRIPLE" ]; then
  echo "ERROR: Could not detect Rust target triple from rustc -vV."
  exit 1
fi
echo "Target triple: $TARGET_TRIPLE"

# ---------------------------------------------------------------------------
# 3. Run PyInstaller
# ---------------------------------------------------------------------------

DIST_DIR="$PROJECT_ROOT/dist-sidecar"

echo "Building sidecar with PyInstaller..."
pyinstaller \
  --onedir \
  --name taskos-server \
  --distpath "$DIST_DIR" \
  --workpath "$PROJECT_ROOT/build-sidecar-tmp" \
  --noconfirm \
  --hidden-import uvicorn.logging \
  --hidden-import uvicorn.loops \
  --hidden-import uvicorn.loops.auto \
  --hidden-import uvicorn.protocols.http \
  --hidden-import uvicorn.protocols.http.auto \
  --hidden-import uvicorn.protocols.http.h11_impl \
  --hidden-import uvicorn.lifespan.off \
  --hidden-import uvicorn.lifespan.on \
  --hidden-import fastapi \
  --hidden-import starlette.routing \
  --hidden-import starlette.middleware.cors \
  backend/server.py

# ---------------------------------------------------------------------------
# 4. Copy binary to src-tauri/binaries/ with target-triple suffix
# ---------------------------------------------------------------------------

BINARIES_DIR="$PROJECT_ROOT/src-tauri/binaries"
mkdir -p "$BINARIES_DIR"

SRC_BIN="$DIST_DIR/taskos-server/taskos-server"
DEST_BIN="$BINARIES_DIR/taskos-server-$TARGET_TRIPLE"

if [ ! -f "$SRC_BIN" ]; then
  echo "ERROR: PyInstaller output not found at $SRC_BIN"
  exit 1
fi

cp "$SRC_BIN" "$DEST_BIN"
chmod +x "$DEST_BIN"

echo ""
echo "Sidecar built successfully:"
echo "  $DEST_BIN"
echo ""
echo "Next step: npm --prefix frontend run tauri:build"
