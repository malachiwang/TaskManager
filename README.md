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
│   ├── database.py     # SQLite setup, table creation
│   ├── logic.py        # Pure urgency/date functions (no DB access)
│   ├── main.py         # FastAPI app and routes
│   └── seed.py         # Fake seed data for development
├── tests/
│   ├── __init__.py
│   └── test_logic.py   # Unit tests for urgency, days_since, effective_last_done
├── docs/
│   ├── PRD.md          # Full product vision
│   └── MVP_SCOPE.md    # Hard implementation boundary
├── .gitignore
├── CLAUDE.md
├── README.md
└── requirements.txt
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
