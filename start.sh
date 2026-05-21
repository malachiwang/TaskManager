#!/usr/bin/env bash
set -euo pipefail

# ---------------------------------------------------------------------------
# TaskManagementOS — dev workspace startup
# Usage: ./start.sh
# ---------------------------------------------------------------------------

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# ---------------------------------------------------------------------------
# 1. Validate project structure
# ---------------------------------------------------------------------------

if [ ! -f "backend/main.py" ]; then
  echo "ERROR: backend/main.py not found. Run from the project root or check your checkout."
  exit 1
fi

if [ ! -f "frontend/package.json" ]; then
  echo "ERROR: frontend/package.json not found."
  exit 1
fi

if [ ! -f ".venv/bin/activate" ]; then
  echo "ERROR: .venv not found."
  echo "  Create the virtualenv first:"
  echo "    python3 -m venv .venv"
  echo "    source .venv/bin/activate"
  echo "    pip install -r requirements.txt"
  exit 1
fi

# ---------------------------------------------------------------------------
# 2. Activate venv
# ---------------------------------------------------------------------------

# shellcheck source=/dev/null
source .venv/bin/activate

# ---------------------------------------------------------------------------
# 3. Validate required commands
# ---------------------------------------------------------------------------

if ! command -v python3 &>/dev/null; then
  echo "ERROR: python3 not found."
  exit 1
fi

if ! command -v node &>/dev/null; then
  echo "ERROR: node not found. Install Node 18+."
  exit 1
fi

if ! command -v npm &>/dev/null; then
  echo "ERROR: npm not found. Install Node 18+."
  exit 1
fi

if ! command -v uvicorn &>/dev/null; then
  echo "ERROR: uvicorn not found in the active virtualenv."
  echo "  Run: pip install -r requirements.txt"
  exit 1
fi

# ---------------------------------------------------------------------------
# 4. Check frontend dependencies
# ---------------------------------------------------------------------------

if [ ! -d "frontend/node_modules" ]; then
  echo "ERROR: frontend/node_modules not found."
  echo "  Run: cd frontend && npm install"
  exit 1
fi

# ---------------------------------------------------------------------------
# 5. Check ports
# ---------------------------------------------------------------------------

check_port() {
  local port="$1"
  if command -v lsof &>/dev/null; then
    if lsof -ti:"$port" &>/dev/null; then
      echo "ERROR: Port $port is already in use."
      echo "  Inspect with: lsof -i :$port"
      return 1
    fi
  fi
  return 0
}

if ! check_port 8000; then exit 1; fi
if ! check_port 5173; then exit 1; fi

# ---------------------------------------------------------------------------
# 6. Cleanup on exit
# ---------------------------------------------------------------------------

BACKEND_PID=""

cleanup() {
  if [ -n "$BACKEND_PID" ]; then
    kill "$BACKEND_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

# ---------------------------------------------------------------------------
# 7. Start backend
# ---------------------------------------------------------------------------

echo ""
echo "Backend starting on http://localhost:8000"
uvicorn backend.main:app --reload &
BACKEND_PID=$!

# ---------------------------------------------------------------------------
# 8. Info
# ---------------------------------------------------------------------------

echo "Frontend starting on http://localhost:5173"
echo ""
echo "  Frontend: http://localhost:5173"
echo "  Backend:  http://localhost:8000"
echo "  Claude Code: run from this project root in a separate terminal if needed."
echo ""
echo "Press Ctrl+C to stop."
echo ""

# ---------------------------------------------------------------------------
# 9. Start frontend (foreground)
# ---------------------------------------------------------------------------

cd frontend
npm run dev
