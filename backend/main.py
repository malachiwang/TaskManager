"""
TaskManagementOS — FastAPI backend.

Run locally:
    uvicorn backend.main:app --reload

API docs:
    http://localhost:8000/docs
"""
import csv
import io
import json
import re
import sqlite3
from pathlib import Path
from collections import defaultdict
from contextlib import asynccontextmanager
from datetime import date, datetime, timedelta
from typing import Optional

from fastapi import Body, FastAPI, File, HTTPException, Query, UploadFile
from pydantic import BaseModel
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response

from backend.database import DB_PATH, get_connection, init_db
from backend.logic import (
    calculate_days_since,
    calculate_effective_last_done,
    calculate_urgency,
)

# ---------------------------------------------------------------------------
# Status normalization
# ---------------------------------------------------------------------------

_HIATUS_STATUSES: frozenset[str] = frozenset({
    'hiatus', 'on-hold', 'someday', 'paused', 'pause',
    'hold', 'idea', 'temp hiatus',
})


def _normalize_status(raw: str) -> str:
    """Map any status string to canonical 'active' or 'hiatus'."""
    return 'hiatus' if raw.strip().lower() in _HIATUS_STATUSES else 'active'


def _normalize_date_override(value: Optional[str]) -> Optional[str]:
    """
    Normalize manual_last_done_override to ISO YYYY-MM-DD, or return None.

    Accepted formats:
      - None / "" / whitespace-only  → None
      - "YYYY-MM-DD"                 → same (validated)
      - "M/D/YY", "MM/DD/YY",
        "M/D/YYYY", "MM/DD/YYYY"    → converted to "YYYY-MM-DD"
        2-digit year: interpreted as 2000+YY (26 → 2026).

    Unrecognized format → None (never raises).
    """
    if not value:
        return None
    value = value.strip()
    if not value:
        return None
    # Already ISO YYYY-MM-DD
    if len(value) == 10 and value[4] == '-' and value[7] == '-':
        try:
            date.fromisoformat(value)
            return value
        except ValueError:
            return None
    # US slash format: M/D/YY, M/D/YYYY, MM/DD/YY, MM/DD/YYYY
    if '/' in value:
        parts = value.split('/')
        if len(parts) == 3:
            try:
                m, d, y = int(parts[0]), int(parts[1]), int(parts[2])
                if y < 100:
                    y += 2000
                return date(y, m, d).isoformat()
            except (ValueError, TypeError):
                return None
    return None


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    yield


app = FastAPI(title="TaskManagementOS API", version="0.1.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "http://localhost:3000",
        "tauri://localhost",
        "http://tauri.localhost",
        "https://tauri.localhost",
    ],
    allow_methods=["*"],
    allow_headers=["*"],
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _enrich_task(row: dict, today: date) -> dict:
    """Add computed fields (effective_last_done, days_since, urgency, is_scheduled, is_ended) to a task row."""
    t = dict(row)
    created = date.fromisoformat(t["created_at"])
    manual_iso = _normalize_date_override(t.get("manual_last_done_override"))
    manual = date.fromisoformat(manual_iso) if manual_iso else None
    latest = (
        date.fromisoformat(t["latest_completion"])
        if t.get("latest_completion")
        else None
    )

    # is_scheduled: active_from exists and is in the future.
    active_from_iso = _normalize_date_override(t.get("active_from"))
    is_scheduled = bool(active_from_iso and active_from_iso > today.isoformat())

    # is_ended: end_date exists and is on or before today.
    end_date_iso = _normalize_date_override(t.get("end_date"))
    is_ended = bool(end_date_iso and end_date_iso <= today.isoformat())

    effective = calculate_effective_last_done(created, latest, manual)
    days = calculate_days_since(effective, today)

    # Ended, scheduled, or paused tasks generate no pressure.
    if is_ended or is_scheduled or bool(t["is_paused"]):
        urgency = 0.0
    else:
        urgency = calculate_urgency(
            priority=t["priority"],
            days_since=days,
            interval_days=t["interval_days"],
            is_paused=False,
        )

    t["effective_last_done"] = effective.isoformat()
    t["days_since"] = days
    t["urgency"] = urgency
    t["is_scheduled"] = is_scheduled
    t["end_date"] = end_date_iso  # normalized, or None
    t["is_ended"] = is_ended
    return t


def _capture_daily_snapshots(conn, snapshot_date: date) -> None:
    """
    Upsert one snapshot row per active task for snapshot_date.

    Captures all is_active=1 tasks (including paused and scheduled).
    Uses INSERT … ON CONFLICT DO UPDATE so same-day calls update the row
    without overwriting created_at, making the operation fully idempotent.
    """
    today_iso = snapshot_date.isoformat()

    rows = conn.execute(
        """
        SELECT t.*,
               (SELECT MAX(completion_date)
                FROM completions c
                WHERE c.task_id = t.id) AS latest_completion
        FROM tasks t
        WHERE t.is_active = 1
        ORDER BY t.id
        """
    ).fetchall()

    if not rows:
        return

    tasks = [_enrich_task(dict(r), snapshot_date) for r in rows]
    task_ids = [t["id"] for t in tasks]

    # Batch-fetch today's completion counts — one query, not N.
    placeholders = ",".join("?" * len(task_ids))
    comp_rows = conn.execute(
        f"SELECT task_id, completion_count FROM completions "
        f"WHERE completion_date = ? AND task_id IN ({placeholders})",
        (today_iso, *task_ids),
    ).fetchall()
    comp_map = {r["task_id"]: r["completion_count"] for r in comp_rows}

    now = datetime.now().isoformat()

    with conn:
        for t in tasks:
            conn.execute(
                """
                INSERT INTO task_daily_snapshots (
                    task_id, snapshot_date, task_name, section, category,
                    status, is_paused, is_scheduled, active_from,
                    priority, interval_days, days_since, urgency,
                    completion_count, effective_last_done, end_date, is_ended,
                    created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(task_id, snapshot_date) DO UPDATE SET
                    task_name        = excluded.task_name,
                    section          = excluded.section,
                    category         = excluded.category,
                    status           = excluded.status,
                    is_paused        = excluded.is_paused,
                    is_scheduled     = excluded.is_scheduled,
                    active_from      = excluded.active_from,
                    priority         = excluded.priority,
                    interval_days    = excluded.interval_days,
                    days_since       = excluded.days_since,
                    urgency          = excluded.urgency,
                    completion_count = excluded.completion_count,
                    effective_last_done = excluded.effective_last_done,
                    end_date         = excluded.end_date,
                    is_ended         = excluded.is_ended,
                    updated_at       = excluded.updated_at
                """,
                (
                    t["id"], today_iso, t["name"],
                    t.get("section"), t.get("category"),
                    t["status"], int(t["is_paused"]), int(t["is_scheduled"]),
                    t.get("active_from"),
                    t["priority"], t["interval_days"],
                    t["days_since"], t["urgency"],
                    comp_map.get(t["id"], 0),
                    t["effective_last_done"],
                    t.get("end_date"), int(t["is_ended"]),
                    now, now,
                ),
            )


# ---------------------------------------------------------------------------
# Health
# ---------------------------------------------------------------------------

