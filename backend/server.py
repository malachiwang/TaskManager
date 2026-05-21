"""
Packaged sidecar entrypoint for TaskManagementOS.

Used by PyInstaller to build a standalone binary that Tauri launches as a
sidecar. Not used during normal development — use start.sh instead.

Environment variables:
  TASKOS_PORT     Port to bind (default: 8765)
  TASKOS_DB_PATH  Override SQLite path (set by Tauri to app-data dir)

Run directly for local testing (from project root):
  python backend/server.py
  python -m backend.server
"""
import os
import sys
from pathlib import Path

# When run as a script (python backend/server.py), Python puts backend/ on
# sys.path rather than the project root, so 'backend.main' would not resolve.
# This ensures the project root is always on sys.path.
# In a PyInstaller bundle sys.frozen is set and PyInstaller manages sys.path.
if not getattr(sys, "frozen", False):
    _ROOT = Path(__file__).resolve().parent.parent
    if str(_ROOT) not in sys.path:
        sys.path.insert(0, str(_ROOT))

import uvicorn  # noqa: E402
from backend.main import app  # noqa: E402 — direct import so PyInstaller collects backend/


def main() -> None:
    port = int(os.environ.get("TASKOS_PORT", "8765"))
    # Pass the app object, not a string import — required for PyInstaller bundles
    # because string imports ("backend.main:app") are not detected by static analysis.
    uvicorn.run(app, host="127.0.0.1", port=port)


if __name__ == "__main__":
    main()
