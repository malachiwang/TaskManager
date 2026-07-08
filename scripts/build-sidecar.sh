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
# 3. Clean stale artifacts from previous builds
# ---------------------------------------------------------------------------

DIST_DIR="$PROJECT_ROOT/dist-sidecar"
WORK_DIR="$PROJECT_ROOT/build-sidecar-tmp"
BINARIES_DIR="$PROJECT_ROOT/src-tauri/binaries"
DEST_BIN="$BINARIES_DIR/taskos-server-$TARGET_TRIPLE"

# Remove stale sidecar binary so a failed build doesn't leave old binary in place.
rm -f "$DEST_BIN"
# Remove stale onedir output if a previous run used --onedir.
rm -rf "$DIST_DIR/taskos-server"

# ---------------------------------------------------------------------------
# 4. Run PyInstaller (--onefile for Tauri sidecar compatibility)
#
# --onefile: embeds Python runtime + all modules into a single self-extracting
#   binary. Required for Tauri externalBin, which bundles a single file — not
#   a directory tree. The --onedir output requires an adjacent _internal/ folder
#   which Tauri cannot bundle alongside the sidecar executable.
#
# --paths: adds project root to PyInstaller's module search path so that the
#   backend package is found during static analysis.
#
# --collect-submodules backend: explicitly collects all submodules under
#   backend/ (main, database, logic, etc.) even if not directly imported by
#   static analysis from server.py.
#
# --specpath build-sidecar-tmp: keeps the generated .spec inside the work dir
#   rather than the repo root.
# ---------------------------------------------------------------------------

echo "Building sidecar with PyInstaller (--onefile)..."
pyinstaller \
  --onefile \
  --name taskos-server \
  --distpath "$DIST_DIR" \
  --workpath "$WORK_DIR" \
  --specpath "$WORK_DIR" \
  --paths "$PROJECT_ROOT" \
  --collect-submodules backend \
  --exclude-module PyQt5 \
  --exclude-module PyQt6 \
  --exclude-module PySide2 \
  --exclude-module PySide6 \
  --exclude-module tkinter \
  --exclude-module IPython \
  --exclude-module jedi \
  --exclude-module nbformat \
  --exclude-module pytest \
  --noconfirm \
  --add-data "$PROJECT_ROOT/PRIVACY.md:." \
  --add-data "$PROJECT_ROOT/ACCESSIBILITY.md:." \
  --add-data "$PROJECT_ROOT/TERMS.md:." \
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
# 5. Copy onefile binary to src-tauri/binaries/ with target-triple suffix
# ---------------------------------------------------------------------------

mkdir -p "$BINARIES_DIR"

SRC_BIN="$DIST_DIR/taskos-server"

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