@app.get("/health")
def health():
    return {"status": "ok"}


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
    section: str = "General",
    category: str = "",
    subtask: str = "",
    priority: int = 5,
    interval_days: int = 7,
    status: str = "active",
    notes: str = "",
    manual_last_done_override: Optional[str] = None,
    display_order: int = 0,
    active_from: Optional[str] = None,
    end_date: Optional[str] = None,
):
    if not 1 <= priority <= 10:
        raise HTTPException(status_code=422, detail="Priority must be between 1 and 10")
    if interval_days < 1:
        raise HTTPException(status_code=422, detail="interval_days must be >= 1")

    norm_status = _normalize_status(status)
    is_paused_val = 1 if norm_status == 'hiatus' else 0
    paused_at_val = datetime.now().isoformat() if is_paused_val else None
    conn = get_connection()
    today_str = date.today().isoformat()
    active_from_val = _normalize_date_override(active_from) or today_str
    manual_override_val = _normalize_date_override(manual_last_done_override)
    end_date_val = _normalize_date_override(end_date)
    with conn:
        cursor = conn.execute(
            """
            INSERT INTO tasks (
                name, section, category, subtask, priority, interval_days,
                status, notes, created_at, is_active, is_paused, paused_at,
                manual_last_done_override, display_order, active_from, end_date
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)
            """,
            (
                name, section, category, subtask, priority, interval_days,
                norm_status, notes, today_str, is_paused_val, paused_at_val,
                manual_override_val, display_order, active_from_val, end_date_val,
            ),
        )
        task_id = cursor.lastrowid

    row = conn.execute(
        "SELECT t.*, NULL AS latest_completion FROM tasks t WHERE t.id = ?",
        (task_id,),
    ).fetchone()
    conn.close()
    return _enrich_task(dict(row), date.today())


class TaskPatch(BaseModel):
    """Optional JSON body for PATCH /tasks/{id}.

    Callers may send fields as query parameters (existing behaviour) OR as a
    JSON body (Content-Type: application/json).  When both are present for the
    same field, the query-parameter value takes priority.
    """
    name: Optional[str] = None
    section: Optional[str] = None
    category: Optional[str] = None
    subtask: Optional[str] = None
    status: Optional[str] = None
    is_paused: Optional[bool] = None
    notes: Optional[str] = None
    manual_last_done_override: Optional[str] = None
    priority: Optional[int] = None
    interval_days: Optional[int] = None
    active_from: Optional[str] = None
    end_date: Optional[str] = None


@app.patch("/tasks/{task_id}")
def update_task(
    task_id: int,
    # ── query-parameter fields (original interface) ──────────────────────────
    name: Optional[str] = None,
    section: Optional[str] = None,
    category: Optional[str] = None,
    subtask: Optional[str] = None,
    status: Optional[str] = None,
    is_paused: Optional[bool] = None,
    notes: Optional[str] = None,
    manual_last_done_override: Optional[str] = None,
    priority: Optional[int] = None,
    interval_days: Optional[int] = None,
    active_from: Optional[str] = None,
    end_date: Optional[str] = None,
    # ── optional JSON body (new; query params take priority when both present) ─
    body: Optional[TaskPatch] = Body(default=None),
):
    """Update mutable task fields. Only provided fields are changed.

    status and is_paused are always kept in sync:
    - Setting status drives is_paused (status='hiatus' → is_paused=1, status='active' → is_paused=0).
    - Setting is_paused drives status (True → status='hiatus', False → status='active').
    - If both are provided in the same request, status takes priority.
    """
    # Merge JSON body into query params.  Query-param value wins if both present.
    # Use model_fields_set to distinguish "field explicitly sent as null" from
    # "field not included in the body at all" — both arrive as None in Pydantic.
    if body is not None:
        bset = body.model_fields_set
        if name is None and "name" in bset:                               name = body.name
        if section is None and "section" in bset:                         section = body.section
        if category is None and "category" in bset:                       category = body.category
        if subtask is None and "subtask" in bset:                         subtask = body.subtask
        if status is None and "status" in bset:                           status = body.status
        if is_paused is None and "is_paused" in bset:                     is_paused = body.is_paused
        if notes is None and "notes" in bset:                             notes = body.notes
        if manual_last_done_override is None and "manual_last_done_override" in bset:
            manual_last_done_override = body.manual_last_done_override
        if priority is None and "priority" in bset:                       priority = body.priority
        if interval_days is None and "interval_days" in bset:             interval_days = body.interval_days
        if active_from is None and "active_from" in bset:                 active_from = body.active_from
        if end_date is None and "end_date" in bset:
            # null in JSON means "clear end_date".  Map to "" so the handler's
            # _normalize_date_override("") → None path fires and writes NULL.
            end_date = body.end_date if body.end_date is not None else ""

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
    if name is not None:
        updates["name"] = name
    if section is not None:
        updates["section"] = section
    if category is not None:
        updates["category"] = category
    if subtask is not None:
        updates["subtask"] = subtask

    # status and is_paused are bidirectionally synced.
    # status takes priority when both are provided in the same request.
    if status is not None:
        norm = _normalize_status(status)
        updates["status"] = norm
        updates["is_paused"] = 1 if norm == 'hiatus' else 0
        updates["paused_at"] = datetime.now().isoformat() if norm == 'hiatus' else None
    elif is_paused is not None:
        updates["is_paused"] = int(is_paused)
        updates["status"] = 'hiatus' if is_paused else 'active'
        updates["paused_at"] = datetime.now().isoformat() if is_paused else None

    if notes is not None:
        updates["notes"] = notes
    if manual_last_done_override is not None:
        updates["manual_last_done_override"] = _normalize_date_override(manual_last_done_override)
    if priority is not None:
        updates["priority"] = priority
    if interval_days is not None:
        updates["interval_days"] = interval_days
    if active_from is not None:
        updates["active_from"] = _normalize_date_override(active_from)

    # end_date: normalize and track the resolved value for completion cleanup.
    end_date_val: Optional[str] = None
    if end_date is not None:
        end_date_val = _normalize_date_override(end_date)
        updates["end_date"] = end_date_val

    if updates:
        # Column names are hardcoded above — not from user input — so this is safe
        set_clause = ", ".join(f"{col} = ?" for col in updates)
        values = list(updates.values()) + [task_id]
        with conn:
            conn.execute(f"UPDATE tasks SET {set_clause} WHERE id = ?", values)
            # When a non-null end_date is set, delete completions after it.
            # Completions on end_date are preserved (completion_date > end_date_val).
            if end_date is not None and end_date_val is not None:
                conn.execute(
                    "DELETE FROM completions WHERE task_id = ? AND completion_date > ?",
                    (task_id, end_date_val),
                )

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


@app.delete("/tasks/{task_id}")
def delete_task(task_id: int):
    """Soft-delete a task by setting is_active=0.

    Completion history is preserved. Archive snapshots are unaffected.
    Returns 404 if the task does not exist or is already inactive.
    """
    conn = get_connection()
    row = conn.execute(
        "SELECT id FROM tasks WHERE id = ? AND is_active = 1", (task_id,)
    ).fetchone()
    if not row:
        conn.close()
        raise HTTPException(status_code=404, detail="Task not found")
    with conn:
        conn.execute("UPDATE tasks SET is_active = 0 WHERE id = ?", (task_id,))
    conn.close()
    return {"deleted": task_id}


class ReorderBody(BaseModel):
    order: list[int]


