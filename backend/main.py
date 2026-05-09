"""
TaskManagementOS — FastAPI backend.

Run locally:
    uvicorn backend.main:app --reload

API docs:
    http://localhost:8000/docs
"""
from collections import defaultdict
from contextlib import asynccontextmanager
from datetime import date, datetime
from typing import Optional

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware

from backend.database import get_connection, init_db
from backend.logic import (
    calculate_days_since,
    calculate_effective_last_done,
    calculate_urgency,
)


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    yield


app = FastAPI(title="TaskManagementOS API", version="0.1.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://localhost:3000"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _enrich_task(row: dict, today: date) -> dict:
    """Add computed fields (effective_last_done, days_since, urgency) to a task row."""
    t = dict(row)
    created = date.fromisoformat(t["created_at"])
    manual = (
        date.fromisoformat(t["manual_last_done_override"])
        if t.get("manual_last_done_override")
        else None
    )
    latest = (
        date.fromisoformat(t["latest_completion"])
        if t.get("latest_completion")
        else None
    )

    effective = calculate_effective_last_done(created, latest, manual)
    days = calculate_days_since(effective, today)
    urgency = calculate_urgency(
        priority=t["priority"],
        days_since=days,
        interval_days=t["interval_days"],
        is_paused=bool(t["is_paused"]),
    )

    t["effective_last_done"] = effective.isoformat()
    t["days_since"] = days
    t["urgency"] = urgency
    return t


# ---------------------------------------------------------------------------
# Tasks
# ---------------------------------------------------------------------------

@app.get("/tasks")
def list_tasks(include_paused: bool = True):
    """Return all active tasks with computed urgency and days_since."""
    conn = get_connection()
    query = """
        SELECT t.*,
               (SELECT MAX(completion_date)
                FROM completions c
                WHERE c.task_id = t.id) AS latest_completion
        FROM tasks t
        WHERE t.is_active = 1
    """
    if not include_paused:
        query += " AND t.is_paused = 0"
    query += " ORDER BY t.display_order, t.id"

    rows = conn.execute(query).fetchall()
    conn.close()
    today = date.today()
    return [_enrich_task(dict(r), today) for r in rows]


@app.get("/tasks/{task_id}")
def get_task(task_id: int):
    conn = get_connection()
    row = conn.execute(
        """
        SELECT t.*,
               (SELECT MAX(completion_date)
                FROM completions c
                WHERE c.task_id = t.id) AS latest_completion
        FROM tasks t
        WHERE t.id = ?
        """,
        (task_id,),
    ).fetchone()
    conn.close()
    if not row:
        raise HTTPException(status_code=404, detail="Task not found")
    return _enrich_task(dict(row), date.today())


@app.post("/tasks", status_code=201)
def create_task(
    name: str,
    category: str = "",
    subtask: str = "",
    priority: int = 5,
    interval_days: int = 7,
    status: str = "active",
    notes: str = "",
    manual_last_done_override: Optional[str] = None,
    display_order: int = 0,
):
    if not 1 <= priority <= 10:
        raise HTTPException(status_code=422, detail="Priority must be between 1 and 10")
    if interval_days < 1:
        raise HTTPException(status_code=422, detail="interval_days must be >= 1")

    conn = get_connection()
    today_str = date.today().isoformat()
    with conn:
        cursor = conn.execute(
            """
            INSERT INTO tasks (
                name, category, subtask, priority, interval_days,
                status, notes, created_at, is_active, is_paused,
                manual_last_done_override, display_order
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 0, ?, ?)
            """,
            (
                name, category, subtask, priority, interval_days,
                status, notes, today_str, manual_last_done_override, display_order,
            ),
        )
        task_id = cursor.lastrowid

    row = conn.execute(
        "SELECT t.*, NULL AS latest_completion FROM tasks t WHERE t.id = ?",
        (task_id,),
    ).fetchone()
    conn.close()
    return _enrich_task(dict(row), date.today())


@app.patch("/tasks/{task_id}")
def update_task(
    task_id: int,
    is_paused: Optional[bool] = None,
    notes: Optional[str] = None,
    manual_last_done_override: Optional[str] = None,
    priority: Optional[int] = None,
    interval_days: Optional[int] = None,
):
    """Update mutable task fields. Only provided fields are changed."""
    conn = get_connection()
    existing = conn.execute("SELECT * FROM tasks WHERE id = ?", (task_id,)).fetchone()
    if not existing:
        conn.close()
        raise HTTPException(status_code=404, detail="Task not found")

    if priority is not None and not 1 <= priority <= 10:
        conn.close()
        raise HTTPException(status_code=422, detail="Priority must be between 1 and 10")
    if interval_days is not None and interval_days < 1:
        conn.close()
        raise HTTPException(status_code=422, detail="interval_days must be >= 1")

    # Build update map with only the fields that were provided
    updates: dict = {}
    if is_paused is not None:
        updates["is_paused"] = int(is_paused)
        updates["paused_at"] = datetime.now().isoformat() if is_paused else None
    if notes is not None:
        updates["notes"] = notes
    if manual_last_done_override is not None:
        updates["manual_last_done_override"] = manual_last_done_override
    if priority is not None:
        updates["priority"] = priority
    if interval_days is not None:
        updates["interval_days"] = interval_days

    if updates:
        # Column names are hardcoded above — not from user input — so this is safe
        set_clause = ", ".join(f"{col} = ?" for col in updates)
        values = list(updates.values()) + [task_id]
        with conn:
            conn.execute(f"UPDATE tasks SET {set_clause} WHERE id = ?", values)

    row = conn.execute(
        """
        SELECT t.*,
               (SELECT MAX(completion_date)
                FROM completions c
                WHERE c.task_id = t.id) AS latest_completion
        FROM tasks t
        WHERE t.id = ?
        """,
        (task_id,),
    ).fetchone()
    conn.close()
    return _enrich_task(dict(row), date.today())


# ---------------------------------------------------------------------------
# Completions
# ---------------------------------------------------------------------------

@app.get("/completions")
def list_completions(
    start: str = Query(..., description="Start date YYYY-MM-DD"),
    end: str = Query(..., description="End date YYYY-MM-DD"),
    task_id: Optional[int] = None,
):
    conn = get_connection()
    query = "SELECT * FROM completions WHERE completion_date BETWEEN ? AND ?"
    params: list = [start, end]
    if task_id is not None:
        query += " AND task_id = ?"
        params.append(task_id)
    rows = conn.execute(query, params).fetchall()
    conn.close()
    return [dict(r) for r in rows]


@app.post("/completions", status_code=201)
def upsert_completion(task_id: int, completion_date: str):
    """
    Increment the completion count for a task/date cell.
    First call creates count=1; subsequent calls increment by 1.
    Future dates are rejected.
    """
    if completion_date > date.today().isoformat():
        raise HTTPException(status_code=422, detail="Cannot record completions for future dates")

    conn = get_connection()
    if not conn.execute("SELECT id FROM tasks WHERE id = ?", (task_id,)).fetchone():
        conn.close()
        raise HTTPException(status_code=404, detail="Task not found")

    now = datetime.now().isoformat()
    existing = conn.execute(
        "SELECT * FROM completions WHERE task_id = ? AND completion_date = ?",
        (task_id, completion_date),
    ).fetchone()

    with conn:
        if existing:
            conn.execute(
                """
                UPDATE completions
                SET completion_count = completion_count + 1, updated_timestamp = ?
                WHERE task_id = ? AND completion_date = ?
                """,
                (now, task_id, completion_date),
            )
        else:
            conn.execute(
                """
                INSERT INTO completions (task_id, completion_date, completion_count,
                    created_timestamp, updated_timestamp)
                VALUES (?, ?, 1, ?, ?)
                """,
                (task_id, completion_date, now, now),
            )

    result = conn.execute(
        "SELECT * FROM completions WHERE task_id = ? AND completion_date = ?",
        (task_id, completion_date),
    ).fetchone()
    conn.close()
    return dict(result)


@app.delete("/completions/{task_id}/{completion_date}")
def delete_completion(task_id: int, completion_date: str):
    """Clear a completion cell (shift-click behavior)."""
    conn = get_connection()
    existing = conn.execute(
        "SELECT * FROM completions WHERE task_id = ? AND completion_date = ?",
        (task_id, completion_date),
    ).fetchone()
    if not existing:
        conn.close()
        raise HTTPException(status_code=404, detail="Completion not found")

    with conn:
        conn.execute(
            "DELETE FROM completions WHERE task_id = ? AND completion_date = ?",
            (task_id, completion_date),
        )
    conn.close()
    return {"deleted": True, "task_id": task_id, "completion_date": completion_date}


# ---------------------------------------------------------------------------
# Dashboard
# ---------------------------------------------------------------------------

@app.get("/dashboard")
def dashboard():
    """
    Passive summary: top urgent tasks, category neglect, dormant tasks.
    Only active, non-paused tasks appear in recommendations.
    """
    today = date.today()
    conn = get_connection()

    rows = conn.execute(
        """
        SELECT t.*,
               (SELECT MAX(completion_date)
                FROM completions c
                WHERE c.task_id = t.id) AS latest_completion
        FROM tasks t
        WHERE t.is_active = 1 AND t.is_paused = 0
        ORDER BY t.display_order, t.id
        """
    ).fetchall()

    active_tasks = [_enrich_task(dict(r), today) for r in rows]

    top_5 = sorted(active_tasks, key=lambda t: t["urgency"], reverse=True)[:5]

    # Category averages (active, non-paused only)
    cat_urgencies: dict[str, list] = defaultdict(list)
    for t in active_tasks:
        cat_urgencies[t["category"]].append(t["urgency"])
    category_summary = {
        cat: {
            "avg_urgency": round(sum(vals) / len(vals), 1),
            "max_urgency": max(vals),
            "count": len(vals),
        }
        for cat, vals in cat_urgencies.items()
    }

    # Dormant: 30+ days since any completion (active, non-paused)
    dormant = [t for t in active_tasks if t["days_since"] >= 30]

    paused_count = conn.execute(
        "SELECT COUNT(*) FROM tasks WHERE is_active = 1 AND is_paused = 1"
    ).fetchone()[0]

    never_done_count = conn.execute(
        """
        SELECT COUNT(*) FROM tasks t
        WHERE t.is_active = 1 AND t.is_paused = 0
          AND NOT EXISTS (SELECT 1 FROM completions c WHERE c.task_id = t.id)
          AND t.manual_last_done_override IS NULL
        """
    ).fetchone()[0]

    conn.close()
    return {
        "top_5_urgent": top_5,
        "category_summary": category_summary,
        "dormant_tasks": dormant,
        "paused_count": paused_count,
        "never_done_count": never_done_count,
    }
