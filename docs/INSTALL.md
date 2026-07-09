# Installing TaskManager

TaskManager is a local-first desktop app. There are two ways to get it
running: download a packaged macOS app (easiest), or run it from source
(developer setup).

All data stays on your machine either way — there is no account, no cloud
sync, and no telemetry.

---

## Option 1 — Packaged macOS app (easiest)

1. Go to the repository's **GitHub Releases** page and download the newest
   `TaskManager_<version>_<arch>.dmg` (or zipped `TaskManager.app`), if one is
   published. If no release artifact exists yet, use Option 2 or ask whoever
   shared the repo with you to run `./scripts/package-macos.sh` and send you
   the `.dmg`.
2. Open the `.dmg` and drag **TaskManager.app** into `/Applications`.
3. First launch on macOS: the app is **not code-signed or notarized** (that
   requires a paid Apple Developer account, which this project does not use),
   so Gatekeeper will block a plain double-click with a message like
   *"TaskManager can't be opened because it is from an unidentified
   developer."*

   The honest workaround:
   - **Right-click (or Ctrl-click) TaskManager.app → Open → Open.** You only
     need to do this once; afterwards it opens normally.
   - Or, if that option doesn't appear: System Settings → Privacy & Security →
     scroll to the blocked-app notice → **Open Anyway**.

   This warning appears because the app isn't signed with an Apple-issued
   certificate — not because anything phones home. You can verify: the app's
   only network traffic is to its own local backend on `127.0.0.1:8765`.
4. That's it. The app starts its own embedded backend automatically. Your
   data lives in `~/Library/Application Support/com.taskos.desktop/taskos.db`.

### Good habits

- **Back up before big changes:** Settings → Data & Backup → *Download JSON*.
  The backup file is yours to keep safe.
- **Moving to another machine:** export a backup JSON on the old machine,
  restore it in Settings → Data & Backup on the new one
  (see [TRANSFER.md](TRANSFER.md) for the full walkthrough).
- UI preferences (theme, column widths, keyboard shortcuts) are stored per
  device and are **not** part of backups — set them up again after a move.

### What the packaged app does NOT do

- No auto-updates — install a newer `.dmg` over the old app to upgrade
  (your data is stored outside the app bundle and is not affected).
- No signing/notarization — hence the one-time right-click → Open.
- No Windows/Linux packages are published at this time.

---

## Option 2 — Run from source (developer setup)

Requirements: Python 3.11+, Node 18+, npm. Rust is only needed if you want to
build the packaged desktop app.

```bash
# 1. Clone
git clone https://github.com/malachiwang/TaskManagementOS.git
cd TaskManagementOS

# 2. Backend dependencies
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt

# 3. Frontend dependencies
npm --prefix frontend install

# 4. Run the backend
#    Keep the dev database OUTSIDE synced folders (iCloud/Dropbox stall
#    SQLite locking):
mkdir -p "$HOME/.taskmanager"
TASKOS_DB_PATH="$HOME/.taskmanager/taskos.db" \
  python -m uvicorn backend.main:app --reload --port 8000

# 5. In a second terminal, run the frontend dev server
npm --prefix frontend run dev
```

Open the URL Vite prints (usually `http://localhost:5173`). The dev server
proxies `/api/*` to the backend on port 8000.

### Optional: build the desktop app yourself

With the Rust toolchain installed:

```bash
./scripts/package-macos.sh
```

This produces `TaskManager.app` and a `.dmg` under
`src-tauri/target/release/bundle/` — see [RELEASE.md](RELEASE.md) for details.
Never commit these build artifacts.