@app.post("/tasks/reorder", status_code=200)
def reorder_tasks(body: ReorderBody):
    """Set display_order for tasks in bulk.

    Accepts an ordered list of task IDs.  Each task's display_order is set to
    its index in the list (0-based).  Tasks not included in the list are
    unchanged.
    """
    if not body.order:
        return {"reordered": 0}
    conn = get_connection()
    with conn:
        for i, task_id in enumerate(body.order):
            conn.execute(
                "UPDATE tasks SET display_order = ? WHERE id = ? AND is_active = 1",
                (i, task_id),
            )
    conn.close()
    return {"reordered": len(body.order)}


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


@app.patch("/completions/{task_id}/{completion_date}")
def set_completion_count(task_id: int, completion_date: str, count: int):
    """
    Set the completion count for a task/date cell to an exact value.
    count = 0  → delete the row (clear the cell); no-op if already empty.
    count > 0  → create or update the row; preserves created_timestamp on update.
    Negative counts and future dates are rejected.
    """
    if count < 0:
        raise HTTPException(status_code=422, detail="count must be >= 0")
    if completion_date > date.today().isoformat():
        raise HTTPException(status_code=422, detail="Cannot set completions for future dates")

    conn = get_connection()
    if not conn.execute("SELECT id FROM tasks WHERE id = ?", (task_id,)).fetchone():
        conn.close()
        raise HTTPException(status_code=404, detail="Task not found")

    if count == 0:
        with conn:
            conn.execute(
                "DELETE FROM completions WHERE task_id = ? AND completion_date = ?",
                (task_id, completion_date),
            )
        conn.close()
        return {"deleted": True, "task_id": task_id, "completion_date": completion_date, "completion_count": 0}

    # count > 0: upsert — UPDATE existing row (preserves created_timestamp) or INSERT new row.
    now = datetime.now().isoformat()
    existing = conn.execute(
        "SELECT * FROM completions WHERE task_id = ? AND completion_date = ?",
        (task_id, completion_date),
    ).fetchone()

    with conn:
        if existing:
            conn.execute(
                "UPDATE completions SET completion_count = ?, updated_timestamp = ? "
                "WHERE task_id = ? AND completion_date = ?",
                (count, now, task_id, completion_date),
            )
        else:
            conn.execute(
                "INSERT INTO completions (task_id, completion_date, completion_count, "
                "created_timestamp, updated_timestamp) VALUES (?, ?, ?, ?, ?)",
                (task_id, completion_date, count, now, now),
            )

    result = conn.execute(
        "SELECT * FROM completions WHERE task_id = ? AND completion_date = ?",
        (task_id, completion_date),
    ).fetchone()
    conn.close()
    return dict(result)


# ---------------------------------------------------------------------------
# Cell Notes — P5
# ---------------------------------------------------------------------------

