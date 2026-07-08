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

## Backup And Restore Caveat

Use Settings -> Data & Backup before bulk edits, imports, or risky cleanup.
Backups are snapshots of local data, not a cloud safety net. Verify important
exports before deleting or replacing your working database.

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
