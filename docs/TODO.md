# TODO

Open issues found during verification. Nothing here has been fixed yet.

## Backend: request threads hang in SQLite connection handling (unexplained)

**Symptom.** During long headless browser runs against a disposable test
database, the FastAPI backend stops answering every synchronous endpoint
(`/tasks`, `/sections`, `/completions`, …) while the async `/health` endpoint
still returns 200. The UI shows "Tasks request timed out after 8s" or stays on
"Loading…". Restarting only the backend process clears it. First seen in
TM-SIMPLIFY-02 (cause not established there); seen again repeatedly on
2026-11-04.

**Evidence (thread dump via `faulthandler`, 2026-11-04).** All worker threads
were parked inside `backend/database.py` `get_connection()`:

- most at `sqlite3.connect(...)`,
- one at `PRAGMA journal_mode=WAL`,
- one in `list_completions` at `conn.close()`.

No file-descriptor leak (about 90 open descriptors), only one process had the
database open, and no external calendars were configured, so no network fetch
was involved. Connect, the WAL pragma, and close all block together, which is
consistent with SQLite's process-wide file lock being held by a close that
never returns. That is an inference, not a confirmed cause.

**Context.** The backend is unchanged since 37c60e5. The stall appeared with
the test database under the session scratch directory in `/private/tmp`;
it has not been checked whether it reproduces with the real database path,
outside the sandbox, or with a different Python/SQLite build (the venv uses
Python 3.13 from miniconda). A backend that received SIGTERM while stalled
also kept running and holding the database until it was force-killed.

**Next steps.** Reproduce outside the sandbox with the real database
location; log `sqlite3.sqlite_version`; try one shared connection per thread or
a `timeout=` on connect; capture native stacks (`sample <pid>`) during a stall.

## Calendar: active Week/Day segment unreadable in dark mode (pre-existing)

The active `.cal-seg-btn` uses `background: var(--ink)` with `color: #fff`.
In dark mode `--ink` is `#ededed`, so the active label is white on near-white.
This exists in b15a9f6 and was deliberately left unchanged; it needs its own
decision.
