"""
SQLite database setup.

Default (no TASKOS_DB_PATH): the database file lives at the project root as
taskos.db. taskos.db is excluded from git via .gitignore.

TASKOS_DB_PATH overrides the location with an exact file path; the parent
directory is created automatically on first connection.

  - Packaged (Tauri) mode sets it to the platform app-data directory, e.g.
      ~/Library/Application Support/com.taskos.desktop/taskos.db
  - Development: if the repository lives inside a synced folder (iCloud Drive,
    Dropbox, …), keeping the live DB there can stall SQLite WAL file locking
    while the sync daemon coordinates the file — the backend can appear to
    hang on all DB endpoints (P8.2 finding). Recommended dev usage:
      mkdir -p "$HOME/.taskmanager"
      TASKOS_DB_PATH="$HOME/.taskmanager/taskos.db" \
        python -m uvicorn backend.main:app --reload --port 8000
    To migrate an existing dev DB, stop the backend and copy taskos.db to the
    new location first. Nothing is moved or deleted automatically.
"""
import os
import sqlite3
from datetime import date as _date
from pathlib import Path

_default_db = Path(__file__).parent.parent / "taskos.db"
DB_PATH = Path(os.environ["TASKOS_DB_PATH"]) if "TASKOS_DB_PATH" in os.environ else _default_db