@app.get("/notes")
def list_notes(
    start: str = Query(..., description="Start date YYYY-MM-DD"),
    end: str = Query(..., description="End date YYYY-MM-DD"),
):
    """Return all cell notes whose note_date falls in [start, end]."""
    conn = get_connection()
    rows = conn.execute(
        "SELECT task_id, note_date, note FROM cell_notes "
        "WHERE note_date BETWEEN ? AND ?",
        (start, end),
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


@app.put("/notes/{task_id}/{note_date}", status_code=200)
def upsert_note(task_id: int, note_date: str, note: str = ""):
    """
    Upsert a cell note for a task/date.
    Empty or whitespace-only note → delete the row (treated as no note).
    """
    note = note.strip()
    conn = get_connection()
    if not conn.execute("SELECT id FROM tasks WHERE id = ?", (task_id,)).fetchone():
        conn.close()
        raise HTTPException(status_code=404, detail="Task not found")

    now = datetime.now().isoformat()

    if not note:
        with conn:
            conn.execute(
                "DELETE FROM cell_notes WHERE task_id = ? AND note_date = ?",
                (task_id, note_date),
            )
        conn.close()
        return {"deleted": True, "task_id": task_id, "note_date": note_date}

    existing = conn.execute(
        "SELECT id FROM cell_notes WHERE task_id = ? AND note_date = ?",
        (task_id, note_date),
    ).fetchone()
    with conn:
        if existing:
            conn.execute(
                "UPDATE cell_notes SET note = ?, updated_at = ? "
                "WHERE task_id = ? AND note_date = ?",
                (note, now, task_id, note_date),
            )
        else:
            conn.execute(
                "INSERT INTO cell_notes (task_id, note_date, note, created_at, updated_at) "
                "VALUES (?, ?, ?, ?, ?)",
                (task_id, note_date, note, now, now),
            )

    row = conn.execute(
        "SELECT task_id, note_date, note FROM cell_notes "
        "WHERE task_id = ? AND note_date = ?",
        (task_id, note_date),
    ).fetchone()
    conn.close()
    return dict(row)


@app.delete("/notes/{task_id}/{note_date}")
def delete_note(task_id: int, note_date: str):
    """Explicitly delete a cell note row."""
    conn = get_connection()
    existing = conn.execute(
        "SELECT id FROM cell_notes WHERE task_id = ? AND note_date = ?",
        (task_id, note_date),
    ).fetchone()
    if not existing:
        conn.close()
        raise HTTPException(status_code=404, detail="Note not found")
    with conn:
        conn.execute(
            "DELETE FROM cell_notes WHERE task_id = ? AND note_date = ?",
            (task_id, note_date),
        )
    conn.close()
    return {"deleted": True, "task_id": task_id, "note_date": note_date}


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
    today_iso = today.isoformat()
    conn = get_connection()

    rows = conn.execute(
        """
        SELECT t.*,
               (SELECT MAX(completion_date)
                FROM completions c
                WHERE c.task_id = t.id) AS latest_completion
        FROM tasks t
        WHERE t.is_active = 1 AND t.is_paused = 0
          AND (t.end_date IS NULL OR t.end_date > ?)
        ORDER BY t.display_order, t.id
        """,
        (today_iso,),
    ).fetchall()

    active_tasks = [_enrich_task(dict(r), today) for r in rows]

    top_5 = sorted(
        [t for t in active_tasks if not t["is_scheduled"]],
        key=lambda t: t["urgency"],
        reverse=True,
    )[:5]

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

    # Dormant: 30+ days since any completion (active, non-paused, not scheduled)
    dormant = [t for t in active_tasks if t["days_since"] >= 30 and not t["is_scheduled"]]

    paused_count = conn.execute(
        "SELECT COUNT(*) FROM tasks WHERE is_active = 1 AND is_paused = 1"
        " AND (end_date IS NULL OR end_date > ?)",
        (today_iso,),
    ).fetchone()[0]

    # Never done: excludes scheduled (not yet started), paused, and ended tasks.
    never_done_count = conn.execute(
        """
        SELECT COUNT(*) FROM tasks t
        WHERE t.is_active = 1 AND t.is_paused = 0
          AND (t.end_date IS NULL OR t.end_date > ?)
          AND NOT EXISTS (SELECT 1 FROM completions c WHERE c.task_id = t.id)
          AND t.manual_last_done_override IS NULL
          AND (t.active_from IS NULL OR t.active_from <= ?)
        """,
        (today_iso, today_iso),
    ).fetchone()[0]

    # active_count — explicit, avoids frontend re-derivation from category_summary
    active_count = len(active_tasks)

    # urgency_distribution — 4 bins, active non-paused only, matching urgencyClass thresholds
    dist: dict[str, int] = {"critical": 0, "high": 0, "noticeable": 0, "low": 0}
    for t in active_tasks:
        u = t["urgency"]
        if u >= 8:
            dist["critical"] += 1
        elif u >= 6:
            dist["high"] += 1
        elif u >= 3:
            dist["noticeable"] += 1
        else:
            dist["low"] += 1

    # completion_trend — last 30 days (today-29 through today), zero-filled, all tasks
    trend_start = (today - timedelta(days=29)).isoformat()
    trend_rows = conn.execute(
        """
        SELECT completion_date, SUM(completion_count) AS total
        FROM completions
        WHERE completion_date BETWEEN ? AND ?
        GROUP BY completion_date
        """,
        (trend_start, today.isoformat()),
    ).fetchall()
    trend_map = {r["completion_date"]: r["total"] for r in trend_rows}
    date_list = [(today - timedelta(days=29 - i)).isoformat() for i in range(30)]
    completion_trend = [
        {"date": d, "count": trend_map.get(d, 0)}
        for d in date_list
    ]

    # completion_heatmap — section × date, same 30-day window as completion_trend.
    # Uses current task.section (not historical). Includes paused and soft-deleted
    # tasks because their historical completions are real activity.
    heat_sql_rows = conn.execute(
        """
        SELECT t.section, c.completion_date, SUM(c.completion_count) AS total
        FROM completions c
        JOIN tasks t ON t.id = c.task_id
        WHERE c.completion_date BETWEEN ? AND ?
        GROUP BY t.section, c.completion_date
        """,
        (trend_start, today.isoformat()),
    ).fetchall()

    heat_map: dict[str, dict[str, int]] = defaultdict(lambda: {d: 0 for d in date_list})
    for r in heat_sql_rows:
        section_key = r["section"] if r["section"] else ""
        heat_map[section_key][r["completion_date"]] = r["total"]

    heatmap_rows = []
    for section_key, day_counts in heat_map.items():
        values = [day_counts[d] for d in date_list]
        total = sum(values)
        if total == 0:
            continue
        label = section_key.strip() if section_key.strip() else "(no section)"
        heatmap_rows.append({
            "key": section_key,
            "label": label,
            "total": total,
            "values": values,
        })
    heatmap_rows.sort(key=lambda r: r["total"], reverse=True)

    heatmap_max = max(
        (v for row in heatmap_rows for v in row["values"]),
        default=0,
    )
    completion_heatmap = {
        "group_by": "section",
        "dates": date_list,
        "rows": heatmap_rows,
        "max_value": heatmap_max,
    }

    # Side-effect: upsert today's task-state snapshots for historical analytics.
    _capture_daily_snapshots(conn, today)

    conn.close()
    return {
        "top_5_urgent": top_5,
        "category_summary": category_summary,
        "dormant_tasks": dormant,
        "paused_count": paused_count,
        "never_done_count": never_done_count,
        "active_count": active_count,
        "urgency_distribution": dist,
        "completion_trend": completion_trend,
        "completion_heatmap": completion_heatmap,
    }


# ---------------------------------------------------------------------------
# Snapshot analytics
# ---------------------------------------------------------------------------

@app.get("/snapshots/pressure")
def snapshot_pressure(days: int = Query(default=30, ge=1, le=90)):
    """
    Historical pressure heatmap from task_daily_snapshots.

    Returns section × snapshot-date avg/max urgency.
    Only includes dates where snapshots actually exist — no calendar zero-fill.
    Paused and scheduled tasks are excluded (their urgency=0 would distort real pressure).
    null in avg_values/max_values/critical_counts means no qualifying tasks for that
    section on that date (distinct from 0.0 which is real captured zero urgency).
    """
    conn = get_connection()

    # Step 1: most recent N distinct snapshot dates, sorted oldest→newest.
    date_rows = conn.execute(
        "SELECT DISTINCT snapshot_date FROM task_daily_snapshots "
        "ORDER BY snapshot_date DESC LIMIT ?",
        (days,),
    ).fetchall()

    if not date_rows:
        conn.close()
        return {
            "metric": "avg_urgency",
            "days_requested": days,
            "snapshot_count": 0,
            "dates": [],
            "rows": [],
            "max_avg": 0,
            "max_max": 0,
        }

    date_list = sorted(r["snapshot_date"] for r in date_rows)  # oldest→newest

    # Step 2: aggregate per (snapshot_date, section) for those dates,
    # excluding paused and scheduled tasks.
    placeholders = ",".join("?" * len(date_list))
    agg_rows = conn.execute(
        f"""
        SELECT
            snapshot_date,
            COALESCE(section, '') AS section,
            AVG(urgency)          AS avg_urgency,
            MAX(urgency)          AS max_urgency,
            SUM(CASE WHEN urgency >= 8 THEN 1 ELSE 0 END) AS critical_count
        FROM task_daily_snapshots
        WHERE snapshot_date IN ({placeholders})
          AND is_paused    = 0
          AND is_scheduled = 0
          AND is_ended     = 0
        GROUP BY snapshot_date, section
        """,
        date_list,
    ).fetchall()
    conn.close()

    # Build section → { date_iso: {avg, max, critical} } lookup.
    sec_date_map: dict[str, dict] = defaultdict(dict)
    for r in agg_rows:
        sec_date_map[r["section"]][r["snapshot_date"]] = {
            "avg":      round(float(r["avg_urgency"]), 2),
            "max":      round(float(r["max_urgency"]), 2),
            "critical": int(r["critical_count"]),
        }

    # Build response rows — null for section/date combos with no qualifying tasks.
    rows = []
    for sec_key, date_map in sec_date_map.items():
        avg_values:      list = []
        max_values:      list = []
        critical_counts: list = []

        for d in date_list:
            if d in date_map:
                avg_values.append(date_map[d]["avg"])
                max_values.append(date_map[d]["max"])
                critical_counts.append(date_map[d]["critical"])
            else:
                avg_values.append(None)
                max_values.append(None)
                critical_counts.append(None)

        valid_avgs = [v for v in avg_values if v is not None]
        row_avg    = round(sum(valid_avgs) / len(valid_avgs), 2) if valid_avgs else 0.0
        row_max    = max((v for v in max_values if v is not None), default=0.0)
        crit_days  = sum(v for v in critical_counts if v is not None)

        label = sec_key.strip() if sec_key.strip() else "(no section)"
        rows.append({
            "key":             sec_key,
            "label":           label,
            "avg_values":      avg_values,
            "max_values":      max_values,
            "critical_counts": critical_counts,
            "avg_urgency":     row_avg,
            "max_urgency":     row_max,
            "critical_days":   crit_days,
        })

    rows.sort(key=lambda r: r["avg_urgency"], reverse=True)

    max_avg = max((r["avg_urgency"] for r in rows), default=0.0)
    max_max = max((r["max_urgency"] for r in rows), default=0.0)

    return {
        "metric":         "avg_urgency",
        "days_requested": days,
        "snapshot_count": len(date_list),
        "dates":          date_list,
        "rows":           rows,
        "max_avg":        round(max_avg, 2),
        "max_max":        round(max_max, 2),
    }


# ---------------------------------------------------------------------------
# Archives
# ---------------------------------------------------------------------------

@app.post("/archives", status_code=201)
def create_archive(name: str, start_date: str, end_date: str):
    """
    Save a read-only snapshot of all active tasks and their completions
    for the given date range. Does not modify tasks or completions.
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
        WHERE t.is_active = 1
        ORDER BY t.display_order, t.id
        """
    ).fetchall()
    tasks = [_enrich_task(dict(r), today) for r in rows]

    comp_rows = conn.execute(
        "SELECT task_id, completion_date, completion_count FROM completions "
        "WHERE completion_date BETWEEN ? AND ?",
        (start_date, end_date),
    ).fetchall()

    comp_map: dict[int, dict[str, int]] = {}
    for c in comp_rows:
        tid = c["task_id"]
        if tid not in comp_map:
            comp_map[tid] = {}
        comp_map[tid][c["completion_date"]] = c["completion_count"]

    note_rows = conn.execute(
        "SELECT task_id, note_date, note FROM cell_notes "
        "WHERE note_date BETWEEN ? AND ?",
        (start_date, end_date),
    ).fetchall()

    note_map: dict[int, dict[str, str]] = {}
    for n in note_rows:
        tid = n["task_id"]
        if tid not in note_map:
            note_map[tid] = {}
        note_map[tid][n["note_date"]] = n["note"]

    for t in tasks:
        t["completions"] = comp_map.get(t["id"], {})
        t["cell_notes"] = note_map.get(t["id"], {})

    snapshot = {
        "snapshot_schema_version": 2,
        "start_date": start_date,
        "end_date": end_date,
        "tasks": tasks,
    }
    archived_at = datetime.now().isoformat()

    with conn:
        cursor = conn.execute(
            "INSERT INTO archive_snapshots (name, start_date, end_date, archived_at, snapshot_data_json) "
            "VALUES (?, ?, ?, ?, ?)",
            (name, start_date, end_date, archived_at, json.dumps(snapshot)),
        )
        archive_id = cursor.lastrowid

    conn.close()
    return {
        "id": archive_id,
        "name": name,
        "start_date": start_date,
        "end_date": end_date,
        "archived_at": archived_at,
    }


