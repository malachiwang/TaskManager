"""
Fake seed data for local development.

Does NOT use real personal data.
Run directly: python -m backend.seed
"""
from backend.database import get_connection, init_db

SEED_TASKS = [
    {
        "name": "Morning exercise",
        "category": "Health",
        "subtask": "",
        "priority": 7,
        "interval_days": 2,
        "status": "active",
        "notes": "30 min minimum",
        "created_at": "2026-04-01",
        "is_active": 1,
        "is_paused": 0,
        "manual_last_done_override": None,
        "display_order": 1,
    },
    {
        "name": "Review career notes",
        "category": "Career",
        "subtask": "Resume update",
        "priority": 8,
        "interval_days": 7,
        "status": "active",
        "notes": "",
        "created_at": "2026-04-01",
        "is_active": 1,
        "is_paused": 0,
        # Manual override simulates import from old spreadsheet
        "manual_last_done_override": "2026-04-20",
        "display_order": 2,
    },
    {
        "name": "Practice instrument",
        "category": "Music",
        "subtask": "",
        "priority": 6,
        "interval_days": 3,
        "status": "active",
        "notes": "TEMPORARY HIATUS",
        "created_at": "2026-03-15",
        "is_active": 1,
        "is_paused": 1,
        "manual_last_done_override": None,
        "display_order": 3,
    },
    {
        "name": "Read a book",
        "category": "Habits",
        "subtask": "",
        "priority": 4,
        "interval_days": 1,
        "status": "active",
        "notes": "",
        "created_at": "2026-05-01",
        "is_active": 1,
        "is_paused": 0,
        "manual_last_done_override": None,
        "display_order": 4,
    },
    {
        "name": "Dentist checkup",
        "category": "Health",
        "subtask": "",
        "priority": 5,
        "interval_days": 180,
        "status": "active",
        "notes": "",
        "created_at": "2025-11-01",
        "is_active": 1,
        "is_paused": 0,
        "manual_last_done_override": None,
        "display_order": 5,
    },
]

# Completion events keyed by task name for readability.
# Dates are intentionally in the past.
SEED_COMPLETIONS = [
    # Morning exercise: done twice on May 5, once on May 7
    {"task_name": "Morning exercise", "completion_date": "2026-05-05", "completion_count": 2},
    {"task_name": "Morning exercise", "completion_date": "2026-05-07", "completion_count": 1},
    # Review career notes: done Apr 28 (after manual override of Apr 20)
    {"task_name": "Review career notes", "completion_date": "2026-04-28", "completion_count": 1},
    # Read a book: done today
    {"task_name": "Read a book", "completion_date": "2026-05-08", "completion_count": 1},
    # Practice instrument: paused — no completions
    # Dentist checkup: never done — no completions
]


def seed() -> None:
    init_db()
    conn = get_connection()
    with conn:
        conn.execute("DELETE FROM completions")
        conn.execute("DELETE FROM tasks")
        # Reset autoincrement counters
        conn.execute("DELETE FROM sqlite_sequence WHERE name IN ('tasks', 'completions')")

        task_ids: dict[str, int] = {}
        for task in SEED_TASKS:
            cursor = conn.execute(
                """
                INSERT INTO tasks (
                    name, category, subtask, priority, interval_days,
                    status, notes, created_at, is_active, is_paused,
                    manual_last_done_override, display_order
                ) VALUES (
                    :name, :category, :subtask, :priority, :interval_days,
                    :status, :notes, :created_at, :is_active, :is_paused,
                    :manual_last_done_override, :display_order
                )
                """,
                task,
            )
            task_ids[task["name"]] = cursor.lastrowid

        now = "2026-05-08T00:00:00"
        for comp in SEED_COMPLETIONS:
            tid = task_ids[comp["task_name"]]
            conn.execute(
                """
                INSERT INTO completions (
                    task_id, completion_date, completion_count,
                    created_timestamp, updated_timestamp
                ) VALUES (?, ?, ?, ?, ?)
                """,
                (tid, comp["completion_date"], comp["completion_count"], now, now),
            )

    conn.close()
    print(f"Seeded {len(SEED_TASKS)} tasks and {len(SEED_COMPLETIONS)} completion events.")


if __name__ == "__main__":
    seed()
