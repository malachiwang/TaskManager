# TaskManager

TaskManager is a local-first spreadsheet-style task, habit, reading, pressure,
dashboard, and reports tracker.

It is built for people who want a dense working grid instead of a card board:
recurring tasks, date-cell completion tracking, urgency scoring, reading
progress, retrospective reports, and local backup/restore in one desktop/web-dev
workspace.

## What It Is For

- Tracking repeated tasks and habits in a spreadsheet-like grid
- Seeing what has gone stale without manually scanning every row
- Reviewing completion history and pressure changes over time
- Keeping reading progress and checkpoints beside task work
- Working locally without accounts, sync, or hosted storage

## Core Features

- Spreadsheet task grid with editable task, subtask, section, category, notes,
  priority, interval, urgency, and days-since fields
- Date-cell completion tracking with guarded keyboard behavior
- Pressure and urgency scoring for stale or high-priority work
- Reading sheet for books, current pages, and checkpoints
- Dashboard for present-tense action planning: what to do now
- Reports for past-tense period review
- Archive snapshots for preserved historical views
- Safe links and Insert Link support for task text fields
- Local JSON backup, export, and restore tools

## Screenshots

Screenshots and GIFs are planned. Suggested public captures:

- Task grid with urgency and days color bands
- Dashboard action cockpit
- Reading sheet
- Monthly report
- Settings Data & Backup panel

## Local-First Model

TaskManager stores app data in a local SQLite database. In development, the
default database is `taskos.db` at the repository root. Data does not leave your
machine unless you export, back up, sync the folder yourself, or package it into
another workflow.

Backups are local JSON files. Once an export leaves the app, protecting that
file is your responsibility.

## Development Setup

Requirements:

- Python 3.11+
- Node 18+
- npm

Install backend dependencies:

```bash
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

Install frontend dependencies:

```bash
cd frontend
npm install
```

Run the backend from the repository root:

```bash
python -m uvicorn backend.main:app --reload --port 8000
```

### Recommended: keep the dev database outside synced folders

By default the dev database is `taskos.db` at the repository root. If your
repository lives inside a synced folder (iCloud Drive, Dropbox, …), the sync
daemon can stall SQLite's file locking and make the backend appear to hang.
Point the backend at a plain local path instead:

```bash
mkdir -p "$HOME/.taskmanager"
TASKOS_DB_PATH="$HOME/.taskmanager/taskos.db" \
  python -m uvicorn backend.main:app --reload --port 8000
```

To migrate an existing dev database, stop the backend first, then copy
`taskos.db` to the new location. Nothing is moved or deleted automatically;
the backend prints the database path it is using at startup.

Run the frontend:

```bash
cd frontend
npm run dev
```

Build the frontend:

```bash
cd frontend
npm run build
```

The Vite dev server proxies `/api/*` to `http://localhost:8000`.

## Backup, Restore, And Moving To Another Device

Use Settings -> Data & Backup before bulk edits, imports, or risky cleanup.
Backups are snapshots of local data, not a cloud safety net. Verify important
exports before deleting or replacing your working database.

To move your workspace to another device: export a backup JSON on the old
device, then restore it in Settings -> Data & Backup on the new device. The
full walkthrough — including exactly what transfers and what stays local — is
in [docs/TRANSFER.md](docs/TRANSFER.md).

**Restore overwrites the current workspace** on the restoring device. A safety
copy of the current database is written automatically before any restore, and
UI preferences (column widths, dashboard toggles, theme, shortcuts) are
local-only and never included in backups.

## Packaged Desktop App

The app can be packaged as a native desktop app (Tauri shell + bundled Python
backend sidecar). In the packaged app the database lives in the platform
app-data directory (e.g. `~/Library/Application Support/com.taskos.desktop/`
on macOS) — outside any synced folder and separate from the dev database.

Packaging build (see `scripts/build-sidecar.sh`):

```bash
./scripts/build-sidecar.sh                # bundle the backend sidecar
npm --prefix frontend run tauri:build    # build the desktop app
```

Packaged releases still need end-to-end release validation before public
distribution.

## Current Limitations

- Local-first only: no accounts, hosted sync, or multi-user collaboration
- No cloud notifications or calendar integration
- Packaged desktop releases still need release validation
- The grid is intentionally dense and desktop-oriented
- Link editing stores plain text display-link syntax, not rich text

## Roadmap

- Public screenshots and short workflow demos
- Packaged app release validation
- More import/export guardrails
- Continued accessibility and keyboard polish
- Focused DateCell improvements in a separate persistence-safe ticket

## Policies

- [Privacy](PRIVACY.md)
- [Accessibility](ACCESSIBILITY.md)
- [Terms / Disclaimer](TERMS.md)