def get_connection() -> sqlite3.Connection:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def init_db() -> None:
    """Create tables if they do not already exist."""
    conn = get_connection()
    with conn:
        conn.executescript("""
            CREATE TABLE IF NOT EXISTS tasks (
                id                       INTEGER PRIMARY KEY AUTOINCREMENT,
                name                     TEXT    NOT NULL,
                section                  TEXT    NOT NULL DEFAULT 'General',
                category                 TEXT    NOT NULL DEFAULT '',
                subtask                  TEXT             DEFAULT '',
                priority                 INTEGER NOT NULL DEFAULT 5,
                interval_days            INTEGER NOT NULL DEFAULT 7,
                status                   TEXT    NOT NULL DEFAULT 'active',
                notes                    TEXT             DEFAULT '',
                created_at               TEXT    NOT NULL,
                paused_at                TEXT             DEFAULT NULL,
                is_active                INTEGER NOT NULL DEFAULT 1,
                is_paused                INTEGER NOT NULL DEFAULT 0,
                manual_last_done_override TEXT            DEFAULT NULL,
                display_order            INTEGER NOT NULL DEFAULT 0,
                active_from              TEXT             DEFAULT NULL,
                CHECK (priority >= 1 AND priority <= 10),
                CHECK (interval_days > 0),
                CHECK (is_active IN (0, 1)),
                CHECK (is_paused IN (0, 1))
            );

            CREATE TABLE IF NOT EXISTS completions (
                id                 INTEGER PRIMARY KEY AUTOINCREMENT,
                task_id            INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
                completion_date    TEXT    NOT NULL,
                completion_count   INTEGER NOT NULL DEFAULT 1,
                created_timestamp  TEXT    NOT NULL,
                updated_timestamp  TEXT    NOT NULL,
                CHECK (completion_count >= 0),
                UNIQUE (task_id, completion_date)
            );

            CREATE TABLE IF NOT EXISTS archive_snapshots (
                id                 INTEGER PRIMARY KEY AUTOINCREMENT,
                name               TEXT    NOT NULL,
                start_date         TEXT    NOT NULL,
                end_date           TEXT    NOT NULL,
                archived_at        TEXT    NOT NULL,
                snapshot_data_json TEXT    NOT NULL
            );

            CREATE TABLE IF NOT EXISTS cell_notes (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                task_id    INTEGER NOT NULL REFERENCES tasks(id),
                note_date  TEXT    NOT NULL,
                note       TEXT    NOT NULL DEFAULT '',
                created_at TEXT    NOT NULL,
                updated_at TEXT    NOT NULL,
                UNIQUE (task_id, note_date)
            );
        """)
    # ── Migration 1: add section column (original migration) ──────────────
    try:
        conn.execute(
            "ALTER TABLE tasks ADD COLUMN section TEXT NOT NULL DEFAULT 'General'"
        )
        conn.commit()
    except Exception:
        pass  # Column already exists.

    # ── Migration 2: add active_from column ───────────────────────────────
    try:
        conn.execute("ALTER TABLE tasks ADD COLUMN active_from TEXT DEFAULT NULL")
        conn.commit()
    except Exception:
        pass  # Column already exists.

    # ── Migration 3: normalize status to active/hiatus, sync is_paused ───
    # Idempotent: all four UPDATE statements are no-ops once data is clean.
    with conn:
        # Step A: map all hiatus-type legacy statuses → 'hiatus'
        conn.execute("""
            UPDATE tasks SET status = 'hiatus'
            WHERE LOWER(TRIM(status)) IN
                ('on-hold', 'someday', 'paused', 'pause', 'hold',
                 'idea', 'temp hiatus', 'hiatus')
        """)
        # Step B: map all other non-standard statuses → 'active'
        conn.execute("""
            UPDATE tasks SET status = 'active'
            WHERE status NOT IN ('active', 'hiatus')
        """)
        # Step C: sync is_paused=1 for hiatus tasks that still show 0 (mismatch fix)
        conn.execute("""
            UPDATE tasks
            SET is_paused = 1,
                paused_at = COALESCE(paused_at, datetime('now'))
            WHERE status = 'hiatus' AND is_paused = 0
        """)
        # Step D: sync is_paused=0 for active tasks that still show 1 (mismatch fix)
        conn.execute("""
            UPDATE tasks
            SET is_paused = 0, paused_at = NULL
            WHERE status = 'active' AND is_paused = 1
        """)

    # ── Migration 4: normalize manual_last_done_override to ISO YYYY-MM-DD ──
    # Handles values like "3/28/26" that were stored from US-format CSV imports.
    # Unrecognized values are set to NULL (safe — treated as no override).
    try:
        rows = conn.execute(
            "SELECT id, manual_last_done_override FROM tasks "
            "WHERE manual_last_done_override IS NOT NULL AND manual_last_done_override != ''"
        ).fetchall()
        for task_id, raw in rows:
            # Check if already valid ISO YYYY-MM-DD
            try:
                _date.fromisoformat(raw)
                continue  # already clean
            except ValueError:
                pass
            # Try US slash format M/D/YY or M/D/YYYY
            normalized = None
            if '/' in raw:
                parts = raw.split('/')
                if len(parts) == 3:
                    try:
                        m, d, y = int(parts[0]), int(parts[1]), int(parts[2])
                        if y < 100:
                            y += 2000
                        normalized = _date(y, m, d).isoformat()
                    except (ValueError, TypeError):
                        pass
            conn.execute(
                "UPDATE tasks SET manual_last_done_override = ? WHERE id = ?",
                (normalized, task_id),
            )
        conn.commit()
    except Exception:
        pass  # Never crash startup — _enrich_task is also safe now

    # ── Migration 5: create task_daily_snapshots table + indexes ─────────────
    # No FK on task_id — historical rows must survive hard deletes.
    # Indexes support date-range, per-task, and section×date queries.
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS task_daily_snapshots (
            id                  INTEGER PRIMARY KEY AUTOINCREMENT,
            task_id             INTEGER NOT NULL,
            snapshot_date       TEXT    NOT NULL,
            task_name           TEXT    NOT NULL,
            section             TEXT,
            category            TEXT,
            status              TEXT    NOT NULL,
            is_paused           INTEGER NOT NULL DEFAULT 0,
            is_scheduled        INTEGER NOT NULL DEFAULT 0,
            active_from         TEXT,
            priority            INTEGER NOT NULL,
            interval_days       INTEGER NOT NULL,
            days_since          INTEGER,
            urgency             REAL,
            completion_count    INTEGER NOT NULL DEFAULT 0,
            effective_last_done TEXT,
            created_at          TEXT    NOT NULL,
            updated_at          TEXT    NOT NULL,
            UNIQUE(task_id, snapshot_date)
        );

        CREATE INDEX IF NOT EXISTS idx_snap_date
            ON task_daily_snapshots(snapshot_date);

        CREATE INDEX IF NOT EXISTS idx_snap_task
            ON task_daily_snapshots(task_id);

        CREATE INDEX IF NOT EXISTS idx_snap_section_date
            ON task_daily_snapshots(section, snapshot_date);
    """)
    conn.commit()

    # ── Migration 6: add end_date column to tasks ─────────────────────────────
    try:
        conn.execute("ALTER TABLE tasks ADD COLUMN end_date TEXT DEFAULT NULL")
        conn.commit()
    except Exception:
        pass  # Column already exists.

    # ── Migration 7: add end_date and is_ended to task_daily_snapshots ────────
    try:
        conn.execute(
            "ALTER TABLE task_daily_snapshots ADD COLUMN end_date TEXT DEFAULT NULL"
        )
        conn.commit()
    except Exception:
        pass  # Column already exists.

    try:
        conn.execute(
            "ALTER TABLE task_daily_snapshots ADD COLUMN is_ended INTEGER NOT NULL DEFAULT 0"
        )
        conn.commit()
    except Exception:
        pass  # Column already exists.

    # ── Migration 8: Reading Sheet (P5.0) — books + page-checkpoint history ────
    # reading_books holds one row per book with its current page and lifecycle
    # status. reading_entries records historical page checkpoints (one per day
    # per book via the UNIQUE constraint); archiving/finishing a book never
    # deletes its entries. total_pages may be NULL (unknown length).
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS reading_books (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            title         TEXT    NOT NULL,
            author        TEXT             DEFAULT '',
            total_pages   INTEGER          DEFAULT NULL,
            current_page  INTEGER NOT NULL DEFAULT 0,
            status        TEXT    NOT NULL DEFAULT 'active',
            started_at    TEXT             DEFAULT NULL,
            finished_at   TEXT             DEFAULT NULL,
            notes         TEXT             DEFAULT '',
            display_order INTEGER NOT NULL DEFAULT 0,
            created_at    TEXT    NOT NULL,
            updated_at    TEXT    NOT NULL,
            CHECK (current_page >= 0),
            CHECK (total_pages IS NULL OR total_pages >= 0),
            CHECK (status IN ('active', 'finished', 'archived'))
        );

        CREATE TABLE IF NOT EXISTS reading_entries (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            book_id    INTEGER NOT NULL REFERENCES reading_books(id) ON DELETE CASCADE,
            entry_date TEXT    NOT NULL,
            page       INTEGER NOT NULL,
            note       TEXT             DEFAULT '',
            created_at TEXT    NOT NULL,
            updated_at TEXT    NOT NULL,
            CHECK (page >= 0),
            UNIQUE (book_id, entry_date)
        );

        CREATE INDEX IF NOT EXISTS idx_reading_entries_book
            ON reading_entries(book_id);
    """)
    conn.commit()

    # ── Migration 9: date_cell_overrides (P9.1) — per task/date text cells ────
    # A row here converts that exact task/date grid cell from a completion
    # checkbox into a plain-text cell. Any existing completion row for the same
    # task/date is preserved (hidden) while the override exists and becomes
    # visible again if the override is removed. mode is 'text' for all rows
    # today; the column exists so future cell modes never need a table change.
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS date_cell_overrides (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            task_id    INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
            date       TEXT    NOT NULL,
            mode       TEXT    NOT NULL DEFAULT 'text',
            text       TEXT    NOT NULL DEFAULT '',
            created_at TEXT    NOT NULL,
            updated_at TEXT    NOT NULL,
            UNIQUE (task_id, date)
        );

        CREATE INDEX IF NOT EXISTS idx_dco_date
            ON date_cell_overrides(date);
    """)
    conn.commit()

    # ── Migration 10: task_hiatus_periods (P11.0) — persisted hiatus history ──
    # One row per hiatus interval. start_date inclusive; end_date inclusive when
    # closed; end_date NULL = the task is currently on hiatus (open interval).
    # DateCells inside any interval render as hiatus blanks forever, even after
    # the task resumes. Underlying completions/overrides are never touched.
    # ON DELETE CASCADE keeps intervals from orphaning on hard task deletes.
    thp_existed = conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='task_hiatus_periods'"
    ).fetchone() is not None

    conn.executescript("""
        CREATE TABLE IF NOT EXISTS task_hiatus_periods (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            task_id    INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
            start_date TEXT    NOT NULL,
            end_date   TEXT             DEFAULT NULL,
            created_at TEXT    NOT NULL,
            updated_at TEXT    NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_thp_task
            ON task_hiatus_periods(task_id);

        CREATE INDEX IF NOT EXISTS idx_thp_start
            ON task_hiatus_periods(start_date);
    """)
    conn.commit()

    # One-time seed (only when the table was just created): tasks already on
    # hiatus get an open interval starting on their paused_at date, so existing
    # hiatus tasks render blanks immediately after upgrading. Runs once — a
    # deliberately deleted interval is never resurrected on later startups.
    if not thp_existed:
        from datetime import datetime as _dt
        now_iso = _dt.now().isoformat()
        rows = conn.execute(
            "SELECT id, paused_at FROM tasks WHERE status = 'hiatus' AND is_active = 1"
        ).fetchall()
        for r in rows:
            start = (r["paused_at"] or now_iso)[:10]
            try:
                _date.fromisoformat(start)
            except ValueError:
                start = now_iso[:10]
            conn.execute(
                "INSERT INTO task_hiatus_periods (task_id, start_date, end_date, created_at, updated_at) "
                "VALUES (?, ?, NULL, ?, ?)",
                (r["id"], start, now_iso, now_iso),
            )
        conn.commit()

    # ── Migration 11: reading_books priority + Books-to-Buy fields (P11.0) ───
    # priority: 1–5 book scale (1 low/background, 3 normal, 5 highest).
    # to_buy: 1 = wishlist entry (not yet owned); shown in the Reading
    # "To Buy" view instead of the library. purchased_at stamps when a
    # to-buy book is marked bought.
    for ddl in (
        "ALTER TABLE reading_books ADD COLUMN priority INTEGER NOT NULL DEFAULT 3",
        "ALTER TABLE reading_books ADD COLUMN to_buy INTEGER NOT NULL DEFAULT 0",
        "ALTER TABLE reading_books ADD COLUMN purchase_url TEXT NOT NULL DEFAULT ''",
        "ALTER TABLE reading_books ADD COLUMN purchase_notes TEXT NOT NULL DEFAULT ''",
        "ALTER TABLE reading_books ADD COLUMN purchased_at TEXT DEFAULT NULL",
    ):
        try:
            conn.execute(ddl)
            conn.commit()
        except Exception:
            pass  # Column already exists.

    # ── Migration 12: Calendar (P12.0) — depth, estimates, sessions, windows ──
    # Additive only. Tasks gain optional cognitive-depth (1 deep / 2 focused /
    # 3 shallow) and an estimated total effort in minutes; both NULL for every
    # existing task, which must keep behaving exactly as before.
    #
    # task_sessions: one row per scheduled work session. A task may have many
    # sessions (multi-session model) — sessions are attempts/allocations of
    # time, distinct from task completion. planned_* is the schedule the user
    # set; actual_* is reserved for execution tracking and never overwrites
    # planned history. Times are local-naive "YYYY-MM-DDTHH:MM" strings so
    # range queries are plain string comparisons.
    #
    # depth_windows: user-declared cognitive-capacity regions, not tasks.
    # Exactly one of date (one-off) or weekday (recurring, 0=Mon…6=Sun) is
    # set. Times are minutes-from-midnight so windows are date-independent.
    for ddl in (
        "ALTER TABLE tasks ADD COLUMN depth INTEGER DEFAULT NULL",
        "ALTER TABLE tasks ADD COLUMN estimated_minutes INTEGER DEFAULT NULL",
    ):
        try:
            conn.execute(ddl)
            conn.commit()
        except Exception:
            pass  # Column already exists.

    conn.executescript("""
        CREATE TABLE IF NOT EXISTS task_sessions (
            id             INTEGER PRIMARY KEY AUTOINCREMENT,
            task_id        INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
            planned_start  TEXT    NOT NULL,
            planned_end    TEXT    NOT NULL,
            actual_start   TEXT             DEFAULT NULL,
            actual_end     TEXT             DEFAULT NULL,
            actual_minutes INTEGER          DEFAULT NULL,
            status         TEXT    NOT NULL DEFAULT 'scheduled',
            is_fixed       INTEGER NOT NULL DEFAULT 0,
            created_at     TEXT    NOT NULL,
            updated_at     TEXT    NOT NULL,
            CHECK (status IN ('scheduled', 'completed', 'partial', 'skipped')),
            CHECK (is_fixed IN (0, 1)),
            CHECK (planned_end > planned_start)
        );

        CREATE INDEX IF NOT EXISTS idx_sessions_task
            ON task_sessions(task_id);

        CREATE INDEX IF NOT EXISTS idx_sessions_start
            ON task_sessions(planned_start);

        CREATE TABLE IF NOT EXISTS depth_windows (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            depth         INTEGER NOT NULL,
            date          TEXT             DEFAULT NULL,
            weekday       INTEGER          DEFAULT NULL,
            start_minutes INTEGER NOT NULL,
            end_minutes   INTEGER NOT NULL,
            protected     INTEGER NOT NULL DEFAULT 0,
            created_at    TEXT    NOT NULL,
            updated_at    TEXT    NOT NULL,
            CHECK (depth IN (1, 2, 3)),
            CHECK (protected IN (0, 1)),
            CHECK (end_minutes > start_minutes),
            CHECK (start_minutes >= 0 AND end_minutes <= 1440),
            CHECK ((date IS NULL) != (weekday IS NULL)),
            CHECK (weekday IS NULL OR (weekday >= 0 AND weekday <= 6))
        );
    """)
    conn.commit()

    # ── Migration 13: section_order (P12.1) — persisted manual section order ──
    # Sections were previously implicit (derived from task encounter order in
    # the display_order sort), which made them appear to move when tasks were
    # created or reordered. This table makes the user's arrangement explicit:
    # one row per section name, ordered by position. name '' represents the
    # blank/"(no section)" group. Rows may exist with zero tasks (empty
    # sections stay listed and remain drop targets).
    so_existed = conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='section_order'"
    ).fetchone() is not None

    conn.executescript("""
        CREATE TABLE IF NOT EXISTS section_order (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            name       TEXT    NOT NULL UNIQUE,
            position   INTEGER NOT NULL DEFAULT 0,
            created_at TEXT    NOT NULL,
            updated_at TEXT    NOT NULL
        );
    """)
    conn.commit()

    # One-time seed (only when the table was just created): capture the order
    # the user currently sees (encounter order over display_order, id) so the
    # upgrade preserves the existing visible arrangement exactly.
    if not so_existed:
        from datetime import datetime as _dt
        now_iso = _dt.now().isoformat()
        rows = conn.execute(
            "SELECT section FROM tasks WHERE is_active = 1 ORDER BY display_order, id"
        ).fetchall()
        seen: set = set()
        position = 0
        for r in rows:
            name = (r["section"] or "").strip()
            if name in seen:
                continue
            seen.add(name)
            conn.execute(
                "INSERT INTO section_order (name, position, created_at, updated_at) "
                "VALUES (?, ?, ?, ?)",
                (name, position, now_iso, now_iso),
            )
            position += 1
        conn.commit()

    # ── Migration 14: depth_window_skips (P13.0) — recurrence exceptions ─────
    # One row = "this recurring depth window does not apply on this date".
    # Deleting a weekly window on a single day inserts a skip instead of
    # destroying the series. ON DELETE CASCADE cleans up with the window.
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS depth_window_skips (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            window_id  INTEGER NOT NULL REFERENCES depth_windows(id) ON DELETE CASCADE,
            date       TEXT    NOT NULL,
            created_at TEXT    NOT NULL,
            UNIQUE (window_id, date)
        );
    """)
    conn.commit()

    conn.close()
