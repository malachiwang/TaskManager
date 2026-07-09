#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# package-macos.sh — Build a distributable macOS TaskManager.app + .dmg.
#
# Wraps the three existing build steps in the right order:
#   1. scripts/build-sidecar.sh              (bundle the Python backend)
#   2. frontend production build             (VITE_API_BASE → packaged port)
#   3. tauri build                           (bundle .app and .dmg)
#
# Prerequisites (see docs/RELEASE.md):
#   - Rust toolchain (rustc, cargo)
#   - Python venv active with requirements.txt installed (incl. pyinstaller)
#   - Node 18+ with frontend dependencies installed (npm --prefix frontend ci)
#
# Output (NOT tracked by git — never commit these):
#   src-tauri/target/release/bundle/macos/TaskManager.app
#   src-tauri/target/release/bundle/dmg/TaskManager_<version>_<arch>.dmg
#
# The bundle is unsigned/not notarized — see docs/INSTALL.md for the
# first-open steps end users need on macOS.
#
# Usage:
#   ./scripts/package-macos.sh
# ---------------------------------------------------------------------------
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_ROOT"

# Verify we are actually at the repo root before building anything.
if [[ ! -f "backend/main.py" || ! -f "src-tauri/tauri.conf.json" ]]; then
  echo "ERROR: expected to run from the TaskManagementOS repository root."
  echo "       (backend/main.py or src-tauri/tauri.conf.json not found at $PROJECT_ROOT)"
  exit 1
fi

PACKAGED_API_BASE="http://127.0.0.1:8765"

echo "==> [1/3] Building Python sidecar"
./scripts/build-sidecar.sh

echo "==> [2/3] Building frontend (VITE_API_BASE=$PACKAGED_API_BASE)"
VITE_API_BASE="$PACKAGED_API_BASE" npm --prefix frontend run build

echo "==> [3/3] Building Tauri bundle"
VITE_API_BASE="$PACKAGED_API_BASE" npm --prefix frontend run tauri:build

BUNDLE_DIR="$PROJECT_ROOT/src-tauri/target/release/bundle"
echo ""
echo "Done. Build artifacts:"
echo "  app:  $BUNDLE_DIR/macos/TaskManager.app"
ls "$BUNDLE_DIR/dmg/"*.dmg 2>/dev/null | sed 's/^/  dmg:  /' || echo "  dmg:  (no .dmg produced — check tauri output above)"
echo ""
echo "NOTE: generated bundles and src-tauri/target are build artifacts."
echo "      Do NOT commit them — attach the .dmg to a GitHub Release instead."
