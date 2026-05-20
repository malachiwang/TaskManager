"""
SQLite database setup.

The database file lives at the project root as taskos.db.
taskos.db is excluded from git via .gitignore.
"""
import sqlite3
from datetime import date as _date
from pathlib import Path

DB_PATH = Path(__file__).parent.parent / "taskos.db"


def get_connection() -> sqlite3.Connection:
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

    conn.close()