@app.get("/archives")
def list_archives():
    """List all archive snapshots without snapshot_data_json."""
    conn = get_connection()
    rows = conn.execute(
        "SELECT id, name, start_date, end_date, archived_at "
        "FROM archive_snapshots ORDER BY archived_at DESC"
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


@app.get("/archives/{archive_id}")
def get_archive(archive_id: int):
    """Return one archive snapshot including parsed snapshot_data_json."""
    conn = get_connection()
    row = conn.execute(
        "SELECT * FROM archive_snapshots WHERE id = ?", (archive_id,)
    ).fetchone()
    conn.close()
    if not row:
        raise HTTPException(status_code=404, detail="Archive not found")
    result = dict(row)
    result["snapshot_data_json"] = json.loads(result["snapshot_data_json"])
    return result


@app.patch("/archives/{archive_id}")
def rename_archive(archive_id: int, name: str):
    """Rename an archived snapshot. Does not touch snapshot data."""
    name = name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="Archive name cannot be blank")
    conn = get_connection()
    row = conn.execute(
        "SELECT id FROM archive_snapshots WHERE id = ?", (archive_id,)
    ).fetchone()
    if not row:
        conn.close()
        raise HTTPException(status_code=404, detail="Archive not found")
    with conn:
        conn.execute(
            "UPDATE archive_snapshots SET name = ? WHERE id = ?", (name, archive_id)
        )
    updated = conn.execute(
        "SELECT id, name, start_date, end_date, archived_at FROM archive_snapshots WHERE id = ?",
        (archive_id,),
    ).fetchone()
    conn.close()
    return dict(updated)


@app.delete("/archives/{archive_id}")
def delete_archive(archive_id: int):
    """Delete an archived snapshot. Does not touch tasks or completion data."""
    conn = get_connection()
    row = conn.execute(
        "SELECT id FROM archive_snapshots WHERE id = ?", (archive_id,)
    ).fetchone()
    if not row:
        conn.close()
        raise HTTPException(status_code=404, detail="Archive not found")
    with conn:
        conn.execute("DELETE FROM archive_snapshots WHERE id = ?", (archive_id,))
    conn.close()
    return {"deleted": archive_id}


# ---------------------------------------------------------------------------
# Project docs (Privacy, Accessibility, Terms)
# ---------------------------------------------------------------------------

_DOCS_ROOT = Path(__file__).parent.parent
_ALLOWED_DOCS: dict[str, str] = {
    "privacy":       "PRIVACY.md",
    "accessibility": "ACCESSIBILITY.md",
    "terms":         "TERMS.md",
}

@app.get("/docs/{name}", response_class=Response)
def serve_doc(name: str):
    filename = _ALLOWED_DOCS.get(name)
    if not filename:
        raise HTTPException(status_code=404, detail="Document not found")
    path = _DOCS_ROOT / filename
    if not path.exists():
        raise HTTPException(status_code=404, detail="Document file missing")
    return Response(content=path.read_text(encoding="utf-8"), media_type="text/plain; charset=utf-8")

# ---------------------------------------------------------------------------
# Export
# ---------------------------------------------------------------------------

