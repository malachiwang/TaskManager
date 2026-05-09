"""
SQLite database setup.

The database file lives at the project root as taskos.db.
taskos.db is excluded from git via .gitignore.
"""
import sqlite3
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
        """)
    # Migrate existing databases: add section column if not present.
    # ALTER TABLE ADD COLUMN is safe with NOT NULL DEFAULT on SQLite.
    try:
        conn.execute(
            "ALTER TABLE tasks ADD COLUMN section TEXT NOT NULL DEFAULT 'General'"
        )
        conn.commit()
    except Exception:
        pass  # Column already exists — no action needed.
    conn.close()
