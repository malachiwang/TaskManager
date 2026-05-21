# TaskManagementOS

A local-first, spreadsheet-like task-pressure tracking system.

## What it is

A personal operating system for task pressure and neglect prevention.
Replaces a fragile Google Sheets checkbox workflow with a persistent backend
that automatically computes last-done, days-since, urgency, and history.

## What it is not

- Not a generic todo app
- Not a SaaS product
- Not an AI agent
- Not a calendar or notification system

---

## Development quick start

Once dependencies are installed (see setup below):

```bash
./start.sh
```

- Requires `.venv` already created and Python dependencies installed
- Requires frontend npm dependencies installed (`cd frontend && npm install`)
- Starts backend on http://localhost:8000
- Starts frontend on http://localhost:5173
- Stop with Ctrl+C — backend process is cleaned up automatically

---

## Desktop app packaging (Tauri)

The app can be packaged as a native desktop app via Tauri. The FastAPI backend
is bundled as a PyInstaller sidecar that Tauri launches automatically.

### Prerequisites (one-time)

```bash
# Rust toolchain
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh

# Xcode command line tools (macOS)
xcode-select --install

# Python deps (includes pyinstaller)
pip install -r requirements.txt

# Node deps
npm --prefix frontend install
```

### Packaging build sequence

```bash
# 1. Build the Python sidecar binary
./scripts/build-sidecar.sh

# 2. Build and package the Tauri app (frontend + Rust shell)
npm --prefix frontend run tauri:build
```

The `.app` bundle is written to `src-tauri/target/release/bundle/macos/`.

### Dev workflow with Tauri window (optional)

Run the normal dev stack in one terminal, then open a Tauri window against it:

```bash
# Terminal 1
./start.sh

# Terminal 2
npm --prefix frontend run tauri:dev
```

`tauri:dev` connects to the Vite dev server on port 5173. No sidecar is used in
dev mode — the backend running via `start.sh` on port 8000 serves all requests.

### Database locations

| Mode | SQLite path |
|------|-------------|
| Dev (`./start.sh`) | `<repo-root>/taskos.db` |
| Packaged `.app` | `~/Library/Application Support/com.taskos.desktop/taskos.db` |

The packaged app never reads or writes the dev `taskos.db`. Both are gitignored.

### Notes

- `GET /health` — returns `{"status": "ok"}`, used for sidecar readiness polling
- `TASKOS_DB_PATH` env var overrides the SQLite path (set by Tauri at launch)
- `TASKOS_PORT` env var overrides the sidecar port (default: 8765)
- `VITE_API_BASE` is set to `http://127.0.0.1:8765/api` during `tauri:build`
- Sidecar binaries and Rust build outputs are gitignored — do not commit them

---

## Local Setup

### Requirements

- Python 3.11+
- pip or a virtualenv manager

### Install dependencies

```bash
python -m venv .venv
source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -r requirements.txt
```

### Run the backend

```bash
uvicorn backend.main:app --reload
```

API available at: http://localhost:8000
Interactive docs: http://localhost:8000/docs

### Seed fake data

```bash
python -m backend.seed
```

This inserts 5 fake tasks and sample completions into `taskos.db`.
The database file is excluded from git via `.gitignore`.

### Run tests

```bash
pytest tests/ -v
```

---

## Frontend Setup

### Requirements

- Node 18+

### Install frontend dependencies

```bash
cd frontend
npm install
```

### Run the frontend (dev mode)

Start the backend first, then in a separate terminal:

```bash
cd frontend
npm run dev
```

Frontend available at: http://localhost:5173

The Vite dev server proxies `/api/*` to `http://localhost:8000` automatically.
No CORS configuration needed.

### Build for production

```bash
cd frontend
npm run build
```

---

## Project Structure

```
TaskManagementOS/
├── backend/
│   ├── __init__.py
│   ├── database.py     # SQLite setup, table creation, migrations
│   ├── logic.py        # Pure urgency/date functions (no DB access)
│   ├── main.py         # FastAPI app and routes
│   ├── server.py       # Sidecar entrypoint (packaged mode, not dev)
│   └── seed.py         # Fake seed data for development
├── frontend/
│   ├── src/
│   ├── package.json
│   └── vite.config.js
├── scripts/
│   └── build-sidecar.sh  # PyInstaller sidecar build + copy to src-tauri/binaries/
├── src-tauri/            # Tauri desktop shell (Rust) — see packaging docs
├── tests/
│   ├── __init__.py
│   └── test_api.py
├── docs/
│   ├── PRD.md
│   └── MVP_SCOPE.md
├── .gitignore
├── CLAUDE.md
├── README.md
├── requirements.txt
└── start.sh
```

`taskos.db` is created automatically on first run and is gitignored.

---

## Core Concepts

**Urgency formula** — asymptotic, approaches 10, never explodes:

```
base   = f(priority)
floor  = base / 2
growth = 1 - exp(-2 * days_since / interval_days)
urgency = 10 * (floor + (1 - floor) * growth)
```

**Effective last done** — always well-defined:

```
max(manual_override, latest_completion, created_at)
```

**Paused tasks** — visible but excluded from urgency and dashboard recommendations.

**Never-done tasks** — use `created_at` as baseline; urgency still computes normally.

---

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/tasks` | List all tasks with urgency |
| GET | `/tasks/{id}` | Single task |
| POST | `/tasks` | Create task |
| PATCH | `/tasks/{id}` | Update paused state, notes, priority, etc. |
| GET | `/completions?start=&end=` | List completions in date range |
| POST | `/completions` | Increment completion count for task/date |
| DELETE | `/completions/{task_id}/{date}` | Clear a completion cell |
| GET | `/dashboard` | Top urgent tasks, category summary, dormant tasks |

---

## Never commit

- `taskos.db` or any `*.db` / `*.sqlite` file
- `.env` files or API keys
- `venv/` or `.venv/`
- `node_modules/`
- Real personal data