@app.get("/export/backup.json")
def export_backup():
    """
    Download all local data as a JSON file.
    Includes all tasks (active and inactive), all completions, all archive
    snapshots, and a schema version for future compatibility.
    Does not mutate the database.
    """
    conn = get_connection()
    tasks = [dict(r) for r in conn.execute("SELECT * FROM tasks").fetchall()]
    completions = [dict(r) for r in conn.execute("SELECT * FROM completions").fetchall()]
    cell_notes = [dict(r) for r in conn.execute("SELECT * FROM cell_notes").fetchall()]
    archive_rows = conn.execute("SELECT * FROM archive_snapshots").fetchall()
    archives = []
    for r in archive_rows:
        row = dict(r)
        row["snapshot_data_json"] = json.loads(row["snapshot_data_json"])
        archives.append(row)
    daily_snapshots = [
        dict(r) for r in conn.execute(
            "SELECT * FROM task_daily_snapshots ORDER BY snapshot_date, task_id"
        ).fetchall()
    ]
    conn.close()

    payload = {
        "schema_version": 3,
        "exported_at": datetime.now().isoformat(),
        "tasks": tasks,
        "completions": completions,
        "cell_notes": cell_notes,
        "archive_snapshots": archives,
        "task_daily_snapshots": daily_snapshots,
    }
    filename = f"taskos-backup-{date.today().isoformat()}.json"
    return Response(
        content=json.dumps(payload, indent=2),
        media_type="application/json",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@app.get("/export/sheet.csv")
def export_sheet_csv(
    start: str = Query(..., description="Start date YYYY-MM-DD"),
    end: str = Query(..., description="End date YYYY-MM-DD"),
):
    """
    Download the visible grid date range as a CSV file.
    Includes active tasks only.
    Metadata columns + one column per date in [start, end].
    Completion cells: blank = 0 completions, integer = completion count.
    Does not mutate the database.
    """
    try:
        start_date = date.fromisoformat(start)
        end_date = date.fromisoformat(end)
    except ValueError:
        raise HTTPException(status_code=422, detail="Invalid date format. Use YYYY-MM-DD.")
    if end_date < start_date:
        raise HTTPException(status_code=400, detail="end must not be before start")

    today = date.today()
    conn = get_connection()

    rows = conn.execute(
        """
        SELECT t.*,
               (SELECT MAX(completion_date)
                FROM completions c
                WHERE c.task_id = t.id) AS latest_completion
        FROM tasks t
        WHERE t.is_active = 1
        ORDER BY t.display_order, t.id
        """
    ).fetchall()
    tasks = [_enrich_task(dict(r), today) for r in rows]

    comp_rows = conn.execute(
        "SELECT task_id, completion_date, completion_count FROM completions "
        "WHERE completion_date BETWEEN ? AND ?",
        (start, end),
    ).fetchall()
    comp_map: dict[tuple, int] = {}
    for c in comp_rows:
        comp_map[(c["task_id"], c["completion_date"])] = c["completion_count"]
    conn.close()

    # Build ordered date list
    dates: list[str] = []
    d = start_date
    while d <= end_date:
        dates.append(d.isoformat())
        d += timedelta(days=1)

    meta_cols = ["name", "section", "category", "subtask", "priority", "interval_days",
                 "status", "active_from", "end_date", "urgency", "days_since", "notes"]

    output = io.StringIO()
    writer = csv.writer(output)
    writer.writerow(meta_cols + dates)
    for t in tasks:
        row = [
            t["name"], t.get("section", "General"), t.get("category", ""),
            t.get("subtask", ""), t["priority"], t["interval_days"], t["status"],
            t.get("active_from") or "", t.get("end_date") or "",
            t["urgency"], t["days_since"], t.get("notes", ""),
        ]
        for iso in dates:
            count = comp_map.get((t["id"], iso), 0)
            row.append(count if count else "")  # blank for 0
        writer.writerow(row)

    filename = f"taskos-sheet-{start}-{end}.csv"
    return Response(
        content=output.getvalue(),
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


# ---------------------------------------------------------------------------
# Restore
# ---------------------------------------------------------------------------

_SUPPORTED_SCHEMA_VERSIONS = frozenset({1, 2, 3})


@app.post("/restore/backup.json", status_code=200)
async def restore_backup(file: UploadFile = File(...)):
    """
    Restore all data from a JSON backup produced by GET /export/backup.json.

    Before overwriting anything, a safety copy of the current DB is written to
    <db-dir>/backups/pre-restore-<timestamp>.db using the SQLite backup API.

    Supported schema_versions: 1, 2, 3.
    All existing rows are deleted and replaced with backup data in a single
    transaction; if the insert phase fails the transaction rolls back and the
    safety copy lets you recover manually.
    """
    raw = await file.read()
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=400, detail=f"Invalid JSON: {exc}")

    schema_version = payload.get("schema_version", 1)
    if schema_version not in _SUPPORTED_SCHEMA_VERSIONS:
        raise HTTPException(
            status_code=400,
            detail=(
                f"Unsupported schema_version {schema_version!r}. "
                f"Expected one of {sorted(_SUPPORTED_SCHEMA_VERSIONS)}."
            ),
        )

    tasks_data = payload.get("tasks", [])
    completions_data = payload.get("completions", [])
    cell_notes_data = payload.get("cell_notes", [])
    archives_data = payload.get("archive_snapshots", [])
    snapshots_data = payload.get("task_daily_snapshots", [])

    # Safety backup before any writes.
    backup_dir = DB_PATH.parent / "backups"
    backup_dir.mkdir(parents=True, exist_ok=True)
    safety_path = backup_dir / f"pre-restore-{datetime.now().strftime('%Y%m%d-%H%M%S')}.db"
    if DB_PATH.exists():
        src = sqlite3.connect(str(DB_PATH))
        dst = sqlite3.connect(str(safety_path))
        src.backup(dst)
        dst.close()
        src.close()

    conn = get_connection()
    try:
        with conn:
            # Delete in dependency order (child tables first, then parent).
            conn.execute("DELETE FROM task_daily_snapshots")
            conn.execute("DELETE FROM cell_notes")
            conn.execute("DELETE FROM completions")
            conn.execute("DELETE FROM archive_snapshots")
            conn.execute("DELETE FROM tasks")

            # Insert tasks first so FK constraints hold for dependent tables.
            for t in tasks_data:
                conn.execute(
                    """
                    INSERT INTO tasks (
                        id, name, section, category, subtask, priority,
                        interval_days, status, notes, created_at, paused_at,
                        is_active, is_paused, manual_last_done_override,
                        display_order, active_from, end_date
                    ) VALUES (
                        :id, :name, :section, :category, :subtask, :priority,
                        :interval_days, :status, :notes, :created_at, :paused_at,
                        :is_active, :is_paused, :manual_last_done_override,
                        :display_order, :active_from, :end_date
                    )
                    """,
                    {
                        "id":                      t.get("id"),
                        "name":                    t["name"],
                        "section":                 t.get("section", "General"),
                        "category":                t.get("category", ""),
                        "subtask":                 t.get("subtask", ""),
                        "priority":                t.get("priority", 5),
                        "interval_days":           t.get("interval_days", 7),
                        "status":                  t.get("status", "active"),
                        "notes":                   t.get("notes", ""),
                        "created_at":              t.get("created_at"),
                        "paused_at":               t.get("paused_at"),
                        "is_active":               t.get("is_active", 1),
                        "is_paused":               t.get("is_paused", 0),
                        "manual_last_done_override": t.get("manual_last_done_override"),
                        "display_order":           t.get("display_order", 0),
                        "active_from":             t.get("active_from"),
                        "end_date":                t.get("end_date"),
                    },
                )

            for c in completions_data:
                conn.execute(
                    """
                    INSERT INTO completions (
                        id, task_id, completion_date, completion_count,
                        created_timestamp, updated_timestamp
                    ) VALUES (
                        :id, :task_id, :completion_date, :completion_count,
                        :created_timestamp, :updated_timestamp
                    )
                    """,
                    {
                        "id":                c.get("id"),
                        "task_id":           c["task_id"],
                        "completion_date":   c["completion_date"],
                        "completion_count":  c.get("completion_count", 1),
                        "created_timestamp": c.get("created_timestamp"),
                        "updated_timestamp": c.get("updated_timestamp"),
                    },
                )

            for n in cell_notes_data:
                conn.execute(
                    """
                    INSERT INTO cell_notes (
                        id, task_id, note_date, note, created_at, updated_at
                    ) VALUES (
                        :id, :task_id, :note_date, :note, :created_at, :updated_at
                    )
                    """,
                    {
                        "id":         n.get("id"),
                        "task_id":    n["task_id"],
                        "note_date":  n["note_date"],
                        "note":       n.get("note", ""),
                        "created_at": n.get("created_at"),
                        "updated_at": n.get("updated_at"),
                    },
                )

            for a in archives_data:
                snap = a.get("snapshot_data_json", {})
                if not isinstance(snap, str):
                    snap = json.dumps(snap)
                conn.execute(
                    """
                    INSERT INTO archive_snapshots (
                        id, name, start_date, end_date, archived_at, snapshot_data_json
                    ) VALUES (
                        :id, :name, :start_date, :end_date, :archived_at, :snapshot_data_json
                    )
                    """,
                    {
                        "id":                 a.get("id"),
                        "name":               a["name"],
                        "start_date":         a["start_date"],
                        "end_date":           a["end_date"],
                        "archived_at":        a["archived_at"],
                        "snapshot_data_json": snap,
                    },
                )

            for s in snapshots_data:
                conn.execute(
                    """
                    INSERT INTO task_daily_snapshots (
                        id, task_id, snapshot_date, task_name, section, category,
                        status, is_paused, is_scheduled, active_from, priority,
                        interval_days, days_since, urgency, completion_count,
                        effective_last_done, end_date, is_ended, created_at, updated_at
                    ) VALUES (
                        :id, :task_id, :snapshot_date, :task_name, :section, :category,
                        :status, :is_paused, :is_scheduled, :active_from, :priority,
                        :interval_days, :days_since, :urgency, :completion_count,
                        :effective_last_done, :end_date, :is_ended, :created_at, :updated_at
                    )
                    """,
                    {
                        "id":                 s.get("id"),
                        "task_id":            s["task_id"],
                        "snapshot_date":      s["snapshot_date"],
                        "task_name":          s["task_name"],
                        "section":            s.get("section"),
                        "category":           s.get("category"),
                        "status":             s["status"],
                        "is_paused":          s.get("is_paused", 0),
                        "is_scheduled":       s.get("is_scheduled", 0),
                        "active_from":        s.get("active_from"),
                        "priority":           s["priority"],
                        "interval_days":      s["interval_days"],
                        "days_since":         s.get("days_since"),
                        "urgency":            s.get("urgency"),
                        "completion_count":   s.get("completion_count", 0),
                        "effective_last_done": s.get("effective_last_done"),
                        "end_date":           s.get("end_date"),
                        "is_ended":           s.get("is_ended", 0),
                        "created_at":         s.get("created_at"),
                        "updated_at":         s.get("updated_at"),
                    },
                )
    except Exception as exc:
        conn.close()
        raise HTTPException(status_code=500, detail=f"Restore failed: {exc}")

    conn.close()
    return {
        "restored": True,
        "schema_version": schema_version,
        "tasks": len(tasks_data),
        "completions": len(completions_data),
        "cell_notes": len(cell_notes_data),
        "archive_snapshots": len(archives_data),
        "task_daily_snapshots": len(snapshots_data),
        "safety_backup": str(safety_path),
    }


# ---------------------------------------------------------------------------
# Import helpers
# ---------------------------------------------------------------------------

# Known metadata field aliases.
# Detection uses exact match against the normalized (lowercased, stripped) header.
_IMPORT_ALIASES: dict[str, list[str]] = {
    "name":                      ["task", "name", "task name"],
    "section":                   ["section", "group", "grouping", "major category", "area"],
    "category":                  ["category", "cat"],
    "subtask":                   ["subtask", "sub"],
    "priority":                  ["priority", "pri", "p"],
    "interval_days":             ["freq", "frequency", "interval", "interval_days"],
    "status":                    ["status"],
    "active_from":               ["active_from", "active from", "relevant from", "starts"],
    "end_date":                  ["end_date", "end date", "ends", "retire date", "retire"],
    "notes":                     ["notes", "note"],
    "manual_last_done_override": [
        "manual", "last done", "manual last done",
        "override", "manual last done override",
    ],
}

_MONTH_ABBREVS: frozenset[str] = frozenset({
    "jan", "feb", "mar", "apr", "may", "jun",
    "jul", "aug", "sep", "oct", "nov", "dec",
})


def _is_iso_date(s: str) -> bool:
    return bool(re.fullmatch(r"\d{4}-\d{2}-\d{2}", s))


def _looks_like_nonio_date(s: str) -> bool:
    """Heuristic: header looks date-like but is not ISO format."""
    if re.fullmatch(r"\d{1,2}/\d{1,2}/\d{2,4}", s):
        return True
    parts = s.lower().split()
    return len(parts) == 2 and parts[0] in _MONTH_ABBREVS and parts[1].isdigit()


def _detect_field(norm: str) -> Optional[str]:
    """Return the internal field name for a normalized header, or None."""
    for field, aliases in _IMPORT_ALIASES.items():
        if norm in aliases:
            return field
    return None


def _parse_csv_file(raw: bytes) -> dict:
    """
    Parse a CSV file from raw bytes (UTF-8 with optional BOM).
    Returns a dict with keys:
      headers, header_to_idx, meta_map, header_to_field,
      date_cols, candidate_date_cols, unrecognized_cols, data_rows, warnings.
    Duplicate ISO date headers: first occurrence wins; duplicates are warned and skipped.
    """
    text = raw.decode("utf-8-sig")
    all_rows = list(csv.reader(io.StringIO(text)))
    warnings: list[str] = []

    empty = dict(
        headers=[],
        header_to_idx={},
        meta_map={f: None for f in _IMPORT_ALIASES},
        header_to_field={},
        date_cols=[],
        candidate_date_cols=[],
        unrecognized_cols=[],
        data_rows=[],
        warnings=warnings,
    )

    if not all_rows:
        warnings.append("CSV is empty — no headers found.")
        return empty

    headers: list[str] = [h.strip() for h in all_rows[0]]
    if not any(headers):
        warnings.append("CSV has no headers.")
        return empty

    data_rows = [r for r in all_rows[1:] if any(cell.strip() for cell in r)]

    # Build header_to_idx: first-occurrence-wins for duplicate raw headers.
    header_to_idx: dict[str, int] = {}
    for i, h in enumerate(headers):
        if h not in header_to_idx:
            header_to_idx[h] = i

    meta_map: dict[str, Optional[str]] = {f: None for f in _IMPORT_ALIASES}
    date_cols: list[str] = []
    seen_iso_dates: set[str] = set()
    candidate_date_cols: list[str] = []
    unrecognized_cols: list[str] = []
    header_to_field: dict[str, str] = {}

    for i, header in enumerate(headers):
        norm = header.strip().lower()
        if not norm:
            continue

        if _is_iso_date(norm):
            if norm in seen_iso_dates:
                warnings.append(
                    f"Duplicate ISO date column '{header}' at position {i + 1}; "
                    "using first occurrence."
                )
            else:
                seen_iso_dates.add(norm)
                date_cols.append(header)  # ISO date headers equal their normalized form
            continue

        if _looks_like_nonio_date(norm):
            candidate_date_cols.append(header)
            continue

        field = _detect_field(norm)
        if field:
            if meta_map[field] is None:
                meta_map[field] = header
                header_to_field[header] = field
            else:
                warnings.append(
                    f"Duplicate mapping for '{field}': '{meta_map[field]}' and "
                    f"'{header}' both match. Using '{meta_map[field]}'."
                )
                unrecognized_cols.append(header)
        else:
            unrecognized_cols.append(header)

    if meta_map["name"] is None:
        warnings.append(
            "Required field 'name' not detected. "
            "Expected a header named 'Task' or 'Name'."
        )

    if candidate_date_cols:
        warnings.append(
            f"{len(candidate_date_cols)} non-ISO date-like column(s) found but not imported: "
            + ", ".join(f"'{c}'" for c in candidate_date_cols)
            + ". Rename to YYYY-MM-DD format for date column detection."
        )

    return dict(
        headers=headers,
        header_to_idx=header_to_idx,
        meta_map=meta_map,
        header_to_field=header_to_field,
        date_cols=date_cols,
        candidate_date_cols=candidate_date_cols,
        unrecognized_cols=unrecognized_cols,
        data_rows=data_rows,
        warnings=warnings,
    )


def _parse_completion_cell(value: str):
    """
    Parse a completion cell value from an imported CSV.
    Returns:
      None        — blank, '0', 'false', 'no'
      1           — 'true', 'yes', 'x', '✓', '✔', '1'
      int >= 2    — any positive integer > 1
      'negative'  — negative integer
      'invalid'   — anything else
    """
    v = value.strip().lower()
    if v in ("", "0", "false", "no"):
        return None
    if v in ("true", "yes", "x", "✓", "✔", "1"):
        return 1
    try:
        n = int(v)
        if n < 0:
            return "negative"
        if n == 0:
            return None
        return n
    except ValueError:
        return "invalid"


# ---------------------------------------------------------------------------
# Import preview
# ---------------------------------------------------------------------------

@app.post("/import/preview")
async def import_preview(file: UploadFile = File(...)):
    """
    Parse an uploaded CSV and return a column-detection preview.
    Does not write anything to the database.
    """
    raw = await file.read()
    parsed = _parse_csv_file(raw)

    meta_map = parsed["meta_map"]
    header_to_field = parsed["header_to_field"]
    date_cols = parsed["date_cols"]
    candidate_date_cols = parsed["candidate_date_cols"]
    unrecognized_cols = parsed["unrecognized_cols"]
    data_rows = parsed["data_rows"]
    headers = parsed["headers"]
    header_to_idx = parsed["header_to_idx"]
    warnings = parsed["warnings"]

    sample_rows: list[dict] = []
    for row in data_rows[:5]:
        sample: dict = {}
        for header, field in header_to_field.items():
            idx = header_to_idx.get(header)
            if idx is not None:
                sample[field] = row[idx] if idx < len(row) else ""
        if sample:
            sample_rows.append(sample)

    return {
        "row_count": len(data_rows),
        "detected_metadata_columns": meta_map,
        "detected_date_columns": date_cols,
        "candidate_date_columns": candidate_date_cols,
        "unrecognized_columns": unrecognized_cols,
        "sample_rows": sample_rows,
        "warnings": warnings,
    }


# ---------------------------------------------------------------------------
# Import apply
# ---------------------------------------------------------------------------

@app.post("/import/apply", status_code=200)
async def import_apply(file: UploadFile = File(...)):
    """
    Parse an uploaded CSV and create new tasks + completions.
    Does not update or delete any existing data.
    Missing 'name' column is fatal (HTTP 400, nothing written).
    """
    raw = await file.read()
    parsed = _parse_csv_file(raw)

    meta_map = parsed["meta_map"]
    header_to_field = parsed["header_to_field"]
    date_cols = parsed["date_cols"]
    data_rows = parsed["data_rows"]
    header_to_idx = parsed["header_to_idx"]
    warnings: list[str] = list(parsed["warnings"])

    if meta_map["name"] is None:
        raise HTTPException(
            status_code=400,
            detail=(
                "Required field 'name' not detected. "
                "Expected a header named 'Task' or 'Name'. No data was written."
            ),
        )

    today_str = date.today().isoformat()
    now = datetime.utcnow().isoformat()

    tasks_created = 0
    completions_created = 0
    rows_skipped = 0
    potential_duplicates: list[str] = []
    errors: list[str] = []

    def get_cell(row: list, header: str) -> str:
        idx = header_to_idx.get(header)
        if idx is None:
            return ""
        return row[idx].strip() if idx < len(row) else ""

    conn = get_connection()
    with conn:
        # Load existing tasks for duplicate detection (section+category+name+subtask).
        existing_rows = conn.execute(
            "SELECT section, category, name, subtask FROM tasks"
        ).fetchall()
        existing_keys: set[tuple] = {
            (r["section"], r["category"], r["name"], r["subtask"])
            for r in existing_rows
        }

        for row_num, row in enumerate(data_rows, start=2):  # +2: 1-indexed + header row
            name_val = get_cell(row, meta_map["name"])
            if not name_val:
                rows_skipped += 1
                warnings.append(f"Row {row_num}: blank task name, skipped.")
                continue

            def fv(field: str) -> Optional[str]:
                h = meta_map.get(field)
                if h is None:
                    return None
                v = get_cell(row, h)
                return v if v else None

            section = fv("section") or "General"
            category = fv("category") or ""
            subtask = fv("subtask") or ""
            status = _normalize_status(fv("status") or "active")
            is_paused_val = 1 if status == 'hiatus' else 0
            paused_at_val = now if is_paused_val else None
            active_from_val = _normalize_date_override(fv("active_from"))
            end_date_val = _normalize_date_override(fv("end_date"))
            notes = fv("notes") or ""
            manual_override = _normalize_date_override(fv("manual_last_done_override"))

            priority = 5
            priority_str = fv("priority")
            if priority_str:
                try:
                    priority = int(priority_str)
                except ValueError:
                    warnings.append(
                        f"Row {row_num}: invalid priority '{priority_str}', using 5."
                    )

            interval_days = 7
            interval_str = fv("interval_days")
            if interval_str:
                try:
                    interval_days = int(interval_str)
                except ValueError:
                    warnings.append(
                        f"Row {row_num}: invalid interval_days '{interval_str}', using 7."
                    )

            dup_key = (section, category, name_val, subtask)
            if dup_key in existing_keys:
                potential_duplicates.append(
                    f"Row {row_num}: '{name_val}' matches an existing task "
                    "(same section/category/name/subtask), skipped."
                )
                rows_skipped += 1
                continue

            cursor = conn.execute(
                """
                INSERT INTO tasks (
                    name, section, category, subtask, priority, interval_days,
                    status, notes, created_at, is_active, is_paused, paused_at,
                    manual_last_done_override, display_order, active_from, end_date
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, 0, ?, ?)
                """,
                (
                    name_val, section, category, subtask, priority, interval_days,
                    status, notes, today_str, is_paused_val, paused_at_val,
                    manual_override, active_from_val, end_date_val,
                ),
            )
            task_id = cursor.lastrowid
            existing_keys.add(dup_key)
            tasks_created += 1

            for iso_date in date_cols:
                idx = header_to_idx.get(iso_date)
                if idx is None:
                    continue
                raw_val = row[idx] if idx < len(row) else ""
                count = _parse_completion_cell(raw_val)
                if count is None:
                    continue
                if count == "negative":
                    errors.append(
                        f"Row {row_num}, {iso_date}: negative count '{raw_val}', skipped."
                    )
                    continue
                if count == "invalid":
                    errors.append(
                        f"Row {row_num}, {iso_date}: invalid value '{raw_val}', skipped."
                    )
                    continue
                if iso_date > today_str:
                    warnings.append(
                        f"Row {row_num}, {iso_date}: future date, skipped."
                    )
                    continue
                conn.execute(
                    """
                    INSERT OR IGNORE INTO completions
                        (task_id, completion_date, completion_count,
                         created_timestamp, updated_timestamp)
                    VALUES (?, ?, ?, ?, ?)
                    """,
                    (task_id, iso_date, count, now, now),
                )
                completions_created += 1

    conn.close()

    return {
        "tasks_created": tasks_created,
        "completions_created": completions_created,
        "rows_skipped": rows_skipped,
        "potential_duplicates": potential_duplicates,
        "warnings": warnings,
        "errors": errors,
    }
