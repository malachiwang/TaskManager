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
import sys
from pathlib import Path
from collections import defaultdict
from contextlib import asynccontextmanager
from datetime import date, datetime, timedelta
from typing import Optional

from fastapi import Body, FastAPI, File, HTTPException, Query, UploadFile
from pydantic import BaseModel
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response

from backend import academic
from backend import database as db_config
from backend import nl as nl_parser
from backend import recurrence as recurrence_engine
from backend import reports as reports_engine
from backend.database import get_connection, init_db
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


def _normalize_depth(value: Optional[int]) -> Optional[int]:
    """Validate cognitive depth (P12.0). None/0 → NULL (no depth); 1–3 pass
    through; anything else is a 422. 0 is the explicit "clear" sentinel so the
    query-parameter interface can unset depth."""
    if value is None or value == 0:
        return None
    if value not in (1, 2, 3):
        raise HTTPException(status_code=422, detail="depth must be 1, 2, or 3")
    return value


def _normalize_estimate(value: Optional[int]) -> Optional[int]:
    """Validate estimated_minutes (P12.0). None/0 → NULL; positive minutes pass
    through; negatives are a 422."""
    if value is None or value == 0:
        return None
    if value < 0:
        raise HTTPException(status_code=422, detail="estimated_minutes must be >= 0")
    return value


# ---------------------------------------------------------------------------
# Hiatus periods (P11.0)
#
# Interval semantics:
#   - start_date inclusive; end_date inclusive when closed.
#   - end_date NULL = open interval (task is currently on hiatus).
#   - At most one open interval per task; a task may have many closed ones.
#   - Resuming on date R closes the open interval at R-1, so the resume date
#     itself is a normal checkbox cell. If start_date == R (same-day hiatus +
#     resume) the interval would be empty, so it is deleted — a same-day
#     pause/resume leaves no hiatus history.
#   - Entering/leaving hiatus never touches completions or cell overrides;
#     blanking is purely a rendering layer over these persisted intervals.
# ---------------------------------------------------------------------------

def _open_hiatus_period(conn, task_id: int, start_iso: str) -> None:
    """Create an open hiatus interval unless one is already open (idempotent)."""
    existing = conn.execute(
        "SELECT id FROM task_hiatus_periods WHERE task_id = ? AND end_date IS NULL",
        (task_id,),
    ).fetchone()
    if existing:
        return
    now = datetime.now().isoformat()
    conn.execute(
        "INSERT INTO task_hiatus_periods (task_id, start_date, end_date, created_at, updated_at) "
        "VALUES (?, ?, NULL, ?, ?)",
        (task_id, start_iso, now, now),
    )


def _close_hiatus_period(conn, task_id: int, resume_iso: str) -> None:
    """Close the open hiatus interval at resume-date − 1 day (inclusive end).

    Same-day hiatus+resume (start_date == resume date) would produce an empty
    interval, so the row is deleted instead. No-op if nothing is open.
    """
    row = conn.execute(
        "SELECT id, start_date FROM task_hiatus_periods WHERE task_id = ? AND end_date IS NULL",
        (task_id,),
    ).fetchone()
    if not row:
        return
    end_iso = (date.fromisoformat(resume_iso) - timedelta(days=1)).isoformat()
    if end_iso < row["start_date"]:
        conn.execute("DELETE FROM task_hiatus_periods WHERE id = ?", (row["id"],))
    else:
        conn.execute(
            "UPDATE task_hiatus_periods SET end_date = ?, updated_at = ? WHERE id = ?",
            (end_iso, datetime.now().isoformat(), row["id"]),
        )


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Log the resolved DB location so dev/packaged runs are unambiguous
    # (overridable via TASKOS_DB_PATH — see backend/database.py).
    print(f"TaskManager backend — SQLite database: {db_config.DB_PATH}", flush=True)
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

    # Urgency decomposition (P4.0B) — raw derived numbers only, no threshold
    # logic here; the frontend maps these + urgency to a band/reason via its
    # shared urgency module. days_overdue is 0 until past one interval.
    interval = max(1, int(t["interval_days"]))
    t["days_overdue"] = max(0, days - interval)
    t["overdue_ratio"] = round(days / interval, 2)

    t["effective_last_done"] = effective.isoformat()
    t["days_since"] = days
    t["urgency"] = urgency
    t["is_scheduled"] = is_scheduled
    t["end_date"] = end_date_iso  # normalized, or None
    t["is_ended"] = is_ended
    return t


def _attach_session_rollups(conn, tasks: list) -> list:
    """Attach execution rollups (P13.0) to enriched task dicts.

    Factual sums only — no scores, no inferred capacity:
      logged_minutes             work recorded by completed/partial sessions
                                 (actual_minutes; a completed session with no
                                 actuals counts its planned duration)
      scheduled_pending_minutes  planned minutes still sitting in 'scheduled'
                                 sessions (past-due ones included until the
                                 user reconciles them)
      remaining_minutes          estimate − logged   (None without an estimate)
      remaining_unscheduled_minutes
                                 estimate − logged − pending (None without an
                                 estimate) — what the drawer offers to place
    """
    if not tasks:
        return tasks
    rows = conn.execute(
        """
        SELECT task_id,
               SUM(CASE
                     WHEN status = 'completed' THEN COALESCE(actual_minutes,
                          CAST(ROUND((julianday(planned_end) - julianday(planned_start)) * 1440) AS INTEGER))
                     WHEN status = 'partial' THEN COALESCE(actual_minutes, 0)
                     ELSE 0
                   END) AS logged,
               SUM(CASE
                     WHEN status = 'scheduled' THEN
                          CAST(ROUND((julianday(planned_end) - julianday(planned_start)) * 1440) AS INTEGER)
                     ELSE 0
                   END) AS pending
        FROM task_sessions
        GROUP BY task_id
        """
    ).fetchall()
    agg = {r["task_id"]: (r["logged"] or 0, r["pending"] or 0) for r in rows}
    # Deadline coverage (P16.0 §17/§18): pending scheduled minutes whose
    # session ENDS on or before the task's due date. Skipped/completed/
    # partial rows and calendar-only entries never count — only status
    # 'scheduled' with a task_id, matching pending semantics above.
    pending_rows = conn.execute(
        """
        SELECT task_id, planned_end,
               CAST(ROUND((julianday(planned_end) - julianday(planned_start)) * 1440) AS INTEGER) AS minutes
        FROM task_sessions
        WHERE status = 'scheduled' AND task_id IS NOT NULL
        """
    ).fetchall()
    pending_by_task: dict = {}
    for r in pending_rows:
        pending_by_task.setdefault(r["task_id"], []).append((r["planned_end"], r["minutes"] or 0))
    ctx_rows = conn.execute("SELECT id, name FROM contexts").fetchall()
    ctx_names = {r["id"]: r["name"] for r in ctx_rows}
    for t in tasks:
        logged, pending = agg.get(t["id"], (0, 0))
        t["logged_minutes"] = logged
        t["scheduled_pending_minutes"] = pending
        est = t.get("estimated_minutes")
        t["remaining_minutes"] = max(0, est - logged) if est else None
        t["remaining_unscheduled_minutes"] = max(0, est - logged - pending) if est else None
        t["context_name"] = ctx_names.get(t.get("context_id"))
        due = t.get("due_date")
        if est and due:
            cutoff = due + "T23:59"
            before = sum(m for (end, m) in pending_by_task.get(t["id"], []) if end <= cutoff)
            t["scheduled_before_due_minutes"] = before
            t["remaining_unscheduled_before_due"] = max(0, est - logged - before)
        else:
            t["scheduled_before_due_minutes"] = None
            t["remaining_unscheduled_before_due"] = None
    return tasks


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
    today = date.today()
    out = _attach_session_rollups(conn, [_enrich_task(dict(r), today) for r in rows])
    conn.close()
    return out


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
    if not row:
        conn.close()
        raise HTTPException(status_code=404, detail="Task not found")
    out = _attach_session_rollups(conn, [_enrich_task(dict(row), date.today())])[0]
    conn.close()
    return out


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
    display_order: Optional[int] = None,
    active_from: Optional[str] = None,
    end_date: Optional[str] = None,
    depth: Optional[int] = None,
    estimated_minutes: Optional[int] = None,
    due_date: Optional[str] = None,
    context_id: Optional[int] = None,
):
    if not 1 <= priority <= 10:
        raise HTTPException(status_code=422, detail="Priority must be between 1 and 10")
    if interval_days < 1:
        raise HTTPException(status_code=422, detail="interval_days must be >= 1")
    depth_val = _normalize_depth(depth)
    estimate_val = _normalize_estimate(estimated_minutes)
    due_val = _normalize_date_override(due_date)
    context_val = context_id if context_id else None

    norm_status = _normalize_status(status)
    is_paused_val = 1 if norm_status == 'hiatus' else 0
    paused_at_val = datetime.now().isoformat() if is_paused_val else None
    conn = get_connection()
    today_str = date.today().isoformat()
    # Append at the end by default (P12.1). The old default of 0 sorted every
    # new task to the front of the global list, which also yanked its section
    # to the top of the grid (section order was derived from task encounter
    # order). New records must never rearrange what the user already placed.
    if display_order is None:
        display_order = conn.execute(
            "SELECT COALESCE(MAX(display_order), -1) + 1 FROM tasks WHERE is_active = 1"
        ).fetchone()[0]
    active_from_val = _normalize_date_override(active_from) or today_str
    manual_override_val = _normalize_date_override(manual_last_done_override)
    end_date_val = _normalize_date_override(end_date)
    if context_val is not None and not conn.execute(
            "SELECT id FROM contexts WHERE id = ?", (context_val,)).fetchone():
        conn.close()
        raise HTTPException(status_code=404, detail="Context not found")
    with conn:
        cursor = conn.execute(
            """
            INSERT INTO tasks (
                name, section, category, subtask, priority, interval_days,
                status, notes, created_at, is_active, is_paused, paused_at,
                manual_last_done_override, display_order, active_from, end_date,
                depth, estimated_minutes, due_date, context_id
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                name, section, category, subtask, priority, interval_days,
                norm_status, notes, today_str, is_paused_val, paused_at_val,
                manual_override_val, display_order, active_from_val, end_date_val,
                depth_val, estimate_val, due_val, context_val,
            ),
        )
        task_id = cursor.lastrowid
        _ensure_section_registered(conn, section)
        # A task created directly on hiatus starts an open interval today.
        if norm_status == 'hiatus':
            _open_hiatus_period(conn, task_id, today_str)

    row = conn.execute(
        "SELECT t.*, NULL AS latest_completion FROM tasks t WHERE t.id = ?",
        (task_id,),
    ).fetchone()
    out = _attach_session_rollups(conn, [_enrich_task(dict(row), date.today())])[0]
    conn.close()
    return out


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
    depth: Optional[int] = None
    estimated_minutes: Optional[int] = None
    due_date: Optional[str] = None
    context_id: Optional[int] = None


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
    depth: Optional[int] = None,
    estimated_minutes: Optional[int] = None,
    due_date: Optional[str] = None,
    context_id: Optional[int] = None,
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
        if depth is None and "depth" in bset:
            # null in JSON means "clear depth" — 0 is the clear sentinel.
            depth = body.depth if body.depth is not None else 0
        if estimated_minutes is None and "estimated_minutes" in bset:
            estimated_minutes = body.estimated_minutes if body.estimated_minutes is not None else 0
        if due_date is None and "due_date" in bset:
            due_date = body.due_date if body.due_date is not None else ""
        if context_id is None and "context_id" in bset:
            context_id = body.context_id if body.context_id is not None else 0

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
    try:
        depth_val = _normalize_depth(depth)
        estimate_val = _normalize_estimate(estimated_minutes)
    except HTTPException:
        conn.close()
        raise

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
    if depth is not None:
        updates["depth"] = depth_val
    if estimated_minutes is not None:
        updates["estimated_minutes"] = estimate_val
    if due_date is not None:
        updates["due_date"] = _normalize_date_override(due_date)
    if context_id is not None:
        # 0 clears; otherwise the context must exist.
        if context_id == 0:
            updates["context_id"] = None
        else:
            ctx = conn.execute("SELECT id FROM contexts WHERE id = ?", (context_id,)).fetchone()
            if not ctx:
                conn.close()
                raise HTTPException(status_code=404, detail="Context not found")
            updates["context_id"] = context_id

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
            if "section" in updates:
                _ensure_section_registered(conn, updates["section"])
            # When a non-null end_date is set, delete completions after it.
            # Completions on end_date are preserved (completion_date > end_date_val).
            if end_date is not None and end_date_val is not None:
                conn.execute(
                    "DELETE FROM completions WHERE task_id = ? AND completion_date > ?",
                    (task_id, end_date_val),
                )
                # Finished semantics for calendar recurrence: generation
                # already stops past end_date; also drop still-scheduled,
                # never-executed generated occurrences beyond it. Executed
                # history (completed/partial/skipped, any actuals) stays.
                conn.execute(
                    "DELETE FROM task_sessions WHERE task_id = ? AND series_id IS NOT NULL "
                    "AND occurrence_date > ? AND status = 'scheduled' "
                    "AND actual_start IS NULL AND actual_end IS NULL AND actual_minutes IS NULL",
                    (task_id, end_date_val),
                )
            # Hiatus interval bookkeeping (P11.0) — only on an actual status
            # transition, so re-saving a task without changing status never
            # re-creates a deliberately deleted interval.
            if "status" in updates and updates["status"] != existing["status"]:
                today_iso = date.today().isoformat()
                if updates["status"] == 'hiatus':
                    _open_hiatus_period(conn, task_id, today_iso)
                else:
                    _close_hiatus_period(conn, task_id, today_iso)

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
    out = _attach_session_rollups(conn, [_enrich_task(dict(row), date.today())])[0]
    conn.close()
    return out


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


class SectionAssignment(BaseModel):
    id: int
    section: str


class ReorderBody(BaseModel):
    order: list[int]
    # Optional cross-section moves (P12.1) applied in the SAME transaction as
    # the ordering write, so a drag that changes both a task's section and its
    # position never persists a half-applied state.
    section_updates: Optional[list[SectionAssignment]] = None


@app.post("/tasks/reorder", status_code=200)
def reorder_tasks(body: ReorderBody):
    """Set display_order for tasks in bulk, optionally with section moves.

    Accepts an ordered list of task IDs.  Each task's display_order is set to
    its index in the list (0-based).  Tasks not included in the list are
    unchanged.  section_updates entries reassign a task's section atomically
    with the reorder (used by cross-section drag and drop).
    """
    if not body.order and not body.section_updates:
        return {"reordered": 0}
    conn = get_connection()
    with conn:
        for su in body.section_updates or []:
            conn.execute(
                "UPDATE tasks SET section = ? WHERE id = ? AND is_active = 1",
                (su.section.strip(), su.id),
            )
            _ensure_section_registered(conn, su.section)
        for i, task_id in enumerate(body.order):
            conn.execute(
                "UPDATE tasks SET display_order = ? WHERE id = ? AND is_active = 1",
                (i, task_id),
            )
    conn.close()
    return {"reordered": len(body.order)}


# ---------------------------------------------------------------------------
# Sections (P12.1) — persisted manual section ordering
#
# Sections themselves are still strings on tasks (no section entity/foreign
# key — additive change only). The section_order table records the user's
# manual arrangement; it is the single authority for section display order.
# Task mutations (create/complete/reorder/move) never touch it, so ordinary
# actions can no longer make sections appear to move.
# ---------------------------------------------------------------------------


def _ensure_section_registered(conn, raw_name: Optional[str]) -> None:
    """Give a section an ordering row the moment it first appears on a task
    (create / edit / cross-section move), appended at the end. Eager
    registration means a section keeps its place even if it is emptied before
    any /sections read happens; _sync_section_order remains as self-heal for
    pre-P12.1 data."""
    name = (raw_name or "").strip()
    if conn.execute("SELECT id FROM section_order WHERE name = ?", (name,)).fetchone():
        return
    next_pos = conn.execute(
        "SELECT COALESCE(MAX(position), -1) + 1 FROM section_order"
    ).fetchone()[0]
    now = datetime.now().isoformat()
    conn.execute(
        "INSERT INTO section_order (name, position, created_at, updated_at) "
        "VALUES (?, ?, ?, ?)",
        (name, next_pos, now, now),
    )


def _sync_section_order(conn) -> list[dict]:
    """Self-healing read: every section present on an active task gets an
    ordering row (appended at the end, encounter order). Existing rows are
    never repositioned or pruned here — empty sections stay listed so they
    remain valid drop targets across reloads."""
    rows = conn.execute(
        "SELECT * FROM section_order ORDER BY position, id"
    ).fetchall()
    known = {r["name"] for r in rows}
    next_pos = max((r["position"] for r in rows), default=-1) + 1
    task_rows = conn.execute(
        "SELECT section FROM tasks WHERE is_active = 1 ORDER BY display_order, id"
    ).fetchall()
    now = datetime.now().isoformat()
    added = False
    for tr in task_rows:
        name = (tr["section"] or "").strip()
        if name in known:
            continue
        known.add(name)
        conn.execute(
            "INSERT INTO section_order (name, position, created_at, updated_at) "
            "VALUES (?, ?, ?, ?)",
            (name, next_pos, now, now),
        )
        next_pos += 1
        added = True
    if added:
        conn.commit()
        rows = conn.execute(
            "SELECT * FROM section_order ORDER BY position, id"
        ).fetchall()
    return [dict(r) for r in rows]


class SectionReorderBody(BaseModel):
    order: list[str]


class SectionRenameBody(BaseModel):
    old: str
    new: str


@app.get("/sections")
def list_sections():
    """Ordered section list. name '' is the blank/'(no section)' group."""
    conn = get_connection()
    out = _sync_section_order(conn)
    conn.close()
    return out


@app.post("/sections/reorder", status_code=200)
def reorder_sections(body: SectionReorderBody):
    """Persist a manual section arrangement.

    Listed names get positions 0..n-1 in the given order. Names not listed
    (e.g. hidden by an active filter when the drag happened) keep their
    previous relative order after the listed ones. Unknown names are ignored.
    """
    conn = get_connection()
    rows = conn.execute("SELECT * FROM section_order ORDER BY position, id").fetchall()
    by_name = {r["name"]: r for r in rows}
    now = datetime.now().isoformat()
    listed = []
    seen = set()
    for raw in body.order:
        name = raw.strip()
        if name in by_name and name not in seen:
            seen.add(name)
            listed.append(by_name[name])
    trailing = [r for r in rows if r["name"] not in seen]
    with conn:
        for pos, r in enumerate(listed + trailing):
            conn.execute(
                "UPDATE section_order SET position = ?, updated_at = ? WHERE id = ?",
                (pos, now, r["id"]),
            )
    out = conn.execute("SELECT * FROM section_order ORDER BY position, id").fetchall()
    conn.close()
    return [dict(r) for r in out]


@app.post("/sections/rename", status_code=200)
def rename_section(body: SectionRenameBody):
    """Rename a section everywhere: ordering row + every task carrying it.

    The section keeps its id and position — a renamed section is the same
    section in the same place. Renaming onto an existing section is rejected
    (merging is a separate, deliberate operation)."""
    old = body.old.strip()
    new = body.new.strip()
    if not new:
        raise HTTPException(status_code=422, detail="New section name must not be blank")
    conn = get_connection()
    row = conn.execute("SELECT * FROM section_order WHERE name = ?", (old,)).fetchone()
    if not row:
        conn.close()
        raise HTTPException(status_code=404, detail="Section not found")
    if new == old:
        conn.close()
        return dict(row)
    if conn.execute("SELECT id FROM section_order WHERE name = ?", (new,)).fetchone():
        conn.close()
        raise HTTPException(status_code=409, detail="A section with that name already exists")
    now = datetime.now().isoformat()
    with conn:
        conn.execute(
            "UPDATE section_order SET name = ?, updated_at = ? WHERE id = ?",
            (new, now, row["id"]),
        )
        conn.execute("UPDATE tasks SET section = ? WHERE TRIM(section) = ?", (new, old))
    updated = conn.execute("SELECT * FROM section_order WHERE id = ?", (row["id"],)).fetchone()
    conn.close()
    return dict(updated)


@app.delete("/sections")
def delete_section_order(name: str):
    """Drop an EMPTY section from the ordering list (name via query param so
    names containing '/' work). Sections still referenced by an active task
    are refused — removing a populated section is not a thing; move or delete
    its tasks first."""
    key = name.strip()
    conn = get_connection()
    row = conn.execute("SELECT * FROM section_order WHERE name = ?", (key,)).fetchone()
    if not row:
        conn.close()
        raise HTTPException(status_code=404, detail="Section not found")
    in_use = conn.execute(
        "SELECT id FROM tasks WHERE TRIM(section) = ? AND is_active = 1 LIMIT 1", (key,)
    ).fetchone()
    if in_use:
        conn.close()
        raise HTTPException(status_code=409, detail="Section still has tasks")
    with conn:
        conn.execute("DELETE FROM section_order WHERE id = ?", (row["id"],))
    conn.close()
    return {"deleted": key}


# ---------------------------------------------------------------------------
# Task hiatus periods (P11.0) — persisted intervals behind DateCell blanking
# ---------------------------------------------------------------------------

class HiatusPeriodBody(BaseModel):
    task_id: int
    start_date: str
    end_date: Optional[str] = None


class HiatusPeriodPatch(BaseModel):
    start_date: Optional[str] = None
    end_date: Optional[str] = None


def _find_overlapping_period(conn, task_id: int, start_iso: str,
                             end_iso: Optional[str], exclude_id: Optional[int] = None):
    """First interval of task_id overlapping [start_iso, end_iso] (inclusive).

    end_iso None means unbounded (open interval), which overlaps everything at
    or after start_iso. Rows with NULL end_date are likewise treated as
    unbounded. Used by the correction endpoints (POST/PATCH) — the internal
    status-transition helpers stay validation-free.
    """
    query = ("SELECT id FROM task_hiatus_periods WHERE task_id = ? "
             "AND (end_date IS NULL OR end_date >= ?)")
    params: list = [task_id, start_iso]
    if end_iso is not None:
        query += " AND start_date <= ?"
        params.append(end_iso)
    if exclude_id is not None:
        query += " AND id != ?"
        params.append(exclude_id)
    return conn.execute(query + " LIMIT 1", params).fetchone()


@app.get("/task-hiatus-periods")
def list_task_hiatus_periods(
    task_id: Optional[int] = None,
    start: Optional[str] = None,
    end: Optional[str] = None,
):
    """List hiatus intervals for one task and/or overlapping a date range.

    Range overlap: start_date <= end AND (end_date IS NULL OR end_date >= start)
    — an open interval overlaps every range at or after its start.
    """
    if task_id is None and not (start and end):
        raise HTTPException(status_code=422, detail="Provide task_id or start+end")
    query = "SELECT * FROM task_hiatus_periods WHERE 1=1"
    params: list = []
    if task_id is not None:
        query += " AND task_id = ?"
        params.append(task_id)
    if start and end:
        _validate_iso_date(start, "start")
        _validate_iso_date(end, "end")
        query += " AND start_date <= ? AND (end_date IS NULL OR end_date >= ?)"
        params.extend([end, start])
    query += " ORDER BY task_id, start_date"
    conn = get_connection()
    rows = conn.execute(query, params).fetchall()
    conn.close()
    return [dict(r) for r in rows]


@app.post("/task-hiatus-periods", status_code=201)
def create_task_hiatus_period(body: HiatusPeriodBody):
    """Create an interval directly (normally intervals are created by status
    transitions; this exists for corrections). Open intervals stay unique."""
    _validate_iso_date(body.start_date, "start_date")
    if body.end_date is not None:
        _validate_iso_date(body.end_date, "end_date")
        if body.end_date < body.start_date:
            raise HTTPException(status_code=422, detail="end_date must not be before start_date")
    conn = get_connection()
    if not conn.execute("SELECT id FROM tasks WHERE id = ?", (body.task_id,)).fetchone():
        conn.close()
        raise HTTPException(status_code=404, detail="Task not found")
    if body.end_date is None:
        open_row = conn.execute(
            "SELECT id FROM task_hiatus_periods WHERE task_id = ? AND end_date IS NULL",
            (body.task_id,),
        ).fetchone()
        if open_row:
            conn.close()
            raise HTTPException(status_code=409, detail="Task already has an open hiatus interval")
    if _find_overlapping_period(conn, body.task_id, body.start_date, body.end_date):
        conn.close()
        raise HTTPException(status_code=409, detail="This overlaps another hiatus interval.")
    now = datetime.now().isoformat()
    with conn:
        cur = conn.execute(
            "INSERT INTO task_hiatus_periods (task_id, start_date, end_date, created_at, updated_at) "
            "VALUES (?, ?, ?, ?, ?)",
            (body.task_id, body.start_date, body.end_date, now, now),
        )
        period_id = cur.lastrowid
    row = conn.execute("SELECT * FROM task_hiatus_periods WHERE id = ?", (period_id,)).fetchone()
    conn.close()
    return dict(row)


@app.patch("/task-hiatus-periods/{period_id}")
def update_task_hiatus_period(period_id: int, body: HiatusPeriodPatch):
    """Adjust interval dates (correction flow). end_date='' clears it back to
    open — rejected if the task already has a different open interval."""
    conn = get_connection()
    row = conn.execute("SELECT * FROM task_hiatus_periods WHERE id = ?", (period_id,)).fetchone()
    if not row:
        conn.close()
        raise HTTPException(status_code=404, detail="Hiatus period not found")
    period = dict(row)

    new_start = period["start_date"]
    new_end = period["end_date"]
    if body.start_date is not None:
        _validate_iso_date(body.start_date, "start_date")
        new_start = body.start_date
    if body.end_date is not None:
        if body.end_date == "":
            new_end = None
        else:
            _validate_iso_date(body.end_date, "end_date")
            new_end = body.end_date
    if new_end is not None and new_end < new_start:
        conn.close()
        raise HTTPException(status_code=422, detail="end_date must not be before start_date")
    if new_end is None and period["end_date"] is not None:
        open_row = conn.execute(
            "SELECT id FROM task_hiatus_periods WHERE task_id = ? AND end_date IS NULL AND id != ?",
            (period["task_id"], period_id),
        ).fetchone()
        if open_row:
            conn.close()
            raise HTTPException(status_code=409, detail="Task already has an open hiatus interval")
    if _find_overlapping_period(conn, period["task_id"], new_start, new_end, exclude_id=period_id):
        conn.close()
        raise HTTPException(status_code=409, detail="This overlaps another hiatus interval.")

    with conn:
        conn.execute(
            "UPDATE task_hiatus_periods SET start_date = ?, end_date = ?, updated_at = ? WHERE id = ?",
            (new_start, new_end, datetime.now().isoformat(), period_id),
        )
    updated = conn.execute("SELECT * FROM task_hiatus_periods WHERE id = ?", (period_id,)).fetchone()
    conn.close()
    return dict(updated)


@app.delete("/task-hiatus-periods/{period_id}")
def delete_task_hiatus_period(period_id: int):
    """Remove a mistaken interval. Never touches completions or overrides."""
    conn = get_connection()
    row = conn.execute("SELECT id FROM task_hiatus_periods WHERE id = ?", (period_id,)).fetchone()
    if not row:
        conn.close()
        raise HTTPException(status_code=404, detail="Hiatus period not found")
    with conn:
        conn.execute("DELETE FROM task_hiatus_periods WHERE id = ?", (period_id,))
    conn.close()
    return {"deleted": period_id}


# ---------------------------------------------------------------------------
# Calendar (P12.0) — task sessions + depth windows
#
# Sessions are scheduled allocations of time toward a task ("one record,
# multiple views"): the Calendar renders sessions, but the task itself stays
# the single canonical record. Session completion is distinct from task
# completion — completing a session never writes the completions table here;
# the frontend pairs a session status change with the existing completion
# endpoints so the grid's completion_count semantics stay untouched.
#
# Times are local-naive "YYYY-MM-DDTHH:MM" strings (no timezone — this is a
# strictly local, single-machine app), so SQLite range filtering is plain
# lexicographic comparison.
# ---------------------------------------------------------------------------

_SESSION_STATUSES = frozenset({"scheduled", "completed", "partial", "skipped"})


def _validate_planned_time(value: str, field: str) -> str:
    """Validate and normalize a planned time to 'YYYY-MM-DDTHH:MM'."""
    try:
        return datetime.fromisoformat(value).strftime("%Y-%m-%dT%H:%M")
    except (ValueError, TypeError):
        raise HTTPException(
            status_code=422,
            detail=f"{field} must be an ISO datetime (YYYY-MM-DDTHH:MM)",
        )


def _session_minutes(start_iso: str, end_iso: str) -> int:
    delta = datetime.fromisoformat(end_iso) - datetime.fromisoformat(start_iso)
    return int(delta.total_seconds() // 60)


# Calendar-only entries (P14.0): task_id NULL means the row is a lightweight
# calendar entry, not a task session. Display fields resolve from the task
# when linked and from the row itself when not — task_name/task_depth are
# therefore safe for every consumer regardless of linkage.
_SESSION_SELECT = """
    SELECT s.*,
           CASE WHEN s.task_id IS NULL THEN s.title ELSE t.name END AS task_name,
           CASE WHEN s.task_id IS NULL THEN s.depth ELSE t.depth END AS task_depth,
           CASE WHEN s.task_id IS NULL THEN cs.name ELSE ct.name END AS context_name,
           t.section           AS task_section,
           t.category          AS task_category,
           t.priority          AS task_priority,
           t.estimated_minutes AS task_estimated_minutes,
           t.status            AS task_status,
           t.is_paused         AS task_is_paused
    FROM task_sessions s
    LEFT JOIN tasks t ON t.id = s.task_id
    LEFT JOIN contexts cs ON cs.id = s.context_id
    LEFT JOIN contexts ct ON ct.id = t.context_id
    WHERE (s.task_id IS NULL OR t.is_active = 1)
"""


def _session_dict(row) -> dict:
    s = dict(row)
    s["planned_minutes"] = _session_minutes(s["planned_start"], s["planned_end"])
    return s


class SessionBody(BaseModel):
    # Either task_id (session for a canonical task) or title (calendar-only
    # entry, P14.0). Depth and context apply to unlinked entries only —
    # linked sessions take both from their task.
    task_id: Optional[int] = None
    title: Optional[str] = None
    depth: Optional[int] = None
    context_id: Optional[int] = None
    planned_start: str
    planned_end: str
    is_fixed: bool = False


class SessionPatch(BaseModel):
    planned_start: Optional[str] = None
    planned_end: Optional[str] = None
    status: Optional[str] = None
    is_fixed: Optional[bool] = None
    actual_start: Optional[str] = None
    actual_end: Optional[str] = None
    actual_minutes: Optional[int] = None
    # Calendar-only entries (P14.0): title/depth/context edits, and the
    # one-way promotion that links an entry to a canonical task.
    # context_id 0 clears the association (V5.0 — mirrors TaskPatch).
    title: Optional[str] = None
    depth: Optional[int] = None
    context_id: Optional[int] = None
    link_task_id: Optional[int] = None


@app.get("/sessions")
def list_sessions(
    start: Optional[str] = None,
    end: Optional[str] = None,
    task_id: Optional[int] = None,
):
    """List sessions overlapping [start, end] (ISO dates) and/or for one task.

    Sessions on soft-deleted tasks are excluded — the JOIN keeps the calendar
    consistent with the grid without hard-deleting session history.
    """
    if task_id is None and not (start and end):
        raise HTTPException(status_code=422, detail="Provide task_id or start+end")
    query = _SESSION_SELECT
    params: list = []
    if task_id is not None:
        query += " AND s.task_id = ?"
        params.append(task_id)
    if start and end:
        _validate_iso_date(start, "start")
        _validate_iso_date(end, "end")
        query += " AND s.planned_start <= ? AND s.planned_end >= ?"
        params.extend([end + "T23:59", start + "T00:00"])
    query += " ORDER BY s.planned_start, s.id"
    conn = get_connection()
    if start and end:
        # Lazy, bounded recurrence materialization: occurrences due inside
        # the requested window (plus series-start→today, for reconciliation)
        # become real rows before the read. Duplicate-proof by construction —
        # slot identity is (series_id, occurrence_date).
        recurrence_engine.materialize_window(
            conn, date.fromisoformat(start), date.fromisoformat(end), date.today())
    rows = conn.execute(query, params).fetchall()
    conn.close()
    return [_session_dict(r) for r in rows]


@app.post("/sessions", status_code=201)
def create_session(body: SessionBody):
    """Create a task session (task_id) or a calendar-only entry (title).

    Calendar creation is entry-first (P14.0): nothing here ever creates a
    canonical task — promotion to the Grid is a separate, explicit step.
    """
    start_iso = _validate_planned_time(body.planned_start, "planned_start")
    end_iso = _validate_planned_time(body.planned_end, "planned_end")
    if end_iso <= start_iso:
        raise HTTPException(status_code=422, detail="planned_end must be after planned_start")

    title = (body.title or "").strip()
    depth_val = None
    context_val = None
    if body.task_id is None:
        if not title:
            raise HTTPException(
                status_code=422,
                detail="Provide task_id (task session) or a non-empty title (calendar entry)",
            )
        depth_val = _normalize_depth(body.depth)
        context_val = body.context_id or None
    else:
        title = ""  # linked sessions take name/depth/context from the task

    conn = get_connection()
    if body.task_id is not None:
        task = conn.execute(
            "SELECT id FROM tasks WHERE id = ? AND is_active = 1", (body.task_id,)
        ).fetchone()
        if not task:
            conn.close()
            raise HTTPException(status_code=404, detail="Task not found")
    if context_val is not None and not conn.execute(
        "SELECT id FROM contexts WHERE id = ?", (context_val,)
    ).fetchone():
        conn.close()
        raise HTTPException(status_code=404, detail="Context not found")
    now = datetime.now().isoformat()
    with conn:
        cur = conn.execute(
            "INSERT INTO task_sessions (task_id, title, depth, context_id, planned_start, planned_end, is_fixed, created_at, updated_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (body.task_id, title, depth_val, context_val, start_iso, end_iso, int(body.is_fixed), now, now),
        )
        session_id = cur.lastrowid
    row = conn.execute(_SESSION_SELECT + " AND s.id = ?", (session_id,)).fetchone()
    conn.close()
    return _session_dict(row)


@app.patch("/sessions/{session_id}")
def update_session(session_id: int, body: SessionPatch):
    """Update a session. Rescheduling edits planned_*; reconciliation edits
    status/actual_*. Planned history is never rewritten implicitly — only an
    explicit planned_start/planned_end in the request changes it."""
    conn = get_connection()
    row = conn.execute("SELECT * FROM task_sessions WHERE id = ?", (session_id,)).fetchone()
    if not row:
        conn.close()
        raise HTTPException(status_code=404, detail="Session not found")
    session = dict(row)

    updates: dict = {}
    try:
        new_start = session["planned_start"]
        new_end = session["planned_end"]
        if body.planned_start is not None:
            new_start = _validate_planned_time(body.planned_start, "planned_start")
            updates["planned_start"] = new_start
        if body.planned_end is not None:
            new_end = _validate_planned_time(body.planned_end, "planned_end")
            updates["planned_end"] = new_end
        if new_end <= new_start:
            raise HTTPException(status_code=422, detail="planned_end must be after planned_start")
        if body.status is not None:
            if body.status not in _SESSION_STATUSES:
                raise HTTPException(
                    status_code=422,
                    detail="status must be scheduled, completed, partial, or skipped",
                )
            updates["status"] = body.status
        if body.is_fixed is not None:
            updates["is_fixed"] = int(body.is_fixed)
        # actual_* accept '' to clear back to NULL (mirrors end_date handling).
        if body.actual_start is not None:
            updates["actual_start"] = (
                _validate_planned_time(body.actual_start, "actual_start")
                if body.actual_start else None
            )
        if body.actual_end is not None:
            updates["actual_end"] = (
                _validate_planned_time(body.actual_end, "actual_end")
                if body.actual_end else None
            )
        if body.actual_minutes is not None:
            if body.actual_minutes < 0:
                raise HTTPException(status_code=422, detail="actual_minutes must be >= 0")
            updates["actual_minutes"] = body.actual_minutes or None
        # Promotion (P14.0): link a calendar-only entry to a canonical task.
        # One-way and exclusive — the task then provides name, depth, and
        # context, so the entry's own copies are cleared rather than left to
        # drift.
        if body.link_task_id is not None:
            if session["task_id"] is not None:
                raise HTTPException(status_code=409, detail="Session is already linked to a task")
            task = conn.execute(
                "SELECT id FROM tasks WHERE id = ? AND is_active = 1", (body.link_task_id,)
            ).fetchone()
            if not task:
                raise HTTPException(status_code=404, detail="Task not found")
            updates["task_id"] = body.link_task_id
            updates["title"] = ""
            updates["depth"] = None
            updates["context_id"] = None
        else:
            if body.title is not None:
                if session["task_id"] is not None:
                    raise HTTPException(
                        status_code=422, detail="Linked sessions take their name from the task")
                if not body.title.strip():
                    raise HTTPException(status_code=422, detail="title must not be blank")
                updates["title"] = body.title.strip()
            if body.depth is not None:
                if session["task_id"] is not None:
                    raise HTTPException(
                        status_code=422, detail="Linked sessions take depth from the task")
                updates["depth"] = _normalize_depth(body.depth)
            # Context is relational metadata only (V5.0 §2) — assigning or
            # clearing it must leave schedule, depth, status, and linkage
            # untouched, which this achieves by updating nothing else.
            if body.context_id is not None:
                if session["task_id"] is not None:
                    raise HTTPException(
                        status_code=422, detail="Linked sessions take context from the task")
                if body.context_id == 0:
                    updates["context_id"] = None
                else:
                    if not conn.execute(
                        "SELECT id FROM contexts WHERE id = ?", (body.context_id,)
                    ).fetchone():
                        raise HTTPException(status_code=404, detail="Context not found")
                    updates["context_id"] = body.context_id
    except HTTPException:
        conn.close()
        raise

    # Moving/resizing one recurring occurrence is a recurrence exception:
    # the row detaches (series-level edits leave it alone) but keeps its
    # slot identity, so the series never regenerates that date. Completion/
    # actual/status changes do NOT detach — reconciling an occurrence is
    # execution, not a schedule exception.
    if session.get("series_id") is not None and (
        "planned_start" in updates or "planned_end" in updates
    ):
        updates["series_detached"] = 1

    if updates:
        updates["updated_at"] = datetime.now().isoformat()
        set_clause = ", ".join(f"{col} = ?" for col in updates)
        with conn:
            conn.execute(
                f"UPDATE task_sessions SET {set_clause} WHERE id = ?",
                list(updates.values()) + [session_id],
            )
    updated = conn.execute(_SESSION_SELECT + " AND s.id = ?", (session_id,)).fetchone()
    conn.close()
    if not updated:
        # Task went inactive between the existence check and the re-read.
        raise HTTPException(status_code=404, detail="Session not found")
    return _session_dict(updated)


@app.delete("/sessions/{session_id}")
def delete_session(session_id: int, scope: str = "occurrence"):
    """Remove a session. The underlying task and its completions are untouched.

    For a recurring occurrence, scope selects how much of the series goes:
      occurrence — delete just this row and record a recurrence skip so the
                   slot never regenerates (default; also the plain one-off
                   path, where the skip is simply not needed)
      following  — end the series the day before this occurrence and remove
                   its still-scheduled future rows
      all        — remove the whole series and every never-executed row
    Executed truth (completed/partial/skipped rows, anything with actual
    data) is never deleted by 'following'/'all'.
    """
    if scope not in ("occurrence", "following", "all"):
        raise HTTPException(status_code=422, detail="scope must be occurrence, following, or all")
    conn = get_connection()
    row = conn.execute("SELECT * FROM task_sessions WHERE id = ?", (session_id,)).fetchone()
    if not row:
        conn.close()
        raise HTTPException(status_code=404, detail="Session not found")
    session = dict(row)
    series_id = session.get("series_id")
    if scope != "occurrence" and series_id is None:
        conn.close()
        raise HTTPException(status_code=422, detail="Session is not part of a recurrence series")

    occ_date = session.get("occurrence_date") or session["planned_start"][:10]
    now = datetime.now().isoformat()
    with conn:
        if scope == "occurrence":
            if series_id is not None:
                conn.execute(
                    "INSERT OR IGNORE INTO recurrence_skips (series_id, date, created_at) "
                    "VALUES (?, ?, ?)",
                    (series_id, occ_date, now),
                )
            conn.execute("DELETE FROM task_sessions WHERE id = ?", (session_id,))
        elif scope == "following":
            new_until = (date.fromisoformat(occ_date) - timedelta(days=1)).isoformat()
            conn.execute(
                "UPDATE recurrence_series SET until_date = ?, updated_at = ? WHERE id = ?",
                (new_until, now, series_id),
            )
            recurrence_engine.prune_unexecuted(conn, series_id, occ_date, include_detached=True)
        else:  # all
            recurrence_engine.prune_unexecuted(conn, series_id, "0000-01-01", include_detached=True)
            # History rows keep existing via ON DELETE SET NULL; skips cascade.
            conn.execute("DELETE FROM recurrence_series WHERE id = ?", (series_id,))
    conn.close()
    return {"deleted": session_id, "scope": scope}


# ---------------------------------------------------------------------------
# Calendar recurrence series
#
# A series is a local recurring SCHEDULE ("every Tuesday 3–4 PM") for either
# sessions of one canonical task or a calendar-only entry. This is scheduling
# recurrence — deliberately distinct from the Grid's tasks.interval_days
# pressure recurrence, and never offered for external ICS commitments (their
# recurrence belongs to the source calendar).
#
# Occurrences are ordinary task_sessions rows materialized lazily by
# GET /sessions (see recurrence.materialize_window). Every occurrence stays
# individually executable — complete/partial/skip/move/reconcile touch only
# that row.
# ---------------------------------------------------------------------------

class SeriesBody(BaseModel):
    # from_session_id adopts an existing block as the series anchor: identity
    # (task/title/depth/context/fixed) and any omitted rule fields come from
    # that session — the one-click "Repeat weekly" path.
    from_session_id: Optional[int] = None
    task_id: Optional[int] = None
    title: Optional[str] = None
    depth: Optional[int] = None
    context_id: Optional[int] = None
    is_fixed: Optional[bool] = None
    weekdays: Optional[list] = None       # 0=Mon…6=Sun
    interval_weeks: int = 1
    start_date: Optional[str] = None
    start_minutes: Optional[int] = None
    duration_minutes: Optional[int] = None
    until_date: Optional[str] = None
    count: Optional[int] = None


class SeriesPatch(BaseModel):
    # scope 'all' edits the rule in place (future planned occurrences follow,
    # history and detached exceptions stay). scope 'following' splits the
    # series at from_date, Google Calendar-style.
    scope: str = "all"
    from_date: Optional[str] = None
    weekdays: Optional[list] = None
    interval_weeks: Optional[int] = None
    start_minutes: Optional[int] = None
    duration_minutes: Optional[int] = None
    until_date: Optional[str] = None      # '' clears (never ends)
    count: Optional[int] = None           # 0 clears
    is_fixed: Optional[bool] = None
    # Entry-series identity edits (linked series take these from the task).
    title: Optional[str] = None
    depth: Optional[int] = None
    context_id: Optional[int] = None


def _series_dict(row) -> dict:
    s = dict(row)
    s["weekdays"] = recurrence_engine.parse_weekdays(s["weekdays"])
    s["label"] = recurrence_engine.describe(s)
    return s


_SERIES_SELECT = """
    SELECT rs.*, t.name AS task_name
    FROM recurrence_series rs
    LEFT JOIN tasks t ON t.id = rs.task_id
    WHERE (rs.task_id IS NULL OR t.is_active = 1)
"""


def _validate_series_rule(weekdays, interval_weeks, start_minutes,
                          duration_minutes, until_date, count) -> None:
    if not weekdays:
        raise HTTPException(status_code=422, detail="weekdays must not be empty")
    for w in weekdays:
        if not isinstance(w, int) or not 0 <= w <= 6:
            raise HTTPException(status_code=422, detail="weekdays must be integers 0 (Mon) … 6 (Sun)")
    if interval_weeks < 1:
        raise HTTPException(status_code=422, detail="interval_weeks must be >= 1")
    if not 0 <= start_minutes < 1440:
        raise HTTPException(status_code=422, detail="start_minutes must be 0…1439")
    if duration_minutes < 1:
        raise HTTPException(status_code=422, detail="duration_minutes must be >= 1")
    if until_date is not None:
        _validate_iso_date(until_date, "until_date")
    if count is not None and count < 1:
        raise HTTPException(status_code=422, detail="count must be >= 1")


@app.get("/recurrence-series")
def list_recurrence_series():
    """All recurrence series (small table; the client joins by series_id)."""
    conn = get_connection()
    rows = conn.execute(_SERIES_SELECT + " ORDER BY rs.id").fetchall()
    conn.close()
    return [_series_dict(r) for r in rows]


@app.post("/recurrence-series", status_code=201)
def create_recurrence_series(body: SeriesBody):
    """Create a recurrence series — never a canonical task (the Grid task
    count is untouched; §1). Occurrences materialize on the next sessions
    fetch."""
    conn = get_connection()
    anchor = None
    if body.from_session_id is not None:
        row = conn.execute(
            "SELECT * FROM task_sessions WHERE id = ?", (body.from_session_id,)
        ).fetchone()
        if not row:
            conn.close()
            raise HTTPException(status_code=404, detail="Session not found")
        anchor = dict(row)
        if anchor["series_id"] is not None:
            conn.close()
            raise HTTPException(status_code=409, detail="Session already belongs to a series")

    # Identity: from the anchor session when adopting, else from the body.
    if anchor is not None:
        task_id = anchor["task_id"]
        title = anchor["title"] or ""
        depth_val = anchor["depth"]
        context_val = anchor["context_id"]
        is_fixed = anchor["is_fixed"] if body.is_fixed is None else int(body.is_fixed)
    else:
        task_id = body.task_id
        title = (body.title or "").strip()
        depth_val = _normalize_depth(body.depth)
        context_val = body.context_id or None
        is_fixed = int(body.is_fixed or False)
        if task_id is not None:
            title, depth_val, context_val = "", None, None
    if task_id is None and not title:
        conn.close()
        raise HTTPException(
            status_code=422,
            detail="Provide task_id (task series) or a non-empty title (entry series)")

    # Rule: omitted fields default from the anchor session's planned block.
    start_date = body.start_date
    start_minutes = body.start_minutes
    duration_minutes = body.duration_minutes
    weekdays = body.weekdays
    if anchor is not None:
        a_start = anchor["planned_start"]
        if start_date is None:
            start_date = a_start[:10]
        if start_minutes is None:
            start_minutes = int(a_start[11:13]) * 60 + int(a_start[14:16])
        if duration_minutes is None:
            duration_minutes = _session_minutes(a_start, anchor["planned_end"])
    if start_date is None or start_minutes is None or duration_minutes is None:
        conn.close()
        raise HTTPException(
            status_code=422,
            detail="start_date, start_minutes and duration_minutes are required without from_session_id")
    _validate_iso_date(start_date, "start_date")
    if weekdays is None:
        weekdays = [date.fromisoformat(start_date).weekday()]
    try:
        _validate_series_rule(weekdays, body.interval_weeks, start_minutes,
                              duration_minutes, body.until_date, body.count)
        if task_id is not None and not conn.execute(
            "SELECT id FROM tasks WHERE id = ? AND is_active = 1", (task_id,)
        ).fetchone():
            raise HTTPException(status_code=404, detail="Task not found")
        if context_val is not None and not conn.execute(
            "SELECT id FROM contexts WHERE id = ?", (context_val,)
        ).fetchone():
            raise HTTPException(status_code=404, detail="Context not found")
    except HTTPException:
        conn.close()
        raise
    weekdays = sorted(set(weekdays))

    now = datetime.now().isoformat()
    with conn:
        cur = conn.execute(
            "INSERT INTO recurrence_series (task_id, title, depth, context_id, is_fixed, "
            "interval_weeks, weekdays, start_date, start_minutes, duration_minutes, "
            "until_date, count, created_at, updated_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (task_id, title, depth_val, context_val, is_fixed,
             body.interval_weeks, json.dumps(weekdays), start_date, start_minutes,
             duration_minutes, body.until_date, body.count, now, now),
        )
        series_id = cur.lastrowid
        if anchor is not None:
            # Adopt the anchor block as its date's occurrence. If its planned
            # times differ from the rule's, it is already an exception.
            occ = anchor["planned_start"][:10]
            exp_start, exp_end = recurrence_engine._planned_strings(
                date.fromisoformat(occ), start_minutes, duration_minutes)
            detached = int(anchor["planned_start"] != exp_start or anchor["planned_end"] != exp_end)
            conn.execute(
                "UPDATE task_sessions SET series_id = ?, occurrence_date = ?, "
                "series_detached = ?, updated_at = ? WHERE id = ?",
                (series_id, occ, detached, now, anchor["id"]),
            )
    row = conn.execute(_SERIES_SELECT + " AND rs.id = ?", (series_id,)).fetchone()
    conn.close()
    return _series_dict(row)


@app.patch("/recurrence-series/{series_id}")
def update_recurrence_series(series_id: int, body: SeriesPatch):
    """Edit a series rule.

    scope='all': the rule changes in place; still-scheduled future
    occurrences are re-planned, while executed history and individually
    moved (detached) occurrences are never rewritten (§43).
    scope='following' (with from_date): the series is split — the existing
    series ends the day before from_date and a new series carries the edited
    rule forward. Prior history keeps its original times (§42).
    """
    if body.scope not in ("all", "following"):
        raise HTTPException(status_code=422, detail="scope must be all or following")
    conn = get_connection()
    row = conn.execute(
        "SELECT * FROM recurrence_series WHERE id = ?", (series_id,)).fetchone()
    if not row:
        conn.close()
        raise HTTPException(status_code=404, detail="Series not found")
    series = dict(row)

    try:
        merged = dict(series)
        merged["weekdays"] = (body.weekdays
                              if body.weekdays is not None
                              else recurrence_engine.parse_weekdays(series["weekdays"]))
        if body.interval_weeks is not None:
            merged["interval_weeks"] = body.interval_weeks
        if body.start_minutes is not None:
            merged["start_minutes"] = body.start_minutes
        if body.duration_minutes is not None:
            merged["duration_minutes"] = body.duration_minutes
        if body.until_date is not None:
            merged["until_date"] = body.until_date or None
        if body.count is not None:
            merged["count"] = body.count or None
        if body.is_fixed is not None:
            merged["is_fixed"] = int(body.is_fixed)
        _validate_series_rule(merged["weekdays"], merged["interval_weeks"],
                              merged["start_minutes"], merged["duration_minutes"],
                              merged["until_date"], merged["count"])
        if series["task_id"] is not None and (
            body.title is not None or body.depth is not None or body.context_id is not None
        ):
            raise HTTPException(
                status_code=422, detail="Linked series take name/depth/context from the task")
        if body.title is not None:
            if not body.title.strip():
                raise HTTPException(status_code=422, detail="title must not be blank")
            merged["title"] = body.title.strip()
        if body.depth is not None:
            merged["depth"] = _normalize_depth(body.depth)
        if body.context_id is not None:
            if body.context_id == 0:
                merged["context_id"] = None
            else:
                if not conn.execute(
                    "SELECT id FROM contexts WHERE id = ?", (body.context_id,)
                ).fetchone():
                    raise HTTPException(status_code=404, detail="Context not found")
                merged["context_id"] = body.context_id
        if body.scope == "following":
            if not body.from_date:
                raise HTTPException(status_code=422, detail="from_date is required for scope=following")
            _validate_iso_date(body.from_date, "from_date")
    except HTTPException:
        conn.close()
        raise
    merged["weekdays"] = sorted(set(merged["weekdays"]))

    now = datetime.now().isoformat()
    if body.scope == "all":
        with conn:
            conn.execute(
                "UPDATE recurrence_series SET weekdays = ?, interval_weeks = ?, "
                "start_minutes = ?, duration_minutes = ?, until_date = ?, count = ?, "
                "is_fixed = ?, title = ?, depth = ?, context_id = ?, updated_at = ? "
                "WHERE id = ?",
                (json.dumps(merged["weekdays"]), merged["interval_weeks"],
                 merged["start_minutes"], merged["duration_minutes"],
                 merged["until_date"], merged["count"], merged["is_fixed"],
                 merged["title"], merged["depth"], merged["context_id"], now, series_id),
            )
            # Re-plan the future under the new rule: today onward, scheduled,
            # never-executed, not individually moved. Next fetch regenerates.
            today_iso = date.today().isoformat()
            recurrence_engine.prune_unexecuted(conn, series_id, today_iso)
            if merged["until_date"]:
                # A shortened end also removes moved-but-unexecuted plans
                # beyond the series' new end.
                after_end = (date.fromisoformat(merged["until_date"]) + timedelta(days=1)).isoformat()
                recurrence_engine.prune_unexecuted(conn, series_id, after_end, include_detached=True)
        out = conn.execute(_SERIES_SELECT + " AND rs.id = ?", (series_id,)).fetchone()
        conn.close()
        return _series_dict(out)

    # scope == "following": split at from_date.
    split = body.from_date
    prev_until = (date.fromisoformat(split) - timedelta(days=1)).isoformat()
    old_until = series["until_date"]
    truncated_until = min(old_until, prev_until) if old_until else prev_until
    new_count = None
    if body.count is not None:
        new_count = merged["count"]  # explicit override (0 cleared to None)
    elif series["count"]:
        consumed = len(recurrence_engine.occurrence_dates(
            series, date.fromisoformat(series["start_date"]),
            date.fromisoformat(prev_until)))
        new_count = max(0, int(series["count"]) - consumed)
    with conn:
        conn.execute(
            "UPDATE recurrence_series SET until_date = ?, updated_at = ? WHERE id = ?",
            (truncated_until, now, series_id),
        )
        new_series_id = None
        if new_count is None or new_count > 0:
            cur = conn.execute(
                "INSERT INTO recurrence_series (task_id, title, depth, context_id, is_fixed, "
                "interval_weeks, weekdays, start_date, start_minutes, duration_minutes, "
                "until_date, count, created_at, updated_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (series["task_id"], merged["title"], merged["depth"], merged["context_id"],
                 merged["is_fixed"], merged["interval_weeks"], json.dumps(merged["weekdays"]),
                 split, merged["start_minutes"], merged["duration_minutes"],
                 merged["until_date"] if body.until_date is not None else old_until,
                 new_count, now, now),
            )
            new_series_id = cur.lastrowid
            # Skips and moved-but-unexecuted exceptions from the split point
            # onward carry over to the new series; executed history stays
            # with the old one, untouched.
            conn.execute(
                "UPDATE recurrence_skips SET series_id = ? WHERE series_id = ? AND date >= ?",
                (new_series_id, series_id, split),
            )
            conn.execute(
                "UPDATE task_sessions SET series_id = ? WHERE series_id = ? "
                "AND occurrence_date >= ? AND series_detached = 1 AND status = 'scheduled' "
                "AND actual_start IS NULL AND actual_end IS NULL AND actual_minutes IS NULL",
                (new_series_id, series_id, split),
            )
        recurrence_engine.prune_unexecuted(conn, series_id, split)
    old_row = conn.execute(_SERIES_SELECT + " AND rs.id = ?", (series_id,)).fetchone()
    new_row = (conn.execute(_SERIES_SELECT + " AND rs.id = ?", (new_series_id,)).fetchone()
               if new_series_id else None)
    conn.close()
    return {
        "series": _series_dict(old_row),
        "new_series": _series_dict(new_row) if new_row else None,
    }


@app.delete("/recurrence-series/{series_id}")
def delete_recurrence_series(series_id: int, from_date: Optional[str] = None):
    """Stop or remove a series.

    With from_date: the series ends the day before from_date ("stop starting
    today") — future never-executed rows go, history stays.
    Without: the whole series is removed; executed occurrences survive as
    ordinary history rows (series_id becomes NULL).
    """
    conn = get_connection()
    row = conn.execute(
        "SELECT * FROM recurrence_series WHERE id = ?", (series_id,)).fetchone()
    if not row:
        conn.close()
        raise HTTPException(status_code=404, detail="Series not found")
    now = datetime.now().isoformat()
    if from_date:
        _validate_iso_date(from_date, "from_date")
        new_until = (date.fromisoformat(from_date) - timedelta(days=1)).isoformat()
        with conn:
            conn.execute(
                "UPDATE recurrence_series SET until_date = ?, updated_at = ? WHERE id = ?",
                (new_until, now, series_id),
            )
            recurrence_engine.prune_unexecuted(conn, series_id, from_date, include_detached=True)
        out = conn.execute(_SERIES_SELECT + " AND rs.id = ?", (series_id,)).fetchone()
        conn.close()
        return _series_dict(out)
    with conn:
        recurrence_engine.prune_unexecuted(conn, series_id, "0000-01-01", include_detached=True)
        conn.execute("DELETE FROM recurrence_series WHERE id = ?", (series_id,))
    conn.close()
    return {"deleted": series_id}


class DepthWindowBody(BaseModel):
    depth: int
    start_minutes: int
    end_minutes: int
    date: Optional[str] = None
    weekday: Optional[int] = None
    protected: bool = False


class DepthWindowPatch(BaseModel):
    depth: Optional[int] = None
    start_minutes: Optional[int] = None
    end_minutes: Optional[int] = None
    date: Optional[str] = None
    weekday: Optional[int] = None
    protected: Optional[bool] = None


def _validate_window_fields(depth: int, start_minutes: int, end_minutes: int,
                            date_iso: Optional[str], weekday: Optional[int]) -> None:
    if depth not in (1, 2, 3):
        raise HTTPException(status_code=422, detail="depth must be 1, 2, or 3")
    if not (0 <= start_minutes < end_minutes <= 1440):
        raise HTTPException(
            status_code=422,
            detail="start_minutes/end_minutes must satisfy 0 <= start < end <= 1440",
        )
    if (date_iso is None) == (weekday is None):
        raise HTTPException(
            status_code=422,
            detail="Provide exactly one of date (one-off) or weekday (recurring)",
        )
    if date_iso is not None:
        _validate_iso_date(date_iso, "date")
    if weekday is not None and not 0 <= weekday <= 6:
        raise HTTPException(status_code=422, detail="weekday must be 0 (Mon) … 6 (Sun)")


@app.get("/depth-windows")
def list_depth_windows():
    """All depth windows — one-off (date set) and recurring (weekday set).

    Recurring windows embed their per-day exceptions as skips: [dates] (P13.0);
    the frontend expands recurrence onto concrete dates and drops skipped days.
    The table is small enough that range filtering server-side buys nothing.
    """
    conn = get_connection()
    rows = conn.execute(
        "SELECT * FROM depth_windows ORDER BY COALESCE(date, ''), weekday, start_minutes"
    ).fetchall()
    skip_rows = conn.execute(
        "SELECT window_id, date FROM depth_window_skips ORDER BY date"
    ).fetchall()
    conn.close()
    skips: dict = defaultdict(list)
    for s in skip_rows:
        skips[s["window_id"]].append(s["date"])
    out = []
    for r in rows:
        w = dict(r)
        w["skips"] = skips.get(w["id"], [])
        out.append(w)
    return out


class WindowSkipBody(BaseModel):
    date: str


@app.post("/depth-windows/{window_id}/skips", status_code=201)
def create_depth_window_skip(window_id: int, body: WindowSkipBody):
    """Exempt one date from a RECURRING window ("remove just this day").

    One-off windows have no recurrence to except — delete the window instead
    (422 here). Skipping the same date twice is idempotent.
    """
    _validate_iso_date(body.date, "date")
    conn = get_connection()
    row = conn.execute("SELECT * FROM depth_windows WHERE id = ?", (window_id,)).fetchone()
    if not row:
        conn.close()
        raise HTTPException(status_code=404, detail="Depth window not found")
    if row["weekday"] is None:
        conn.close()
        raise HTTPException(
            status_code=422,
            detail="Only recurring windows take day exceptions — delete the one-off window instead",
        )
    now = datetime.now().isoformat()
    with conn:
        conn.execute(
            "INSERT OR IGNORE INTO depth_window_skips (window_id, date, created_at) VALUES (?, ?, ?)",
            (window_id, body.date, now),
        )
    dates = [r["date"] for r in conn.execute(
        "SELECT date FROM depth_window_skips WHERE window_id = ? ORDER BY date", (window_id,)
    ).fetchall()]
    conn.close()
    return {"window_id": window_id, "skips": dates}


@app.post("/depth-windows", status_code=201)
def create_depth_window(body: DepthWindowBody):
    _validate_window_fields(body.depth, body.start_minutes, body.end_minutes,
                            body.date, body.weekday)
    now = datetime.now().isoformat()
    conn = get_connection()
    with conn:
        cur = conn.execute(
            "INSERT INTO depth_windows (depth, date, weekday, start_minutes, end_minutes, protected, created_at, updated_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (body.depth, body.date, body.weekday, body.start_minutes,
             body.end_minutes, int(body.protected), now, now),
        )
        window_id = cur.lastrowid
    row = conn.execute("SELECT * FROM depth_windows WHERE id = ?", (window_id,)).fetchone()
    conn.close()
    return dict(row)


@app.patch("/depth-windows/{window_id}")
def update_depth_window(window_id: int, body: DepthWindowPatch):
    conn = get_connection()
    row = conn.execute("SELECT * FROM depth_windows WHERE id = ?", (window_id,)).fetchone()
    if not row:
        conn.close()
        raise HTTPException(status_code=404, detail="Depth window not found")
    window = dict(row)

    bset = body.model_fields_set
    new_depth = body.depth if body.depth is not None else window["depth"]
    new_start = body.start_minutes if body.start_minutes is not None else window["start_minutes"]
    new_end = body.end_minutes if body.end_minutes is not None else window["end_minutes"]
    # date/weekday: sending one switches the window's mode to it; '' clears a
    # date only if a weekday is supplied in the same request (and vice versa),
    # enforced by the exactly-one validation below.
    new_date = window["date"]
    new_weekday = window["weekday"]
    if "date" in bset:
        new_date = body.date or None
    if "weekday" in bset:
        new_weekday = body.weekday
    if "date" in bset and body.date and "weekday" not in bset:
        new_weekday = None
    if "weekday" in bset and body.weekday is not None and "date" not in bset:
        new_date = None
    try:
        _validate_window_fields(new_depth, new_start, new_end, new_date, new_weekday)
    except HTTPException:
        conn.close()
        raise

    with conn:
        conn.execute(
            "UPDATE depth_windows SET depth = ?, date = ?, weekday = ?, start_minutes = ?, "
            "end_minutes = ?, protected = ?, updated_at = ? WHERE id = ?",
            (new_depth, new_date, new_weekday, new_start, new_end,
             int(body.protected if body.protected is not None else window["protected"]),
             datetime.now().isoformat(), window_id),
        )
    updated = conn.execute("SELECT * FROM depth_windows WHERE id = ?", (window_id,)).fetchone()
    conn.close()
    return dict(updated)


@app.delete("/depth-windows/{window_id}")
def delete_depth_window(window_id: int):
    conn = get_connection()
    row = conn.execute("SELECT id FROM depth_windows WHERE id = ?", (window_id,)).fetchone()
    if not row:
        conn.close()
        raise HTTPException(status_code=404, detail="Depth window not found")
    with conn:
        conn.execute("DELETE FROM depth_windows WHERE id = ?", (window_id,))
    conn.close()
    return {"deleted": window_id}


# ---------------------------------------------------------------------------
# External calendars (P15.0) — read-only ICS commitments
#
# External events are their own object: never tasks, sessions, entries, or
# depth windows, and always Fixed for replanning purposes. Sync fetches the
# ICS feed, expands recurrence into concrete occurrences over a bounded
# horizon, and replaces the calendar's events in ONE transaction — so a
# refresh can never duplicate, and a failed fetch keeps the previous events
# while recording last_error. Integration failures stay isolated here; no
# other surface depends on these endpoints.
# ---------------------------------------------------------------------------

from backend import ics as ics_module

SYNC_HORIZON_PAST_DAYS = 60
SYNC_HORIZON_FUTURE_DAYS = 270
ICS_FETCH_TIMEOUT_S = 15
ICS_MAX_BYTES = 5 * 1024 * 1024


def _fetch_ics_text(url: str) -> str:
    """Fetch an ICS feed. Separate function so tests monkeypatch it."""
    import urllib.request
    if not url.lower().startswith(("http://", "https://")):
        raise ValueError("Calendar URL must be http(s)")
    req = urllib.request.Request(url, headers={"User-Agent": "TaskManager/1.0"})
    with urllib.request.urlopen(req, timeout=ICS_FETCH_TIMEOUT_S) as res:
        data = res.read(ICS_MAX_BYTES + 1)
    if len(data) > ICS_MAX_BYTES:
        raise ValueError("Calendar feed too large")
    return data.decode("utf-8", errors="replace")


def _sync_calendar(conn, cal_row) -> int:
    """Fetch + expand + replace events for one calendar. Returns event count.
    Raises on failure AFTER recording last_error (previous events kept)."""
    now_iso = datetime.now().isoformat()
    try:
        text = _fetch_ics_text(cal_row["url"])
        events = ics_module.parse_ics(text)
        window_start = datetime.now() - timedelta(days=SYNC_HORIZON_PAST_DAYS)
        window_end = datetime.now() + timedelta(days=SYNC_HORIZON_FUTURE_DAYS)
        occurrences = ics_module.expand_events(events, window_start, window_end)
    except Exception as exc:
        # §46: never leak the secret feed URL through error text.
        redacted = str(exc).replace(cal_row["url"], "<calendar url>")[:300]
        with conn:
            conn.execute(
                "UPDATE external_calendars SET last_error = ?, updated_at = ? WHERE id = ?",
                (redacted, now_iso, cal_row["id"]),
            )
        raise RuntimeError(redacted) from None
    with conn:
        conn.execute("DELETE FROM external_events WHERE calendar_id = ?", (cal_row["id"],))
        conn.executemany(
            "INSERT INTO external_events (calendar_id, uid, title, start, end, all_day) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            [(cal_row["id"], o["uid"], o["title"], o["start"], o["end"], int(o["all_day"]))
             for o in occurrences],
        )
        conn.execute(
            "UPDATE external_calendars SET last_synced_at = ?, last_error = NULL, updated_at = ? WHERE id = ?",
            (now_iso, now_iso, cal_row["id"]),
        )
    return len(occurrences)


class ExternalCalendarBody(BaseModel):
    name: str
    url: str


class ExternalCalendarPatch(BaseModel):
    name: Optional[str] = None
    url: Optional[str] = None
    visible: Optional[bool] = None


def _mask_calendar(row) -> dict:
    """ICS secret handling (P16.0 §46): the feed URL behaves like a credential
    (Google's 'secret address'). API responses never return it — only the
    host — and it never renders in normal UI after setup."""
    d = dict(row)
    url = d.pop("url", "") or ""
    try:
        from urllib.parse import urlparse
        d["url_host"] = urlparse(url).hostname or ""
    except Exception:
        d["url_host"] = ""
    return d


@app.get("/external-calendars")
def list_external_calendars():
    conn = get_connection()
    rows = conn.execute(
        """
        SELECT c.*, (SELECT COUNT(*) FROM external_events e WHERE e.calendar_id = c.id) AS event_count
        FROM external_calendars c ORDER BY c.id
        """
    ).fetchall()
    conn.close()
    return [_mask_calendar(r) for r in rows]


@app.post("/external-calendars", status_code=201)
def create_external_calendar(body: ExternalCalendarBody):
    name = body.name.strip()
    url = body.url.strip()
    if not name or not url:
        raise HTTPException(status_code=422, detail="name and url are required")
    now = datetime.now().isoformat()
    conn = get_connection()
    with conn:
        cur = conn.execute(
            "INSERT INTO external_calendars (name, url, created_at, updated_at) VALUES (?, ?, ?, ?)",
            (name, url, now, now),
        )
        cal_id = cur.lastrowid
    row = conn.execute("SELECT * FROM external_calendars WHERE id = ?", (cal_id,)).fetchone()
    # Best-effort initial sync — a bad URL still creates the calendar with
    # last_error set, so the user can see and fix it.
    try:
        _sync_calendar(conn, row)
    except Exception:
        pass
    out = conn.execute(
        "SELECT c.*, (SELECT COUNT(*) FROM external_events e WHERE e.calendar_id = c.id) AS event_count "
        "FROM external_calendars c WHERE c.id = ?", (cal_id,)
    ).fetchone()
    conn.close()
    return _mask_calendar(out)


@app.patch("/external-calendars/{cal_id}")
def update_external_calendar(cal_id: int, body: ExternalCalendarPatch):
    conn = get_connection()
    row = conn.execute("SELECT * FROM external_calendars WHERE id = ?", (cal_id,)).fetchone()
    if not row:
        conn.close()
        raise HTTPException(status_code=404, detail="Calendar not found")
    updates = {}
    if body.name is not None and body.name.strip():
        updates["name"] = body.name.strip()
    if body.url is not None and body.url.strip():
        updates["url"] = body.url.strip()
    if body.visible is not None:
        updates["visible"] = int(body.visible)
    if updates:
        updates["updated_at"] = datetime.now().isoformat()
        set_clause = ", ".join(f"{c} = ?" for c in updates)
        with conn:
            conn.execute(
                f"UPDATE external_calendars SET {set_clause} WHERE id = ?",
                list(updates.values()) + [cal_id],
            )
    out = conn.execute("SELECT * FROM external_calendars WHERE id = ?", (cal_id,)).fetchone()
    conn.close()
    return _mask_calendar(out)


@app.delete("/external-calendars/{cal_id}")
def delete_external_calendar(cal_id: int):
    conn = get_connection()
    row = conn.execute("SELECT id FROM external_calendars WHERE id = ?", (cal_id,)).fetchone()
    if not row:
        conn.close()
        raise HTTPException(status_code=404, detail="Calendar not found")
    with conn:
        conn.execute("DELETE FROM external_calendars WHERE id = ?", (cal_id,))
    conn.close()
    return {"deleted": cal_id}


@app.post("/external-calendars/{cal_id}/sync")
def sync_external_calendar(cal_id: int):
    conn = get_connection()
    row = conn.execute("SELECT * FROM external_calendars WHERE id = ?", (cal_id,)).fetchone()
    if not row:
        conn.close()
        raise HTTPException(status_code=404, detail="Calendar not found")
    try:
        count = _sync_calendar(conn, row)
    except Exception as exc:
        conn.close()
        raise HTTPException(status_code=502, detail=f"Sync failed: {exc}")
    conn.close()
    return {"synced": count}


@app.get("/external-events")
def list_external_events(start: str, end: str):
    """Events from VISIBLE calendars overlapping [start, end] (ISO dates)."""
    _validate_iso_date(start, "start")
    _validate_iso_date(end, "end")
    conn = get_connection()
    rows = conn.execute(
        """
        SELECT e.*, c.name AS calendar_name,
               cel.context_id AS context_id, ctx.name AS context_name
        FROM external_events e
        JOIN external_calendars c ON c.id = e.calendar_id
        LEFT JOIN context_event_links cel
               ON cel.calendar_id = e.calendar_id AND cel.uid = e.uid
        LEFT JOIN contexts ctx ON ctx.id = cel.context_id
        WHERE c.visible = 1 AND e.start <= ? AND e.end >= ?
        ORDER BY e.start, e.id
        """,
        (end + "T23:59", start + "T00:00"),
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


# ---------------------------------------------------------------------------
# Depth window templates (P15.0) — user-defined reusable window sets.
# Templates only accelerate creating the same user-declared windows; they
# never infer capacity. Applying happens client-side via POST /depth-windows.
# ---------------------------------------------------------------------------

class TemplateBody(BaseModel):
    name: str
    items: list[dict]


class TemplatePatch(BaseModel):
    name: Optional[str] = None
    items: Optional[list[dict]] = None


def _validate_template_items(items: list[dict]) -> list[dict]:
    clean = []
    for it in items:
        depth = it.get("depth")
        start_m = it.get("start_minutes")
        end_m = it.get("end_minutes")
        protected = bool(it.get("protected", False))
        if depth not in (1, 2, 3):
            raise HTTPException(status_code=422, detail="template item depth must be 1, 2, or 3")
        if not (isinstance(start_m, int) and isinstance(end_m, int)
                and 0 <= start_m < end_m <= 1440):
            raise HTTPException(status_code=422, detail="template item minutes invalid")
        clean.append({"depth": depth, "start_minutes": start_m,
                      "end_minutes": end_m, "protected": protected})
    return clean


@app.get("/depth-window-templates")
def list_templates():
    conn = get_connection()
    rows = conn.execute("SELECT * FROM depth_window_templates ORDER BY name, id").fetchall()
    conn.close()
    out = []
    for r in rows:
        d = dict(r)
        d["items"] = json.loads(d["items"])
        out.append(d)
    return out


@app.post("/depth-window-templates", status_code=201)
def create_template(body: TemplateBody):
    name = body.name.strip()
    if not name:
        raise HTTPException(status_code=422, detail="name is required")
    items = _validate_template_items(body.items)
    now = datetime.now().isoformat()
    conn = get_connection()
    with conn:
        cur = conn.execute(
            "INSERT INTO depth_window_templates (name, items, created_at, updated_at) VALUES (?, ?, ?, ?)",
            (name, json.dumps(items), now, now),
        )
        tpl_id = cur.lastrowid
    row = conn.execute("SELECT * FROM depth_window_templates WHERE id = ?", (tpl_id,)).fetchone()
    conn.close()
    d = dict(row)
    d["items"] = json.loads(d["items"])
    return d


@app.patch("/depth-window-templates/{tpl_id}")
def update_template(tpl_id: int, body: TemplatePatch):
    conn = get_connection()
    row = conn.execute("SELECT * FROM depth_window_templates WHERE id = ?", (tpl_id,)).fetchone()
    if not row:
        conn.close()
        raise HTTPException(status_code=404, detail="Template not found")
    updates = {}
    if body.name is not None and body.name.strip():
        updates["name"] = body.name.strip()
    if body.items is not None:
        try:
            updates["items"] = json.dumps(_validate_template_items(body.items))
        except HTTPException:
            conn.close()
            raise
    if updates:
        updates["updated_at"] = datetime.now().isoformat()
        set_clause = ", ".join(f"{c} = ?" for c in updates)
        with conn:
            conn.execute(
                f"UPDATE depth_window_templates SET {set_clause} WHERE id = ?",
                list(updates.values()) + [tpl_id],
            )
    out = conn.execute("SELECT * FROM depth_window_templates WHERE id = ?", (tpl_id,)).fetchone()
    conn.close()
    d = dict(out)
    d["items"] = json.loads(d["items"])
    return d


@app.delete("/depth-window-templates/{tpl_id}")
def delete_template(tpl_id: int):
    conn = get_connection()
    row = conn.execute("SELECT id FROM depth_window_templates WHERE id = ?", (tpl_id,)).fetchone()
    if not row:
        conn.close()
        raise HTTPException(status_code=404, detail="Template not found")
    with conn:
        conn.execute("DELETE FROM depth_window_templates WHERE id = ?", (tpl_id,))
    conn.close()
    return {"deleted": tpl_id}


# ---------------------------------------------------------------------------
# Contexts (P16.0) — lightweight shared real-world contexts (courses,
# projects, recruiting). Tasks link via tasks.context_id; external event
# SERIES link via (calendar_id, uid) so associations survive sync's
# replace-all. Removing a context or an association never deletes tasks or
# events.
# ---------------------------------------------------------------------------

class ContextBody(BaseModel):
    name: str


@app.get("/contexts")
def list_contexts():
    conn = get_connection()
    rows = conn.execute(
        """
        SELECT x.*,
               (SELECT COUNT(*) FROM tasks t WHERE t.context_id = x.id AND t.is_active = 1) AS task_count,
               (SELECT COUNT(*) FROM context_event_links l WHERE l.context_id = x.id) AS event_link_count
        FROM contexts x ORDER BY x.name, x.id
        """
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


@app.post("/contexts", status_code=201)
def create_context(body: ContextBody):
    name = body.name.strip()
    if not name:
        raise HTTPException(status_code=422, detail="name is required")
    now = datetime.now().isoformat()
    conn = get_connection()
    existing = conn.execute("SELECT * FROM contexts WHERE name = ?", (name,)).fetchone()
    if existing:
        conn.close()
        return dict(existing)  # find-or-create by exact name
    with conn:
        cur = conn.execute(
            "INSERT INTO contexts (name, created_at, updated_at) VALUES (?, ?, ?)",
            (name, now, now),
        )
        ctx_id = cur.lastrowid
    row = conn.execute("SELECT * FROM contexts WHERE id = ?", (ctx_id,)).fetchone()
    conn.close()
    return dict(row)


@app.patch("/contexts/{ctx_id}")
def rename_context(ctx_id: int, body: ContextBody):
    name = body.name.strip()
    if not name:
        raise HTTPException(status_code=422, detail="name is required")
    conn = get_connection()
    row = conn.execute("SELECT * FROM contexts WHERE id = ?", (ctx_id,)).fetchone()
    if not row:
        conn.close()
        raise HTTPException(status_code=404, detail="Context not found")
    with conn:
        conn.execute(
            "UPDATE contexts SET name = ?, updated_at = ? WHERE id = ?",
            (name, datetime.now().isoformat(), ctx_id),
        )
    out = conn.execute("SELECT * FROM contexts WHERE id = ?", (ctx_id,)).fetchone()
    conn.close()
    return dict(out)


@app.delete("/contexts/{ctx_id}")
def delete_context(ctx_id: int):
    """Remove a context. Tasks keep existing (context_id → NULL via FK);
    event associations cascade away; nothing else is touched."""
    conn = get_connection()
    row = conn.execute("SELECT id FROM contexts WHERE id = ?", (ctx_id,)).fetchone()
    if not row:
        conn.close()
        raise HTTPException(status_code=404, detail="Context not found")
    with conn:
        conn.execute("DELETE FROM contexts WHERE id = ?", (ctx_id,))
    conn.close()
    return {"deleted": ctx_id}


class ContextEventLinkBody(BaseModel):
    context_id: int
    calendar_id: int
    uid: str


@app.post("/context-event-links", status_code=201)
def link_event_to_context(body: ContextEventLinkBody):
    """Associate an external event SERIES with a context (one context per
    series — re-linking replaces the previous association)."""
    uid = body.uid.strip()
    if not uid:
        raise HTTPException(status_code=422, detail="uid is required")
    conn = get_connection()
    if not conn.execute("SELECT id FROM contexts WHERE id = ?", (body.context_id,)).fetchone():
        conn.close()
        raise HTTPException(status_code=404, detail="Context not found")
    if not conn.execute("SELECT id FROM external_calendars WHERE id = ?", (body.calendar_id,)).fetchone():
        conn.close()
        raise HTTPException(status_code=404, detail="Calendar not found")
    now = datetime.now().isoformat()
    with conn:
        conn.execute(
            "INSERT INTO context_event_links (context_id, calendar_id, uid, created_at) "
            "VALUES (?, ?, ?, ?) "
            "ON CONFLICT(calendar_id, uid) DO UPDATE SET context_id = excluded.context_id",
            (body.context_id, body.calendar_id, uid, now),
        )
    conn.close()
    return {"context_id": body.context_id, "calendar_id": body.calendar_id, "uid": uid}


@app.delete("/context-event-links")
def unlink_event_from_context(calendar_id: int, uid: str):
    conn = get_connection()
    with conn:
        cur = conn.execute(
            "DELETE FROM context_event_links WHERE calendar_id = ? AND uid = ?",
            (calendar_id, uid.strip()),
        )
    conn.close()
    if cur.rowcount == 0:
        raise HTTPException(status_code=404, detail="Association not found")
    return {"deleted": True}


# ---------------------------------------------------------------------------
# Task ↔ event relationships (P16.0 §29–§34) — Related / Before / After with
# optional relative offsets. event_start pins the linked occurrence so moved
# and cancelled events are detectable; tasks always survive both.
# ---------------------------------------------------------------------------

class TaskEventLinkBody(BaseModel):
    task_id: int
    calendar_id: int
    uid: str
    relation: str = "related"
    offset_minutes: Optional[int] = None
    event_start: Optional[str] = None


class TaskEventLinkPatch(BaseModel):
    relation: Optional[str] = None
    offset_minutes: Optional[int] = None
    event_start: Optional[str] = None


_LINK_RELATIONS = frozenset({"related", "before", "after"})


def _enrich_task_event_links(conn, rows, now_stamp: str) -> list[dict]:
    out = []
    for r in rows:
        d = dict(r)
        occ = [x["start"] for x in conn.execute(
            "SELECT start FROM external_events WHERE calendar_id = ? AND uid = ? ORDER BY start",
            (d["calendar_id"], d["uid"]),
        ).fetchall()]
        if not occ:
            d["event_status"] = "cancelled"
            d["next_start"] = None
        else:
            d["next_start"] = next((s for s in occ if s >= now_stamp), occ[-1])
            if d["event_start"] and d["event_start"] not in occ:
                d["event_status"] = "moved"
            else:
                d["event_status"] = "ok"
        task = conn.execute(
            """
            SELECT t.name, t.is_active, t.end_date,
                   (SELECT MAX(completion_date) FROM completions c WHERE c.task_id = t.id) AS latest_completion
            FROM tasks t WHERE t.id = ?
            """,
            (d["task_id"],),
        ).fetchone()
        d["task_name"] = task["name"] if task else "(deleted)"
        today = now_stamp[:10]
        ended = bool(task and task["end_date"] and task["end_date"] <= today)
        d["task_done"] = bool(task and (ended or task["latest_completion"] is not None))
        out.append(d)
    return out


@app.get("/task-event-links")
def list_task_event_links(
    task_id: Optional[int] = None,
    calendar_id: Optional[int] = None,
    uid: Optional[str] = None,
    now: Optional[str] = None,
):
    if task_id is None and not (calendar_id and uid):
        raise HTTPException(status_code=422, detail="Provide task_id or calendar_id+uid")
    now_stamp = (now or datetime.now().strftime("%Y-%m-%dT%H:%M"))
    query = "SELECT * FROM task_event_links WHERE 1=1"
    params: list = []
    if task_id is not None:
        query += " AND task_id = ?"
        params.append(task_id)
    if calendar_id and uid:
        query += " AND calendar_id = ? AND uid = ?"
        params.extend([calendar_id, uid.strip()])
    conn = get_connection()
    rows = conn.execute(query + " ORDER BY relation, id", params).fetchall()
    out = _enrich_task_event_links(conn, rows, now_stamp)
    conn.close()
    return out


@app.post("/task-event-links", status_code=201)
def create_task_event_link(body: TaskEventLinkBody):
    if body.relation not in _LINK_RELATIONS:
        raise HTTPException(status_code=422, detail="relation must be related, before, or after")
    if body.offset_minutes is not None and body.offset_minutes < 0:
        raise HTTPException(status_code=422, detail="offset_minutes must be >= 0")
    uid = body.uid.strip()
    if not uid:
        raise HTTPException(status_code=422, detail="uid is required")
    conn = get_connection()
    if not conn.execute("SELECT id FROM tasks WHERE id = ? AND is_active = 1", (body.task_id,)).fetchone():
        conn.close()
        raise HTTPException(status_code=404, detail="Task not found")
    if not conn.execute("SELECT id FROM external_calendars WHERE id = ?", (body.calendar_id,)).fetchone():
        conn.close()
        raise HTTPException(status_code=404, detail="Calendar not found")
    now = datetime.now().isoformat()
    with conn:
        cur = conn.execute(
            "INSERT INTO task_event_links (task_id, calendar_id, uid, relation, offset_minutes, event_start, created_at, updated_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (body.task_id, body.calendar_id, uid, body.relation,
             body.offset_minutes, body.event_start, now, now),
        )
        link_id = cur.lastrowid
    row = conn.execute("SELECT * FROM task_event_links WHERE id = ?", (link_id,)).fetchone()
    out = _enrich_task_event_links(conn, [row], datetime.now().strftime("%Y-%m-%dT%H:%M"))[0]
    conn.close()
    return out


@app.patch("/task-event-links/{link_id}")
def update_task_event_link(link_id: int, body: TaskEventLinkPatch):
    conn = get_connection()
    row = conn.execute("SELECT * FROM task_event_links WHERE id = ?", (link_id,)).fetchone()
    if not row:
        conn.close()
        raise HTTPException(status_code=404, detail="Link not found")
    updates = {}
    if body.relation is not None:
        if body.relation not in _LINK_RELATIONS:
            conn.close()
            raise HTTPException(status_code=422, detail="relation must be related, before, or after")
        updates["relation"] = body.relation
    if body.offset_minutes is not None:
        if body.offset_minutes < 0:
            conn.close()
            raise HTTPException(status_code=422, detail="offset_minutes must be >= 0")
        updates["offset_minutes"] = body.offset_minutes or None
    if body.event_start is not None:
        updates["event_start"] = body.event_start or None
    if updates:
        updates["updated_at"] = datetime.now().isoformat()
        set_clause = ", ".join(f"{c} = ?" for c in updates)
        with conn:
            conn.execute(
                f"UPDATE task_event_links SET {set_clause} WHERE id = ?",
                list(updates.values()) + [link_id],
            )
    out_row = conn.execute("SELECT * FROM task_event_links WHERE id = ?", (link_id,)).fetchone()
    out = _enrich_task_event_links(conn, [out_row], datetime.now().strftime("%Y-%m-%dT%H:%M"))[0]
    conn.close()
    return out


@app.delete("/task-event-links/{link_id}")
def delete_task_event_link(link_id: int):
    """Detach a relationship — the task and the event both survive."""
    conn = get_connection()
    row = conn.execute("SELECT id FROM task_event_links WHERE id = ?", (link_id,)).fetchone()
    if not row:
        conn.close()
        raise HTTPException(status_code=404, detail="Link not found")
    with conn:
        conn.execute("DELETE FROM task_event_links WHERE id = ?", (link_id,))
    conn.close()
    return {"deleted": link_id}


def _shift_stamp(stamp: str, delta_minutes: int) -> str:
    return (datetime.fromisoformat(stamp)
            + timedelta(minutes=delta_minutes)).strftime("%Y-%m-%dT%H:%M")


@app.get("/event-move-proposals")
def get_event_move_proposal(calendar_id: int, uid: str, now: Optional[str] = None):
    """Repositioning proposal for sessions related to a MOVED external event
    (V5.0 §3–§4). Detection and arithmetic only — nothing here moves anything.

    The response carries exact proposed times computed from the event's time
    delta; the client applies the user's choice through the ordinary session
    PATCH and then acknowledges by updating each link's remembered
    event_start. Only Flexible scheduled future sessions are proposed; Fixed
    sessions are counted so the UI can say they stay put.
    """
    now_stamp = now or datetime.now().strftime("%Y-%m-%dT%H:%M")
    conn = get_connection()
    links = conn.execute(
        "SELECT * FROM task_event_links WHERE calendar_id = ? AND uid = ?",
        (calendar_id, uid.strip()),
    ).fetchall()
    moved = [l for l in _enrich_task_event_links(conn, links, now_stamp)
             if l["event_status"] == "moved" and l["next_start"] and l["event_start"]]
    if not moved:
        conn.close()
        return {"moved": False, "items": [], "fixed_count": 0, "link_ids": []}

    items = []
    fixed_count = 0
    for link in moved:
        delta = _session_minutes(link["event_start"], link["next_start"])
        for s in conn.execute(
            "SELECT * FROM task_sessions WHERE task_id = ? AND status = 'scheduled' "
            "AND planned_start >= ? ORDER BY planned_start, id",
            (link["task_id"], now_stamp),
        ).fetchall():
            if s["is_fixed"]:
                fixed_count += 1
                continue
            items.append({
                "session_id": s["id"],
                "task_id": link["task_id"],
                "task_name": link["task_name"],
                "planned_start": s["planned_start"],
                "planned_end": s["planned_end"],
                "proposed_start": _shift_stamp(s["planned_start"], delta),
                "proposed_end": _shift_stamp(s["planned_end"], delta),
            })
    out = {
        "moved": True,
        "old_start": moved[0]["event_start"],
        "new_start": moved[0]["next_start"],
        "items": items,
        "fixed_count": fixed_count,
        "link_ids": [l["id"] for l in moved],
    }
    conn.close()
    return out


# ---------------------------------------------------------------------------
# Natural-language scheduling (V5.2 Part III) + Calendar search (Part V).
# Both are pure reads: /nl/parse only interprets (the client shows the
# interpretation for confirmation — §10), and /search only finds.
# ---------------------------------------------------------------------------

@app.get("/nl/parse")
def parse_natural_language(q: str, now: Optional[str] = None):
    """Interpret a concise scheduling expression. Never creates anything."""
    now_dt = datetime.fromisoformat(now) if now else datetime.now()
    conn = get_connection()
    contexts = [dict(r) for r in conn.execute("SELECT id, name FROM contexts").fetchall()]
    tasks = [dict(r) for r in conn.execute(
        "SELECT id, name FROM tasks WHERE is_active = 1 AND is_paused = 0"
    ).fetchall()]
    conn.close()
    try:
        return nl_parser.parse_nl(q, now_dt, contexts=contexts, tasks=tasks)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))


_SEARCH_TYPES = frozenset({"task", "session", "entry", "event", "context"})


@app.get("/search/workspace")
def search_workspace(q: str = "", limit: int = 100):
    """Read-only workspace search (tm-clean 11; ported from drift-ref without
    the archive-snapshot results, which no UI shows since tm-clean 02).

    Matches tasks (name/subtask/category/section/notes), cell notes, text
    cells, reading books (title/author/notes/purchase notes) and reading
    checkpoint notes. Each task result carries the date whose month should be
    revealed: the note/text cell's own date, else the finish date, else the
    later of today and Active from.
    """
    query = q.strip().casefold()
    if not query:
        return []
    limit = max(1, min(200, limit))
    conn = get_connection()
    results = []

    def matches(*values):
        return any(query in str(value or "").casefold() for value in values)

    def task_result(task, when=None, **extra):
        # Finished tasks must open no later than their finish month.
        when = when or task.get("end_date") or max(
            date.today().isoformat(), (task.get("active_from") or "")[:10])
        return {"kind": "task", "id": task["id"], "label": task["name"],
                "date": when[:10], **extra}

    try:
        tasks = [dict(r) for r in conn.execute("SELECT * FROM tasks WHERE is_active = 1 ORDER BY display_order, id")]
        by_id = {t["id"]: t for t in tasks}
        for task in tasks:
            if matches(*(task.get(k) for k in ("name", "subtask", "category", "section", "notes"))):
                results.append(task_result(task, detail=task.get("section") or "Task"))
        # Keep dated matches separate: selecting a note must reveal its own month.
        for table, date_col, text_col in (("cell_notes", "note_date", "note"), ("date_cell_overrides", "date", "text")):
            for row in conn.execute(f"SELECT * FROM {table} ORDER BY {date_col} DESC"):
                if row["task_id"] in by_id and matches(row[text_col]):
                    results.append(task_result(by_id[row["task_id"]], row[date_col], detail=row[text_col]))
        for book in conn.execute("SELECT * FROM reading_books ORDER BY display_order, id"):
            if matches(*(book[k] for k in ("title", "author", "notes", "purchase_notes"))):
                results.append({"kind": "reading", "id": book["id"], "label": book["title"], "detail": book["author"]})
        for entry in conn.execute("SELECT e.*, b.title FROM reading_entries e JOIN reading_books b ON b.id = e.book_id ORDER BY e.entry_date DESC"):
            if matches(entry["note"]):
                results.append({"kind": "reading", "id": entry["book_id"], "entryId": entry["id"],
                                "label": entry["title"], "date": entry["entry_date"], "detail": entry["note"]})
        return results[:limit]
    finally:
        conn.close()


@app.get("/search")
def search_calendar(
    q: str = "",
    types: Optional[str] = None,
    start: Optional[str] = None,
    end: Optional[str] = None,
    context_id: Optional[int] = None,
    depth: Optional[int] = None,
    status: Optional[str] = None,       # completed | incomplete (sessions)
    calendar_id: Optional[int] = None,  # external source filter
    limit: int = 30,
):
    """Search across tasks, sessions, calendar entries, external events, and
    contexts (§15/§16). Historical and future records alike; substring match,
    case-insensitive. Read-only."""
    query = q.strip().lower()
    if not query and context_id is None:
        raise HTTPException(status_code=422, detail="Provide q or context_id")
    if status is not None and status not in ("completed", "incomplete"):
        raise HTTPException(status_code=422, detail="status must be completed or incomplete")
    requested = _SEARCH_TYPES if not types else {
        t.strip() for t in types.split(",") if t.strip() in _SEARCH_TYPES}
    like = f"%{query}%"
    limit = max(1, min(100, limit))
    conn = get_connection()
    out: dict = {"tasks": [], "sessions": [], "events": [], "contexts": []}

    if "task" in requested:
        sql = """
            SELECT t.id, t.name, t.section, t.category, t.depth, t.due_date,
                   t.is_paused, c.name AS context_name
            FROM tasks t LEFT JOIN contexts c ON c.id = t.context_id
            WHERE t.is_active = 1
              AND (lower(t.name) LIKE ? OR lower(t.category) LIKE ? OR lower(t.section) LIKE ?)
        """
        params: list = [like, like, like]
        if context_id is not None:
            sql += " AND t.context_id = ?"
            params.append(context_id)
        if depth is not None:
            sql += " AND t.depth = ?"
            params.append(depth)
        sql += " ORDER BY t.name LIMIT ?"
        params.append(limit)
        out["tasks"] = [dict(r) for r in conn.execute(sql, params).fetchall()]

    if requested & {"session", "entry"}:
        sql = """
            SELECT s.id, s.task_id, s.planned_start, s.planned_end, s.status,
                   s.is_fixed,
                   CASE WHEN s.task_id IS NULL THEN s.title ELSE t.name END AS name,
                   CASE WHEN s.task_id IS NULL THEN s.depth ELSE t.depth END AS depth,
                   CASE WHEN s.task_id IS NULL THEN cs.name ELSE ct.name END AS context_name
            FROM task_sessions s
            LEFT JOIN tasks t ON t.id = s.task_id
            LEFT JOIN contexts cs ON cs.id = s.context_id
            LEFT JOIN contexts ct ON ct.id = t.context_id
            WHERE (s.task_id IS NULL OR t.is_active = 1)
              AND lower(CASE WHEN s.task_id IS NULL THEN s.title ELSE t.name END) LIKE ?
        """
        params = [like]
        if "session" not in requested:
            sql += " AND s.task_id IS NULL"
        if "entry" not in requested:
            sql += " AND s.task_id IS NOT NULL"
        if start:
            sql += " AND s.planned_start >= ?"
            params.append(start + "T00:00")
        if end:
            sql += " AND s.planned_start <= ?"
            params.append(end + "T23:59")
        if status == "completed":
            sql += " AND s.status IN ('completed', 'partial')"
        elif status == "incomplete":
            sql += " AND s.status = 'scheduled'"
        if depth is not None:
            sql += " AND CASE WHEN s.task_id IS NULL THEN s.depth ELSE t.depth END = ?"
            params.append(depth)
        if context_id is not None:
            sql += " AND CASE WHEN s.task_id IS NULL THEN s.context_id ELSE t.context_id END = ?"
            params.append(context_id)
        sql += " ORDER BY s.planned_start DESC LIMIT ?"
        params.append(limit)
        out["sessions"] = [dict(r) for r in conn.execute(sql, params).fetchall()]

    if "event" in requested:
        sql = """
            SELECT e.calendar_id, e.uid, e.title, e.start, e.end, e.all_day,
                   c.name AS calendar_name, ctx.name AS context_name
            FROM external_events e
            JOIN external_calendars c ON c.id = e.calendar_id
            LEFT JOIN context_event_links cel
              ON cel.calendar_id = e.calendar_id AND cel.uid = e.uid
            LEFT JOIN contexts ctx ON ctx.id = cel.context_id
            WHERE lower(e.title) LIKE ?
        """
        params = [like]
        if calendar_id is not None:
            sql += " AND e.calendar_id = ?"
            params.append(calendar_id)
        if context_id is not None:
            sql += " AND cel.context_id = ?"
            params.append(context_id)
        if start:
            sql += " AND e.start >= ?"
            params.append(start + "T00:00")
        if end:
            sql += " AND e.start <= ?"
            params.append(end + "T23:59")
        sql += " ORDER BY e.start DESC LIMIT ?"
        params.append(limit)
        out["events"] = [dict(r) for r in conn.execute(sql, params).fetchall()]

    if "context" in requested and query:
        out["contexts"] = [dict(r) for r in conn.execute(
            """
            SELECT x.id, x.name,
                   (SELECT COUNT(*) FROM tasks t WHERE t.context_id = x.id AND t.is_active = 1) AS task_count
            FROM contexts x WHERE lower(x.name) LIKE ? ORDER BY x.name LIMIT ?
            """, (like, limit)).fetchall()]

    conn.close()
    return out


# ---------------------------------------------------------------------------
# Academic importer (V5.3 Part VIII) — candidate pipeline.
#
# Source → parser → candidate rows → REVIEW → approved canonical records.
# Candidates are isolated (§55): importing and rejecting write only to the
# academic_* tables; a canonical task or calendar entry appears exclusively
# through an explicit approval. Every candidate keeps its source line (§27).
# ---------------------------------------------------------------------------

class AcademicImportBody(BaseModel):
    text: str
    context_id: Optional[int] = None
    context_name: Optional[str] = None
    source_name: Optional[str] = None
    today: Optional[str] = None  # test override


class CandidatePatch(BaseModel):
    title: Optional[str] = None
    date: Optional[str] = None
    kind: Optional[str] = None
    start_minutes: Optional[int] = None
    end_minutes: Optional[int] = None


class CandidateApproveBody(BaseModel):
    # mode 'create' makes a new record; 'update_existing' applies a detected
    # date change (§31) to the already-existing task instead.
    mode: str = "create"
    until: Optional[str] = None      # expansion horizon for recurring rows
    from_date: Optional[str] = None  # expansion start (defaults to today)


class CandidateBulkBody(BaseModel):
    ids: list[int]
    action: str  # approve | reject
    until: Optional[str] = None
    from_date: Optional[str] = None


_CANDIDATE_KINDS = academic.TASK_KINDS | academic.EVENT_KINDS


def _candidate_dict(row) -> dict:
    d = dict(row)
    d["weekdays"] = json.loads(d.get("weekdays") or "[]")
    return d


def _detect_candidate_duplicates(conn, cand: dict, context_id: Optional[int]):
    """§30/§31 — mark suspected duplicates; the user decides at review."""
    norm = academic.normalize_title(cand["title"])
    if not norm:
        return None, None
    for t in conn.execute(
        "SELECT id, name, due_date, context_id FROM tasks WHERE is_active = 1"
    ).fetchall():
        if academic.normalize_title(t["name"]) != norm:
            continue
        if context_id is not None and t["context_id"] is not None \
                and t["context_id"] != context_id:
            continue
        conflict = None
        if cand["date"] and t["due_date"] and t["due_date"] != cand["date"]:
            conflict = t["due_date"]
        return f"task:{t['id']}", conflict
    prev = conn.execute(
        "SELECT id, title, kind, date FROM academic_candidates "
        "WHERE status != 'rejected' AND (context_id IS ? OR context_id = ?)",
        (context_id, context_id),
    ).fetchall()
    for p in prev:
        if p["kind"] == cand["kind"] and academic.normalize_title(p["title"]) == norm:
            conflict = None
            if cand["date"] and p["date"] and p["date"] != cand["date"]:
                conflict = p["date"]
            return f"candidate:{p['id']}", conflict
    return None, None


@app.post("/academic/import", status_code=201)
def academic_import(body: AcademicImportBody):
    """Parse pasted syllabus/schedule text into PENDING candidates. Never
    writes to canonical tables — approval is a separate explicit step."""
    text = body.text.strip()
    if not text:
        raise HTTPException(status_code=422, detail="No text to import")
    today = date.fromisoformat(body.today) if body.today else date.today()
    parsed = academic.parse_academic_text(text, today)

    conn = get_connection()
    context_id = body.context_id
    if context_id is None and body.context_name and body.context_name.strip():
        name = body.context_name.strip()
        row = conn.execute(
            "SELECT id FROM contexts WHERE lower(name) = lower(?)", (name,)
        ).fetchone()
        if row:
            context_id = row["id"]
        else:
            now = datetime.now().isoformat()
            with conn:
                cur = conn.execute(
                    "INSERT INTO contexts (name, created_at, updated_at) VALUES (?, ?, ?)",
                    (name, now, now))
            context_id = cur.lastrowid
    elif context_id is not None and not conn.execute(
            "SELECT id FROM contexts WHERE id = ?", (context_id,)).fetchone():
        conn.close()
        raise HTTPException(status_code=404, detail="Context not found")

    now = datetime.now().isoformat()
    with conn:
        cur = conn.execute(
            "INSERT INTO academic_batches (context_id, source_name, created_at) VALUES (?, ?, ?)",
            (context_id, (body.source_name or "").strip(), now))
        batch_id = cur.lastrowid
        for cand in parsed:
            dup, conflict = _detect_candidate_duplicates(conn, cand, context_id)
            conn.execute(
                """
                INSERT INTO academic_candidates (
                    batch_id, context_id, kind, title, date, start_minutes,
                    end_minutes, weekdays, source_text, status, duplicate_of,
                    date_conflict, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)
                """,
                (batch_id, context_id, cand["kind"], cand["title"], cand["date"],
                 cand["start_minutes"], cand["end_minutes"],
                 json.dumps(cand["weekdays"]), cand["source_text"],
                 dup, conflict, now, now))
    rows = conn.execute(
        "SELECT * FROM academic_candidates WHERE batch_id = ? ORDER BY id", (batch_id,)
    ).fetchall()
    conn.close()
    return {"batch_id": batch_id, "context_id": context_id,
            "candidates": [_candidate_dict(r) for r in rows]}


@app.get("/academic/batches")
def list_academic_batches():
    conn = get_connection()
    rows = conn.execute(
        """
        SELECT b.*, c.name AS context_name,
               (SELECT COUNT(*) FROM academic_candidates a WHERE a.batch_id = b.id) AS candidate_count,
               (SELECT COUNT(*) FROM academic_candidates a WHERE a.batch_id = b.id AND a.status = 'pending') AS pending_count
        FROM academic_batches b LEFT JOIN contexts c ON c.id = b.context_id
        ORDER BY b.id DESC
        """).fetchall()
    conn.close()
    return [dict(r) for r in rows]


@app.get("/academic/candidates")
def list_academic_candidates(batch_id: Optional[int] = None, status: Optional[str] = None):
    query = """
        SELECT a.*, c.name AS context_name FROM academic_candidates a
        LEFT JOIN contexts c ON c.id = a.context_id WHERE 1=1
    """
    params: list = []
    if batch_id is not None:
        query += " AND a.batch_id = ?"
        params.append(batch_id)
    if status is not None:
        query += " AND a.status = ?"
        params.append(status)
    conn = get_connection()
    rows = conn.execute(query + " ORDER BY a.id", params).fetchall()
    conn.close()
    return [_candidate_dict(r) for r in rows]


@app.patch("/academic/candidates/{cand_id}")
def update_academic_candidate(cand_id: int, body: CandidatePatch):
    conn = get_connection()
    row = conn.execute("SELECT * FROM academic_candidates WHERE id = ?", (cand_id,)).fetchone()
    if not row:
        conn.close()
        raise HTTPException(status_code=404, detail="Candidate not found")
    if row["status"] != "pending":
        conn.close()
        raise HTTPException(status_code=409, detail="Only pending candidates can be edited")
    updates: dict = {}
    if body.title is not None:
        if not body.title.strip():
            conn.close()
            raise HTTPException(status_code=422, detail="title must not be blank")
        updates["title"] = body.title.strip()
    if body.date is not None:
        if body.date == "":
            updates["date"] = None
        else:
            try:
                date.fromisoformat(body.date)
            except ValueError:
                conn.close()
                raise HTTPException(status_code=422, detail="date must be YYYY-MM-DD")
            updates["date"] = body.date
    if body.kind is not None:
        if body.kind not in _CANDIDATE_KINDS and body.kind != "deadline":
            conn.close()
            raise HTTPException(status_code=422, detail="Unknown kind")
        updates["kind"] = body.kind
    if body.start_minutes is not None:
        updates["start_minutes"] = body.start_minutes or None
    if body.end_minutes is not None:
        updates["end_minutes"] = body.end_minutes or None
    if updates:
        updates["updated_at"] = datetime.now().isoformat()
        set_clause = ", ".join(f"{c} = ?" for c in updates)
        with conn:
            conn.execute(
                f"UPDATE academic_candidates SET {set_clause} WHERE id = ?",
                list(updates.values()) + [cand_id])
    out = conn.execute(
        "SELECT a.*, c.name AS context_name FROM academic_candidates a "
        "LEFT JOIN contexts c ON c.id = a.context_id WHERE a.id = ?", (cand_id,)).fetchone()
    conn.close()
    return _candidate_dict(out)


def _approve_academic_candidate(conn, cand: dict, *, mode: str, until: Optional[str],
                                from_date: Optional[str]) -> str:
    """Create the canonical record for one candidate (§29). Returns a
    created_record tag. Raises HTTPException when the candidate cannot be
    approved as-is (missing date, recurring without horizon, …)."""
    ctx_id = cand["context_id"]
    ctx_name = None
    if ctx_id:
        r = conn.execute("SELECT name FROM contexts WHERE id = ?", (ctx_id,)).fetchone()
        ctx_name = r["name"] if r else None
    now = datetime.now().isoformat()
    weekdays = cand["weekdays"]

    if mode == "update_existing":
        # §31 — accept a detected date change on the already-existing task.
        dup = cand.get("duplicate_of") or ""
        if not dup.startswith("task:"):
            raise HTTPException(status_code=422, detail="No existing task to update")
        if not cand["date"]:
            raise HTTPException(status_code=422, detail="Candidate has no date")
        task_id = int(dup.split(":")[1])
        with conn:
            conn.execute("UPDATE tasks SET due_date = ? WHERE id = ?",
                         (cand["date"], task_id))
        return f"task:{task_id}:due_date"

    if weekdays and cand["start_minutes"] is not None:
        # Recurring class/office hours → fixed calendar entries, expanded
        # only through the user-chosen horizon. Never silently unbounded.
        if not until:
            raise HTTPException(
                status_code=422,
                detail="Recurring times need an 'until' date to expand")
        start_d = date.fromisoformat(from_date) if from_date else date.today()
        end_d = date.fromisoformat(until)
        if end_d < start_d or (end_d - start_d).days > 200:
            raise HTTPException(status_code=422, detail="Unreasonable expansion range")
        sm = cand["start_minutes"]
        em = min(1439, cand["end_minutes"] or sm + 60)
        count = 0
        d = start_d
        with conn:
            while d <= end_d:
                if d.weekday() in weekdays:
                    conn.execute(
                        "INSERT INTO task_sessions (task_id, title, depth, context_id, "
                        "planned_start, planned_end, is_fixed, created_at, updated_at) "
                        "VALUES (NULL, ?, NULL, ?, ?, ?, 1, ?, ?)",
                        (cand["title"], ctx_id,
                         f"{d.isoformat()}T{sm // 60:02d}:{sm % 60:02d}",
                         f"{d.isoformat()}T{em // 60:02d}:{em % 60:02d}",
                         now, now))
                    count += 1
                d += timedelta(days=1)
        return f"entries:{count}"

    if cand["kind"] in academic.EVENT_KINDS and cand["date"] and cand["start_minutes"] is not None:
        # Timed one-off commitment (exam with a time slot) → fixed entry.
        sm = cand["start_minutes"]
        em = min(1439, cand["end_minutes"] or sm + 60)
        with conn:
            cur = conn.execute(
                "INSERT INTO task_sessions (task_id, title, depth, context_id, "
                "planned_start, planned_end, is_fixed, created_at, updated_at) "
                "VALUES (NULL, ?, NULL, ?, ?, ?, 1, ?, ?)",
                (cand["title"], ctx_id,
                 f"{cand['date']}T{sm // 60:02d}:{sm % 60:02d}",
                 f"{cand['date']}T{em // 60:02d}:{em % 60:02d}",
                 now, now))
        return f"entry:{cur.lastrowid}"

    # Everything else is an obligation → Grid task with a deadline (§29).
    if not cand["date"]:
        raise HTTPException(
            status_code=422, detail="Candidate has no date — edit it before approving")
    task = create_task(
        name=cand["title"],
        section=ctx_name or "General",
        due_date=cand["date"],
        context_id=ctx_id,
    )
    return f"task:{task['id']}"


def _do_approve(conn, cand_id: int, body_mode: str, until, from_date) -> dict:
    row = conn.execute("SELECT * FROM academic_candidates WHERE id = ?", (cand_id,)).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Candidate not found")
    if row["status"] != "pending":
        raise HTTPException(status_code=409, detail=f"Candidate is already {row['status']}")
    cand = _candidate_dict(row)
    created = _approve_academic_candidate(
        conn, cand, mode=body_mode, until=until, from_date=from_date)
    with conn:
        conn.execute(
            "UPDATE academic_candidates SET status = 'approved', created_record = ?, "
            "updated_at = ? WHERE id = ?",
            (created, datetime.now().isoformat(), cand_id))
    out = conn.execute("SELECT * FROM academic_candidates WHERE id = ?", (cand_id,)).fetchone()
    return _candidate_dict(out)


@app.post("/academic/candidates/{cand_id}/approve")
def approve_academic_candidate(cand_id: int, body: Optional[CandidateApproveBody] = None):
    body = body or CandidateApproveBody()
    if body.mode not in ("create", "update_existing"):
        raise HTTPException(status_code=422, detail="mode must be create or update_existing")
    conn = get_connection()
    try:
        return _do_approve(conn, cand_id, body.mode, body.until, body.from_date)
    finally:
        conn.close()


@app.post("/academic/candidates/{cand_id}/reject")
def reject_academic_candidate(cand_id: int):
    """Rejecting creates nothing and touches nothing canonical (§26)."""
    conn = get_connection()
    row = conn.execute("SELECT * FROM academic_candidates WHERE id = ?", (cand_id,)).fetchone()
    if not row:
        conn.close()
        raise HTTPException(status_code=404, detail="Candidate not found")
    with conn:
        conn.execute(
            "UPDATE academic_candidates SET status = 'rejected', updated_at = ? WHERE id = ?",
            (datetime.now().isoformat(), cand_id))
    out = conn.execute("SELECT * FROM academic_candidates WHERE id = ?", (cand_id,)).fetchone()
    conn.close()
    return _candidate_dict(out)


@app.post("/academic/candidates/bulk")
def bulk_academic_candidates(body: CandidateBulkBody):
    """Bulk approve/reject. Per-item isolation: one failing candidate (e.g. a
    recurring row without an 'until') never blocks the rest."""
    if body.action not in ("approve", "reject"):
        raise HTTPException(status_code=422, detail="action must be approve or reject")
    conn = get_connection()
    results = []
    for cand_id in body.ids[:200]:
        try:
            if body.action == "approve":
                out = _do_approve(conn, cand_id, "create", body.until, body.from_date)
            else:
                row = conn.execute(
                    "SELECT status FROM academic_candidates WHERE id = ?", (cand_id,)).fetchone()
                if not row:
                    raise HTTPException(status_code=404, detail="Candidate not found")
                with conn:
                    conn.execute(
                        "UPDATE academic_candidates SET status = 'rejected', updated_at = ? "
                        "WHERE id = ? AND status = 'pending'",
                        (datetime.now().isoformat(), cand_id))
                out = _candidate_dict(conn.execute(
                    "SELECT * FROM academic_candidates WHERE id = ?", (cand_id,)).fetchone())
            results.append({"id": cand_id, "ok": True, "candidate": out})
        except HTTPException as exc:
            results.append({"id": cand_id, "ok": False, "error": exc.detail})
    conn.close()
    return {"results": results}


@app.delete("/academic/batches/{batch_id}")
def delete_academic_batch(batch_id: int):
    """Remove a batch and its candidates. Records already created by
    approvals are canonical and survive (§55)."""
    conn = get_connection()
    row = conn.execute("SELECT id FROM academic_batches WHERE id = ?", (batch_id,)).fetchone()
    if not row:
        conn.close()
        raise HTTPException(status_code=404, detail="Batch not found")
    with conn:
        conn.execute("DELETE FROM academic_batches WHERE id = ?", (batch_id,))
    conn.close()
    return {"deleted": batch_id}


# ---------------------------------------------------------------------------
# Execution analytics (V5.4 Parts IX–XII) — see backend/reports.py for the
# arithmetic and its guarantees (no scores, no inferred capacity, sample
# floors). Endpoints are thin and read-only.
# ---------------------------------------------------------------------------

@app.get("/reports/execution")
def report_execution(start: str, end: str, include_entries: bool = False):
    _validate_iso_date(start, "start")
    _validate_iso_date(end, "end")
    conn = get_connection()
    out = reports_engine.execution_report(conn, start, end, include_entries)
    conn.close()
    return out


@app.get("/reports/estimates")
def report_estimates(today: Optional[str] = None):
    today_iso = today or date.today().isoformat()
    conn = get_connection()
    out = reports_engine.estimates_report(conn, today_iso)
    conn.close()
    return out


@app.get("/reports/patterns")
def report_patterns():
    conn = get_connection()
    out = reports_engine.patterns_report(conn)
    conn.close()
    return out


@app.get("/forecast")
def forecast(now: Optional[str] = None, weeks: int = 8):
    weeks = max(1, min(26, weeks))
    now_dt = datetime.fromisoformat(now) if now else datetime.now()
    conn = get_connection()
    out = reports_engine.forecast_report(conn, now_dt, weeks)
    conn.close()
    return out


# ---------------------------------------------------------------------------
# Contextual scheduling (P16.0 Part I) — gap detection + Good Fits Now.
#
# Server-side so the arithmetic is testable and identical everywhere. Every
# suggestion carries plain-language reasons built from its constituent facts;
# there is no composite score, no fabricated capacity, and nothing here ever
# schedules anything by itself — the user places work.
# ---------------------------------------------------------------------------

def _fmt_minutes(m: int) -> str:
    m = int(m)
    if m < 60:
        return f"{m}m"
    h, rem = divmod(m, 60)
    return f"{h}h" if rem == 0 else f"{h}h {rem}m"


def _current_gap(conn, now_dt: datetime):
    """Free interval from now until the next FIXED boundary today: fixed task
    sessions/entries and external commitments. Flexible scheduled work never
    defines the boundary (§6)."""
    today = now_dt.date().isoformat()
    now_min = now_dt.hour * 60 + now_dt.minute
    obstacles = []
    for r in conn.execute(
        """
        SELECT s.planned_start, s.planned_end,
               CASE WHEN s.task_id IS NULL THEN s.title ELSE
                    (SELECT name FROM tasks t WHERE t.id = s.task_id) END AS label
        FROM task_sessions s
        WHERE s.is_fixed = 1 AND s.status = 'scheduled'
          AND s.planned_start LIKE ?
        """, (today + "%",)
    ).fetchall():
        sm = int(r["planned_start"][11:13]) * 60 + int(r["planned_start"][14:16])
        em = int(r["planned_end"][11:13]) * 60 + int(r["planned_end"][14:16]) \
            if r["planned_end"].startswith(today) else 1440
        obstacles.append((sm, em, r["label"] or "fixed block"))
    for r in conn.execute(
        """
        SELECT e.start, e.end, e.title FROM external_events e
        JOIN external_calendars c ON c.id = e.calendar_id
        WHERE c.visible = 1 AND e.all_day = 0 AND e.start LIKE ?
        """, (today + "%",)
    ).fetchall():
        sm = int(r["start"][11:13]) * 60 + int(r["start"][14:16])
        em = int(r["end"][11:13]) * 60 + int(r["end"][14:16]) \
            if r["end"].startswith(today) else 1440
        obstacles.append((sm, em, r["title"] or "event"))
    obstacles.sort()
    # If now sits inside a fixed obstacle, the gap starts when it ends.
    start = now_min
    changed = True
    while changed:
        changed = False
        for sm, em, _ in obstacles:
            if sm <= start < em:
                start = em
                changed = True
    nxt = next(((sm, em, lb) for sm, em, lb in obstacles if sm > start), None)
    end = nxt[0] if nxt else 1440
    return {
        "start_minutes": start,
        "end_minutes": end,
        "minutes": max(0, end - start),
        "bounded_by": nxt[2] if nxt else "end of day",
    }


def _windows_at(conn, day_iso: str, minute: int):
    """Depth windows covering a given minute of a given day (skips honored)."""
    weekday = date.fromisoformat(day_iso).weekday()
    rows = conn.execute(
        """
        SELECT w.* FROM depth_windows w
        WHERE (w.date = ?) OR (w.date IS NULL AND w.weekday = ? AND NOT EXISTS (
            SELECT 1 FROM depth_window_skips s WHERE s.window_id = w.id AND s.date = ?))
        """, (day_iso, weekday, day_iso)
    ).fetchall()
    return [dict(r) for r in rows if r["start_minutes"] <= minute < r["end_minutes"]]


@app.get("/suggestions")
def get_suggestions(now: Optional[str] = None):
    """Good Fits Now (§3–§12): tasks that reasonably fit the current gap,
    each with transparent reasons. `now` override exists for tests."""
    now_dt = datetime.fromisoformat(now) if now else datetime.now()
    today = now_dt.date()
    conn = get_connection()
    gap = _current_gap(conn, now_dt)
    windows_now = _windows_at(conn, today.isoformat(), gap["start_minutes"])
    current_window = windows_now[0] if windows_now else None

    rows = conn.execute(
        """
        SELECT t.*,
               (SELECT MAX(completion_date) FROM completions c WHERE c.task_id = t.id) AS latest_completion
        FROM tasks t WHERE t.is_active = 1 AND t.is_paused = 0
        """
    ).fetchall()
    tasks = _attach_session_rollups(conn, [_enrich_task(dict(r), today) for r in rows])
    conn.close()

    MIN_SPLIT_GAP = 30
    suggestions = []
    for t in tasks:
        if t["is_ended"] or t["is_scheduled"]:
            continue
        est = t.get("estimated_minutes")
        if not est:
            continue  # §21: never fabricate a workload for unestimated tasks
        need = t["remaining_unscheduled_minutes"]
        if need is None or need <= 0:
            continue
        reasons = []
        if need <= gap["minutes"]:
            suggested = need
            reasons.append(f"{_fmt_minutes(need)} remaining fits the {_fmt_minutes(gap['minutes'])} gap")
        elif gap["minutes"] >= MIN_SPLIT_GAP:
            suggested = gap["minutes"]
            reasons.append(f"{_fmt_minutes(need)} remaining · supports split sessions")
            reasons.append(f"possible {_fmt_minutes(gap['minutes'])} session")
        else:
            continue  # §8: nothing misleading for tiny gaps

        due = t.get("due_date")
        due_days = None
        if due:
            due_days = (date.fromisoformat(due) - today).days
            if due_days < 0:
                reasons.append("past due")
            elif due_days == 0:
                reasons.append("due today")
            elif due_days == 1:
                reasons.append("due tomorrow")
            elif due_days <= 3:
                reasons.append(f"due in {due_days} days")

        depth_match = current_window is not None and t.get("depth") == current_window["depth"]
        urgent = due_days is not None and due_days <= 1
        if current_window is not None:
            if depth_match:
                reasons.append(f"D{t['depth']} matches the current window")
            elif current_window["protected"] and not urgent:
                # §10: suggestions generally avoid mismatches into protected
                # windows — but urgent work still surfaces, and the user can
                # always schedule anything manually.
                continue
        if (t.get("priority") or 0) >= 8:
            reasons.append(f"priority {t['priority']}")

        suggestions.append({
            "task_id": t["id"],
            "name": t["name"],
            "depth": t.get("depth"),
            "due_date": due,
            "remaining_minutes": need,
            "suggested_minutes": suggested,
            "reasons": reasons,
            "_rank": (
                due_days if (due_days is not None and due_days <= 3) else 99,
                0 if depth_match else 1,
                0 if need <= gap["minutes"] else 1,
                -(t.get("priority") or 0),
            ),
        })
    suggestions.sort(key=lambda s: s["_rank"])
    for s in suggestions:
        del s["_rank"]
    return {
        "gap": gap,
        "current_window": (
            {"depth": current_window["depth"], "protected": bool(current_window["protected"])}
            if current_window else None
        ),
        "suggestions": suggestions[:6],
    }


# ---------------------------------------------------------------------------
# Reminders (P16.0 Part VI) — actionable, computed on demand, in-app.
# Each reminder has a stable key so the client can throttle/dismiss without
# repeats. Nothing here mutates state or fires without the UI showing it.
# ---------------------------------------------------------------------------

REMINDER_SOON_MINUTES = 15
FOLLOWUP_DEFAULT_OFFSET = 30


@app.get("/reminders")
def get_reminders(now: Optional[str] = None):
    now_dt = datetime.fromisoformat(now) if now else datetime.now()
    now_stamp = now_dt.strftime("%Y-%m-%dT%H:%M")
    soon_stamp = (now_dt + timedelta(minutes=REMINDER_SOON_MINUTES)).strftime("%Y-%m-%dT%H:%M")
    today = now_dt.date()
    out = []
    conn = get_connection()

    # Sessions/entries starting soon.
    for r in conn.execute(
        """
        SELECT s.id, s.planned_start,
               CASE WHEN s.task_id IS NULL THEN s.title
                    ELSE (SELECT name FROM tasks t WHERE t.id = s.task_id) END AS label
        FROM task_sessions s
        WHERE s.status = 'scheduled' AND s.planned_start > ? AND s.planned_start <= ?
        """, (now_stamp, soon_stamp)
    ).fetchall():
        out.append({
            "type": "session_soon",
            "key": f"session_soon:{r['id']}:{r['planned_start']}",
            "title": f"{r['label']} starts at {r['planned_start'][11:16]}",
            "detail": "Scheduled session begins soon",
        })

    # External commitments starting soon.
    for r in conn.execute(
        """
        SELECT e.id, e.start, e.title, c.name AS cal FROM external_events e
        JOIN external_calendars c ON c.id = e.calendar_id
        WHERE c.visible = 1 AND e.all_day = 0 AND e.start > ? AND e.start <= ?
        """, (now_stamp, soon_stamp)
    ).fetchall():
        out.append({
            "type": "event_soon",
            "key": f"event_soon:{r['id']}:{r['start']}",
            "title": f"{r['title']} at {r['start'][11:16]}",
            "detail": f"{r['cal']} commitment begins soon",
        })

    # Unreconciled past sessions (one aggregate reminder).
    cutoff = (now_dt - timedelta(days=14)).strftime("%Y-%m-%dT%H:%M")
    unresolved = conn.execute(
        "SELECT COUNT(*) FROM task_sessions WHERE status = 'scheduled' "
        "AND planned_end < ? AND planned_end > ?",
        (now_stamp, cutoff),
    ).fetchone()[0]
    if unresolved:
        out.append({
            "type": "reconcile",
            "key": f"reconcile:{today.isoformat()}:{unresolved}",
            "title": f"{unresolved} session{'s' if unresolved != 1 else ''} need review",
            "detail": "Planned time passed without being resolved",
        })

    # Preparation incomplete before a linked event (§38) / follow-up after (§39).
    link_rows = conn.execute("SELECT * FROM task_event_links").fetchall()
    links = _enrich_task_event_links(conn, link_rows, now_stamp)
    day_ahead = (now_dt + timedelta(hours=24)).strftime("%Y-%m-%dT%H:%M")
    for l in links:
        if l["task_done"] or l["event_status"] == "cancelled" or not l["next_start"]:
            continue
        if l["relation"] == "before" and now_stamp < l["next_start"] <= day_ahead:
            offset = f" ({_fmt_minutes(l['offset_minutes'])} before)" if l["offset_minutes"] else ""
            out.append({
                "type": "prep",
                "key": f"prep:{l['id']}:{l['next_start']}",
                "title": f"Prep incomplete: {l['task_name']}",
                "detail": f"Linked event at {l['next_start'][11:16]}{offset}",
            })
        if l["relation"] == "after":
            # Most recent occurrence that already ended.
            past = conn.execute(
                "SELECT end FROM external_events WHERE calendar_id = ? AND uid = ? "
                "AND end <= ? ORDER BY end DESC LIMIT 1",
                (l["calendar_id"], l["uid"], now_stamp),
            ).fetchone()
            if past:
                offset_min = l["offset_minutes"] or FOLLOWUP_DEFAULT_OFFSET
                fire_at = (datetime.strptime(past["end"], "%Y-%m-%dT%H:%M")
                           + timedelta(minutes=offset_min)).strftime("%Y-%m-%dT%H:%M")
                day_back = (now_dt - timedelta(hours=24)).strftime("%Y-%m-%dT%H:%M")
                if day_back <= fire_at <= now_stamp:
                    out.append({
                        "type": "followup",
                        "key": f"followup:{l['id']}:{past['end']}",
                        "title": f"Follow-up pending: {l['task_name']}",
                        "detail": f"Linked event ended at {past['end'][11:16]}",
                    })

    # Moved linked events with related flexible sessions (V5.0 §3). One
    # reminder per event; the key includes the NEW start so a dismissal
    # stays dismissed until the event moves again. Offer only — the
    # proposal/apply flow lives behind /event-move-proposals.
    moved_by_event: dict = {}
    for l in links:
        if l["event_status"] == "moved" and l["next_start"] and l["event_start"]:
            moved_by_event.setdefault((l["calendar_id"], l["uid"]), []).append(l)
    for (cal_id, uid), ls in moved_by_event.items():
        movable = 0
        for l in ls:
            movable += conn.execute(
                "SELECT COUNT(*) FROM task_sessions WHERE task_id = ? "
                "AND status = 'scheduled' AND is_fixed = 0 AND planned_start >= ?",
                (l["task_id"], now_stamp),
            ).fetchone()[0]
        if not movable:
            continue
        ev = conn.execute(
            "SELECT title FROM external_events WHERE calendar_id = ? AND uid = ? "
            "ORDER BY start LIMIT 1", (cal_id, uid),
        ).fetchone()
        out.append({
            "type": "event_moved",
            "key": f"event_moved:{cal_id}:{uid}:{ls[0]['next_start']}",
            "title": f"{ev['title'] if ev else 'Linked event'} moved",
            "detail": f"Move {movable} related flexible session{'s' if movable != 1 else ''}?",
            "calendar_id": cal_id,
            "uid": uid,
            "event_start": ls[0]["next_start"],
        })

    # Deadlines approaching with unscheduled remaining effort (§19).
    task_rows = conn.execute(
        """
        SELECT t.*, (SELECT MAX(completion_date) FROM completions c WHERE c.task_id = t.id) AS latest_completion
        FROM tasks t
        WHERE t.is_active = 1 AND t.is_paused = 0 AND t.due_date IS NOT NULL
          AND t.estimated_minutes IS NOT NULL
        """
    ).fetchall()
    dl_tasks = _attach_session_rollups(conn, [_enrich_task(dict(r), today) for r in task_rows])
    horizon = (today + timedelta(days=2)).isoformat()
    for t in dl_tasks:
        gap_min = t.get("remaining_unscheduled_before_due")
        if t["is_ended"] or not gap_min:
            continue
        if today.isoformat() <= t["due_date"] <= horizon:
            out.append({
                "type": "deadline",
                "key": f"deadline:{t['id']}:{t['due_date']}",
                "title": f"{t['name']}: {_fmt_minutes(gap_min)} unscheduled before {t['due_date'][5:]}",
                "detail": "Remaining effort has no session before the deadline",
                "task_id": t["id"],
            })

    # Post-class review suggestion (§41/§42): a context-linked commitment
    # ended within the last hour. Suggestion only — nothing is created.
    hour_ago = (now_dt - timedelta(minutes=60)).strftime("%Y-%m-%dT%H:%M")
    for r in conn.execute(
        """
        SELECT e.id, e.title, e.end, ctx.id AS context_id, ctx.name AS context_name
        FROM external_events e
        JOIN external_calendars c ON c.id = e.calendar_id
        JOIN context_event_links cel ON cel.calendar_id = e.calendar_id AND cel.uid = e.uid
        JOIN contexts ctx ON ctx.id = cel.context_id
        WHERE c.visible = 1 AND e.all_day = 0 AND e.end > ? AND e.end <= ?
        """, (hour_ago, now_stamp)
    ).fetchall():
        out.append({
            "type": "class_review",
            "key": f"class_review:{r['id']}:{r['end']}",
            "title": f"{r['title']} ended — schedule review?",
            "detail": f"{r['context_name']} · review while it's fresh",
            "context_id": r["context_id"],
            "context_name": r["context_name"],
        })

    conn.close()
    return out


# ---------------------------------------------------------------------------
# Reading Sheet (P5.0) — books + page-checkpoint history
# ---------------------------------------------------------------------------

_READING_STATUSES = frozenset({"active", "finished", "archived"})

# Book priority scale (P11.0): 1 low/background · 3 normal · 5 highest.
# Deliberately 1–5 (not the task 1–10 scale) — books need coarse bands for
# color coding, not fine-grained pressure input. Priority never feeds urgency.
READING_PRIORITY_MIN, READING_PRIORITY_MAX, READING_PRIORITY_DEFAULT = 1, 5, 3


def _clamp_reading_priority(value: Optional[int]) -> int:
    try:
        p = int(value)
    except (TypeError, ValueError):
        return READING_PRIORITY_DEFAULT
    return max(READING_PRIORITY_MIN, min(READING_PRIORITY_MAX, p))


def _validate_purchase_url(raw: Optional[str]) -> str:
    """Mirror the frontend safe-link rules: http/https/mailto/www only.

    Empty is fine (no link). Anything else (javascript:, data:, file:,
    relative paths, …) is rejected with 422 so unsafe values never reach the
    database. The frontend additionally renders through normalizeSafeUrl, so
    this is defense in depth, not the only guard.
    """
    if raw is None:
        return ""
    url = raw.strip()
    if not url:
        return ""
    candidate = f"https://{url}" if url.lower().startswith("www.") else url
    m = re.match(r"^([a-zA-Z][a-zA-Z0-9+.-]*):", candidate)
    if not m or m.group(1).lower() not in ("http", "https", "mailto"):
        raise HTTPException(
            status_code=422,
            detail="purchase_url must be an http, https, mailto, or www link",
        )
    return url


class ReadingBookBody(BaseModel):
    title: Optional[str] = None
    author: Optional[str] = None
    total_pages: Optional[int] = None
    current_page: Optional[int] = None
    status: Optional[str] = None
    started_at: Optional[str] = None
    finished_at: Optional[str] = None
    notes: Optional[str] = None
    priority: Optional[int] = None
    to_buy: Optional[bool] = None
    purchase_url: Optional[str] = None
    purchase_notes: Optional[str] = None
    purchased_at: Optional[str] = None


class ReadingEntryBody(BaseModel):
    page: int
    entry_date: Optional[str] = None
    note: Optional[str] = None


class ReadingReorderBody(BaseModel):
    order: list[int]


def _clamp_page(page: Optional[int], total_pages: Optional[int]) -> int:
    """Clamp a page number to [0, total_pages]. total_pages None → no upper bound."""
    p = int(page or 0)
    if p < 0:
        p = 0
    if total_pages is not None and total_pages >= 0 and p > total_pages:
        p = total_pages
    return p


def _enrich_book(row: dict, conn) -> dict:
    """Add derived progress fields to a reading_books row."""
    b = dict(row)
    total = b.get("total_pages")
    current = b.get("current_page") or 0
    if total is not None and total > 0:
        b["percent_complete"] = round(min(100.0, current / total * 100), 1)
        b["pages_remaining"] = max(0, total - current)
    else:
        b["percent_complete"] = None
        b["pages_remaining"] = None

    last = conn.execute(
        "SELECT entry_date, page FROM reading_entries "
        "WHERE book_id = ? ORDER BY entry_date DESC, id DESC LIMIT 1",
        (b["id"],),
    ).fetchone()
    b["last_entry_date"] = last["entry_date"] if last else None
    b["last_page_logged"] = last["page"] if last else None

    # days_since_update from updated_at date (falls back to created_at).
    ref = (b.get("updated_at") or b.get("created_at") or "")[:10]
    try:
        b["days_since_update"] = max(0, (date.today() - date.fromisoformat(ref)).days)
    except (ValueError, TypeError):
        b["days_since_update"] = None
    return b


@app.get("/reading/books")
def list_reading_books():
    """All books ordered: active first, then finished, then archived; within a
    status by display_order then title. Each row includes derived progress."""
    conn = get_connection()
    status_rank = "CASE status WHEN 'active' THEN 0 WHEN 'finished' THEN 1 ELSE 2 END"
    rows = conn.execute(
        f"SELECT * FROM reading_books ORDER BY {status_rank}, display_order, title COLLATE NOCASE"
    ).fetchall()
    books = [_enrich_book(r, conn) for r in rows]
    conn.close()
    return books


@app.post("/reading/books", status_code=201)
def create_reading_book(body: ReadingBookBody):
    """Create a book. Title is required. current_page is clamped to
    [0, total_pages]; if > 0 an initial checkpoint entry seeds the history.
    to_buy=true creates a wishlist entry — no checkpoint is seeded and no
    started_at is stamped (the book has not been started)."""
    title = (body.title or "").strip()
    if not title:
        raise HTTPException(status_code=400, detail="title is required")
    total = body.total_pages
    if total is not None and total < 0:
        total = None
    current = _clamp_page(body.current_page, total)
    status = body.status if body.status in _READING_STATUSES else "active"
    priority = _clamp_reading_priority(body.priority) if body.priority is not None else READING_PRIORITY_DEFAULT
    to_buy = 1 if body.to_buy else 0
    purchase_url = _validate_purchase_url(body.purchase_url)
    now = datetime.now().isoformat()
    today = date.today().isoformat()
    if to_buy:
        current = 0
        started = None
    else:
        started = body.started_at or today

    conn = get_connection()
    with conn:
        next_order = conn.execute(
            "SELECT COALESCE(MAX(display_order), -1) + 1 FROM reading_books"
        ).fetchone()[0]
        cur = conn.execute(
            """INSERT INTO reading_books
                 (title, author, total_pages, current_page, status, started_at,
                  finished_at, notes, display_order, created_at, updated_at,
                  priority, to_buy, purchase_url, purchase_notes, purchased_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (title, (body.author or "").strip(), total, current, status, started,
             body.finished_at, (body.notes or ""), next_order, now, now,
             priority, to_buy, purchase_url, (body.purchase_notes or ""), None),
        )
        book_id = cur.lastrowid
        if current > 0:
            conn.execute(
                """INSERT INTO reading_entries
                     (book_id, entry_date, page, note, created_at, updated_at)
                   VALUES (?, ?, ?, ?, ?, ?)""",
                (book_id, today, current, "", now, now),
            )
        row = conn.execute("SELECT * FROM reading_books WHERE id = ?", (book_id,)).fetchone()
        result = _enrich_book(row, conn)
    conn.close()
    return result


@app.patch("/reading/books/{book_id}")
def update_reading_book(book_id: int, body: ReadingBookBody):
    """Update book metadata. Setting status='finished' stamps finished_at (if not
    supplied). current_page here is a metadata correction — it does NOT create a
    checkpoint entry (use POST .../entries for that). History is never deleted."""
    conn = get_connection()
    row = conn.execute("SELECT * FROM reading_books WHERE id = ?", (book_id,)).fetchone()
    if row is None:
        conn.close()
        raise HTTPException(status_code=404, detail="Book not found")
    book = dict(row)

    updates: dict = {}
    if body.title is not None:
        t = body.title.strip()
        if not t:
            conn.close()
            raise HTTPException(status_code=400, detail="title cannot be blank")
        updates["title"] = t
    if body.author is not None:
        updates["author"] = body.author.strip()
    if body.total_pages is not None:
        updates["total_pages"] = body.total_pages if body.total_pages >= 0 else None
    if body.notes is not None:
        updates["notes"] = body.notes
    if body.started_at is not None:
        updates["started_at"] = body.started_at or None
    if body.status is not None and body.status in _READING_STATUSES:
        updates["status"] = body.status
        if body.status == "finished" and not book.get("finished_at") and body.finished_at is None:
            updates["finished_at"] = date.today().isoformat()
    if body.finished_at is not None:
        updates["finished_at"] = body.finished_at or None
    if body.current_page is not None:
        total = updates.get("total_pages", book.get("total_pages"))
        updates["current_page"] = _clamp_page(body.current_page, total)
    if body.priority is not None:
        updates["priority"] = _clamp_reading_priority(body.priority)
    if body.purchase_url is not None:
        updates["purchase_url"] = _validate_purchase_url(body.purchase_url)
    if body.purchase_notes is not None:
        updates["purchase_notes"] = body.purchase_notes
    if body.purchased_at is not None:
        updates["purchased_at"] = body.purchased_at or None
    if body.to_buy is not None:
        new_to_buy = 1 if body.to_buy else 0
        updates["to_buy"] = new_to_buy
        old_to_buy = int(book.get("to_buy") or 0)
        # Mark bought (to_buy 1 → 0): stamp purchased_at (unless caller supplied
        # one) so Reports can count purchases per period. The book keeps its
        # title/author/notes and becomes a normal owned/unread library book —
        # no checkpoint entries are fabricated. Re-wishlisting clears the stamp.
        if old_to_buy == 1 and new_to_buy == 0 and body.purchased_at is None:
            updates["purchased_at"] = date.today().isoformat()
        elif old_to_buy == 0 and new_to_buy == 1:
            updates["purchased_at"] = None

    if updates:
        updates["updated_at"] = datetime.now().isoformat()
        sets = ", ".join(f"{k} = :{k}" for k in updates)
        updates["id"] = book_id
        with conn:
            conn.execute(f"UPDATE reading_books SET {sets} WHERE id = :id", updates)
    row = conn.execute("SELECT * FROM reading_books WHERE id = ?", (book_id,)).fetchone()
    result = _enrich_book(row, conn)
    conn.close()
    return result


@app.delete("/reading/books/{book_id}", status_code=200)
def delete_reading_book(book_id: int):
    """Hard-delete a book and its entries (cascade). The UI prefers Archive
    (status change) which preserves history; this is for true removal."""
    conn = get_connection()
    row = conn.execute("SELECT id FROM reading_books WHERE id = ?", (book_id,)).fetchone()
    if row is None:
        conn.close()
        raise HTTPException(status_code=404, detail="Book not found")
    with conn:
        conn.execute("DELETE FROM reading_books WHERE id = ?", (book_id,))
    conn.close()
    return {"deleted": book_id}


@app.get("/reading/books/{book_id}/entries")
def list_reading_entries(book_id: int):
    """Historical page checkpoints for a book, oldest → newest."""
    conn = get_connection()
    rows = conn.execute(
        "SELECT * FROM reading_entries WHERE book_id = ? ORDER BY entry_date, id",
        (book_id,),
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


@app.post("/reading/books/{book_id}/entries", status_code=201)
def create_reading_entry(book_id: int, body: ReadingEntryBody):
    """Log a page checkpoint (current page, not pages-read). Updates the book's
    current_page and preserves history. One checkpoint per date (upsert)."""
    conn = get_connection()
    row = conn.execute("SELECT * FROM reading_books WHERE id = ?", (book_id,)).fetchone()
    if row is None:
        conn.close()
        raise HTTPException(status_code=404, detail="Book not found")
    book = dict(row)
    page = _clamp_page(body.page, book.get("total_pages"))
    entry_date = body.entry_date or date.today().isoformat()
    now = datetime.now().isoformat()

    with conn:
        conn.execute(
            """INSERT INTO reading_entries
                 (book_id, entry_date, page, note, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?)
               ON CONFLICT(book_id, entry_date) DO UPDATE SET
                 page = excluded.page,
                 note = excluded.note,
                 updated_at = excluded.updated_at""",
            (book_id, entry_date, page, (body.note or ""), now, now),
        )
        conn.execute(
            "UPDATE reading_books SET current_page = ?, updated_at = ? WHERE id = ?",
            (page, now, book_id),
        )
        row = conn.execute("SELECT * FROM reading_books WHERE id = ?", (book_id,)).fetchone()
        result = _enrich_book(row, conn)
    conn.close()
    return result


@app.post("/reading/books/reorder", status_code=200)
def reorder_reading_books(body: ReadingReorderBody):
    """Set display_order for books in bulk from an ordered list of IDs."""
    if not body.order:
        return {"reordered": 0}
    conn = get_connection()
    with conn:
        for i, book_id in enumerate(body.order):
            conn.execute(
                "UPDATE reading_books SET display_order = ? WHERE id = ?",
                (i, book_id),
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
# Date-cell text overrides (P9.1)
#
# A row converts one exact task/date grid cell from a completion checkbox into
# a plain-text cell. Existing completion rows for that task/date are preserved
# (hidden) while the override exists; deleting the override returns the cell
# to checkbox mode with any prior completion visible again. Text is plain text
# only — the frontend never renders it as HTML.
# ---------------------------------------------------------------------------

def _validate_iso_date(value: str, field: str = "date") -> None:
    try:
        date.fromisoformat(value)
    except ValueError:
        raise HTTPException(status_code=422, detail=f"Invalid {field} format. Use YYYY-MM-DD.")


@app.get("/date-cell-overrides")
def list_date_cell_overrides(
    start: str = Query(..., description="Start date YYYY-MM-DD"),
    end: str = Query(..., description="End date YYYY-MM-DD"),
):
    """Return all date-cell overrides whose date falls in [start, end]."""
    _validate_iso_date(start, "start")
    _validate_iso_date(end, "end")
    conn = get_connection()
    rows = conn.execute(
        "SELECT task_id, date, mode, text FROM date_cell_overrides "
        "WHERE date BETWEEN ? AND ?",
        (start, end),
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


@app.put("/date-cell-overrides/{task_id}/{cell_date}", status_code=200)
def upsert_date_cell_override(task_id: int, cell_date: str, text: str = ""):
    """
    Create or update the text override for a task/date cell.

    Unlike cell notes, an empty text value KEEPS the override row — an empty
    text cell is still intentionally in text mode. Use DELETE to return the
    cell to checkbox mode.
    """
    _validate_iso_date(cell_date)
    conn = get_connection()
    if not conn.execute("SELECT id FROM tasks WHERE id = ?", (task_id,)).fetchone():
        conn.close()
        raise HTTPException(status_code=404, detail="Task not found")

    now = datetime.now().isoformat()
    existing = conn.execute(
        "SELECT id FROM date_cell_overrides WHERE task_id = ? AND date = ?",
        (task_id, cell_date),
    ).fetchone()
    with conn:
        if existing:
            conn.execute(
                "UPDATE date_cell_overrides SET text = ?, updated_at = ? "
                "WHERE task_id = ? AND date = ?",
                (text, now, task_id, cell_date),
            )
        else:
            conn.execute(
                "INSERT INTO date_cell_overrides (task_id, date, mode, text, created_at, updated_at) "
                "VALUES (?, ?, 'text', ?, ?, ?)",
                (task_id, cell_date, text, now, now),
            )
    conn.close()
    return {"task_id": task_id, "date": cell_date, "mode": "text", "text": text}


@app.delete("/date-cell-overrides/{task_id}/{cell_date}")
def delete_date_cell_override(task_id: int, cell_date: str):
    """Remove the override, returning the cell to normal checkbox mode."""
    _validate_iso_date(cell_date)
    conn = get_connection()
    existing = conn.execute(
        "SELECT id FROM date_cell_overrides WHERE task_id = ? AND date = ?",
        (task_id, cell_date),
    ).fetchone()
    if not existing:
        conn.close()
        raise HTTPException(status_code=404, detail="Override not found")
    with conn:
        conn.execute(
            "DELETE FROM date_cell_overrides WHERE task_id = ? AND date = ?",
            (task_id, cell_date),
        )
    conn.close()
    return {"deleted": True, "task_id": task_id, "date": cell_date}


class DateCellOverrideItem(BaseModel):
    task_id: int
    date: str
    text: str = ""


class DateCellOverrideBatchBody(BaseModel):
    items: list[DateCellOverrideItem]


class DateCellOverrideKey(BaseModel):
    task_id: int
    date: str


class DateCellOverrideBatchDeleteBody(BaseModel):
    items: list[DateCellOverrideKey]


MAX_OVERRIDE_BATCH = 500


def _validate_override_batch(conn, items):
    """Validate all dates and task ids up front so a batch is all-or-nothing."""
    if len(items) > MAX_OVERRIDE_BATCH:
        raise HTTPException(status_code=422, detail=f"Batch too large (max {MAX_OVERRIDE_BATCH} cells)")
    for item in items:
        _validate_iso_date(item.date)
    task_ids = {item.task_id for item in items}
    for task_id in task_ids:
        if not conn.execute("SELECT id FROM tasks WHERE id = ?", (task_id,)).fetchone():
            raise HTTPException(status_code=404, detail=f"Task {task_id} not found")


@app.post("/date-cell-overrides/batch", status_code=200)
def batch_upsert_date_cell_overrides(body: DateCellOverrideBatchBody):
    """
    Create or update text overrides for many task/date cells in one
    transaction. Used by grid range operations (convert a selected range of
    checkbox cells to blank text cells). Completion rows are never touched.
    """
    if not body.items:
        return {"updated": 0}
    conn = get_connection()
    try:
        _validate_override_batch(conn, body.items)
        now = datetime.now().isoformat()
        with conn:
            for item in body.items:
                existing = conn.execute(
                    "SELECT id FROM date_cell_overrides WHERE task_id = ? AND date = ?",
                    (item.task_id, item.date),
                ).fetchone()
                if existing:
                    conn.execute(
                        "UPDATE date_cell_overrides SET text = ?, updated_at = ? "
                        "WHERE task_id = ? AND date = ?",
                        (item.text, now, item.task_id, item.date),
                    )
                else:
                    conn.execute(
                        "INSERT INTO date_cell_overrides (task_id, date, mode, text, created_at, updated_at) "
                        "VALUES (?, ?, 'text', ?, ?, ?)",
                        (item.task_id, item.date, item.text, now, now),
                    )
    finally:
        conn.close()
    return {"updated": len(body.items)}


@app.post("/date-cell-overrides/batch-delete", status_code=200)
def batch_delete_date_cell_overrides(body: DateCellOverrideBatchDeleteBody):
    """
    Remove overrides for many task/date cells in one transaction (range
    "restore checkboxes"). Cells without an override are counted as skipped
    rather than failing the whole batch.
    """
    if not body.items:
        return {"deleted": 0, "skipped": 0}
    conn = get_connection()
    try:
        if len(body.items) > MAX_OVERRIDE_BATCH:
            raise HTTPException(status_code=422, detail=f"Batch too large (max {MAX_OVERRIDE_BATCH} cells)")
        for item in body.items:
            _validate_iso_date(item.date)
        deleted = 0
        with conn:
            for item in body.items:
                cur = conn.execute(
                    "DELETE FROM date_cell_overrides WHERE task_id = ? AND date = ?",
                    (item.task_id, item.date),
                )
                deleted += cur.rowcount
    finally:
        conn.close()
    return {"deleted": deleted, "skipped": len(body.items) - deleted}


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

    # urgency_distribution — active non-paused only. Thresholds mirror the frontend
    # shared urgency module (P4.0B: critical≥9.5, high≥8, noticeable≥5) so the
    # dashboard bins agree with the grid colours. Duplicated here (not imported)
    # because binning runs server-side over the full task set; the frontend
    # urgency.js is the canonical source and both must be kept in sync.
    dist: dict[str, int] = {"critical": 0, "high": 0, "noticeable": 0, "low": 0}
    for t in active_tasks:
        u = t["urgency"]
        if u >= 9.5:
            dist["critical"] += 1
        elif u >= 8:
            dist["high"] += 1
        elif u >= 5:
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
            -- Critical threshold mirrors the unified band model (P4.0B: ≥9.5).
            -- Note: historical snapshot rows hold urgencies computed under the
            -- V1 formula, so this heatmap re-interprets old values until new
            -- snapshots accrue under V2.
            SUM(CASE WHEN urgency >= 9.5 THEN 1 ELSE 0 END) AS critical_count
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

# Project root in dev; PyInstaller extraction dir (sys._MEIPASS) in the packaged
# sidecar, where build-sidecar.sh bundles the policy .md files via --add-data.
_DOCS_ROOT = Path(getattr(sys, "_MEIPASS", Path(__file__).parent.parent))
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

# Parent-first order; reverse it for deletion. Explicit allowlist prevents backup
# data from naming SQL tables/columns and includes every persisted workspace table.
_BACKUP_TABLES = (
    "contexts", "external_calendars", "tasks", "reading_books", "depth_windows",
    "depth_window_templates", "section_order", "academic_batches", "academic_candidates",
    "recurrence_series", "task_sessions", "recurrence_skips", "depth_window_skips",
    "external_events", "context_event_links", "task_event_links", "completions",
    "cell_notes", "date_cell_overrides", "task_hiatus_periods", "task_daily_snapshots",
    "reading_entries", "archive_snapshots",
)
_LEGACY_BACKUP_TABLES = frozenset(("tasks", "completions", "cell_notes", "archive_snapshots",
    "task_daily_snapshots", "reading_books", "reading_entries", "date_cell_overrides", "task_hiatus_periods"))


@app.get("/export/backup.json")
def export_backup():
    """
    Download all local data as a JSON file.
    Includes all tasks (active and inactive), all completions, all archive
    snapshots, and a schema version for future compatibility.
    Does not mutate the database.
    """
    conn = get_connection()
    try:
        payload = {"schema_version": 7, "exported_at": datetime.now().isoformat()}
        for table in _BACKUP_TABLES:
            payload[table] = [dict(r) for r in conn.execute(f'SELECT * FROM "{table}" ORDER BY rowid')]
        for row in payload["archive_snapshots"]:
            row["snapshot_data_json"] = json.loads(row["snapshot_data_json"])
    finally:
        conn.close()

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

_SUPPORTED_SCHEMA_VERSIONS = frozenset({1, 2, 3, 4, 5, 6, 7})


@app.post("/restore/backup.json", status_code=200)
async def restore_backup(file: UploadFile = File(...)):
    """
    Restore all data from a JSON backup produced by GET /export/backup.json.

    Before overwriting anything, a safety copy of the current DB is written to
    <db-dir>/backups/pre-restore-<timestamp>.db using the SQLite backup API.

    Supported schema_versions: 1–7. Older backups without the
    date_cell_overrides / task_hiatus_periods sections restore those as empty;
    reading books without priority/to-buy fields restore with defaults
    (priority 3, to_buy 0, empty purchase fields).
    All existing rows are deleted and replaced with backup data in a single
    transaction; if the insert phase fails the transaction rolls back and the
    safety copy lets you recover manually.
    """
    raw = await file.read()
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=400, detail=f"Invalid JSON: {exc}")

    if not isinstance(payload, dict):
        raise HTTPException(status_code=400, detail="Backup must be a JSON object")
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
    reading_books_data = payload.get("reading_books", [])
    reading_entries_data = payload.get("reading_entries", [])
    date_cell_overrides_data = payload.get("date_cell_overrides", [])
    task_hiatus_periods_data = payload.get("task_hiatus_periods", [])

    if schema_version == 7:
        if any(not isinstance(payload.get(table), list) for table in _BACKUP_TABLES):
            raise HTTPException(status_code=400, detail="Full backup is missing a workspace table")
        if any(not isinstance(row, dict) for table in _BACKUP_TABLES for row in payload[table]):
            raise HTTPException(status_code=400, detail="Backup rows must be objects")

    # Safety backup before any writes. Resolved via the database module so the
    # copy always sits next to the DB actually in use (TASKOS_DB_PATH included).
    db_path = db_config.DB_PATH
    backup_dir = db_path.parent / "backups"
    backup_dir.mkdir(parents=True, exist_ok=True)
    safety_path = backup_dir / f"pre-restore-{datetime.now().strftime('%Y%m%d-%H%M%S-%f')}.db"
    if db_path.exists():
        src = sqlite3.connect(str(db_path))
        dst = sqlite3.connect(str(safety_path))
        src.backup(dst)
        dst.close()
        src.close()

    if schema_version == 7:
        conn = get_connection()
        try:
            with conn:
                for table in reversed(_BACKUP_TABLES):
                    conn.execute(f'DELETE FROM "{table}"')
                for table in _BACKUP_TABLES:
                    allowed = {r["name"] for r in conn.execute(f'PRAGMA table_info("{table}")')}
                    for original in payload[table]:
                        row = dict(original)
                        if not row or not set(row).issubset(allowed):
                            raise ValueError(f"Invalid columns in {table}")
                        if table == "archive_snapshots" and not isinstance(row.get("snapshot_data_json"), str):
                            row["snapshot_data_json"] = json.dumps(row["snapshot_data_json"])
                        columns = ", ".join(f'"{key}"' for key in row)
                        placeholders = ", ".join("?" for _ in row)
                        conn.execute(f'INSERT INTO "{table}" ({columns}) VALUES ({placeholders})', list(row.values()))
                if conn.execute("PRAGMA foreign_key_check").fetchone():
                    raise ValueError("Backup contains broken references")
        except Exception as exc:
            raise HTTPException(status_code=400, detail=f"Restore failed: {exc}")
        finally:
            conn.close()
        return {"restored": True, "schema_version": 7, "safety_backup": str(safety_path),
                **{table: len(payload[table]) for table in _BACKUP_TABLES}}

    conn = get_connection()
    try:
        with conn:
            # Legacy files cannot contain newer tables. Clear these in dependency
            # order as restore replaces the workspace, rather than retaining stale links.
            for table in reversed(_BACKUP_TABLES):
                if table not in _LEGACY_BACKUP_TABLES:
                    conn.execute(f'DELETE FROM "{table}"')
            # Delete in dependency order (child tables first, then parent).
            conn.execute("DELETE FROM reading_entries")
            conn.execute("DELETE FROM reading_books")
            conn.execute("DELETE FROM task_daily_snapshots")
            conn.execute("DELETE FROM task_hiatus_periods")
            conn.execute("DELETE FROM date_cell_overrides")
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

            # Reading Sheet (P5.0) — books first (parent), then entries.
            for b in reading_books_data:
                conn.execute(
                    """
                    INSERT INTO reading_books (
                        id, title, author, total_pages, current_page, status,
                        started_at, finished_at, notes, display_order,
                        created_at, updated_at,
                        priority, to_buy, purchase_url, purchase_notes, purchased_at
                    ) VALUES (
                        :id, :title, :author, :total_pages, :current_page, :status,
                        :started_at, :finished_at, :notes, :display_order,
                        :created_at, :updated_at,
                        :priority, :to_buy, :purchase_url, :purchase_notes, :purchased_at
                    )
                    """,
                    {
                        "id":            b.get("id"),
                        "title":         b["title"],
                        "author":        b.get("author", ""),
                        "total_pages":   b.get("total_pages"),
                        "current_page":  b.get("current_page", 0),
                        "status":        b.get("status", "active"),
                        "started_at":    b.get("started_at"),
                        "finished_at":   b.get("finished_at"),
                        "notes":         b.get("notes", ""),
                        "display_order": b.get("display_order", 0),
                        "created_at":    b.get("created_at"),
                        "updated_at":    b.get("updated_at"),
                        # P11.0 fields — pre-v6 backups restore with defaults.
                        "priority":       b.get("priority", 3),
                        "to_buy":         b.get("to_buy", 0),
                        "purchase_url":   b.get("purchase_url", ""),
                        "purchase_notes": b.get("purchase_notes", ""),
                        "purchased_at":   b.get("purchased_at"),
                    },
                )

            for e in reading_entries_data:
                conn.execute(
                    """
                    INSERT INTO reading_entries (
                        id, book_id, entry_date, page, note, created_at, updated_at
                    ) VALUES (
                        :id, :book_id, :entry_date, :page, :note, :created_at, :updated_at
                    )
                    """,
                    {
                        "id":         e.get("id"),
                        "book_id":    e["book_id"],
                        "entry_date": e["entry_date"],
                        "page":       e.get("page", 0),
                        "note":       e.get("note", ""),
                        "created_at": e.get("created_at"),
                        "updated_at": e.get("updated_at"),
                    },
                )

            # Date-cell text overrides (P9.1, schema_version 5+). Absent in
            # older backups — the loop simply runs zero times.
            for o in date_cell_overrides_data:
                conn.execute(
                    """
                    INSERT INTO date_cell_overrides (
                        id, task_id, date, mode, text, created_at, updated_at
                    ) VALUES (
                        :id, :task_id, :date, :mode, :text, :created_at, :updated_at
                    )
                    """,
                    {
                        "id":         o.get("id"),
                        "task_id":    o["task_id"],
                        "date":       o["date"],
                        "mode":       o.get("mode", "text"),
                        "text":       o.get("text", ""),
                        "created_at": o.get("created_at"),
                        "updated_at": o.get("updated_at"),
                    },
                )

            # Hiatus periods (P11.0, schema_version 6+). Absent in older
            # backups — the loop simply runs zero times.
            for h in task_hiatus_periods_data:
                conn.execute(
                    """
                    INSERT INTO task_hiatus_periods (
                        id, task_id, start_date, end_date, created_at, updated_at
                    ) VALUES (
                        :id, :task_id, :start_date, :end_date, :created_at, :updated_at
                    )
                    """,
                    {
                        "id":         h.get("id"),
                        "task_id":    h["task_id"],
                        "start_date": h["start_date"],
                        "end_date":   h.get("end_date"),
                        "created_at": h.get("created_at"),
                        "updated_at": h.get("updated_at"),
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
        "reading_books": len(reading_books_data),
        "reading_entries": len(reading_entries_data),
        "date_cell_overrides": len(date_cell_overrides_data),
        "task_hiatus_periods": len(task_hiatus_periods_data),
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
            if active_from_val is None and date_cols:
                # Imported rows are created today; without an explicit start they
                # would vanish from the very months their date columns cover.
                active_from_val = min(date_cols)
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
            # Imported hiatus tasks get an open interval from today (P11.0).
            if status == 'hiatus':
                _open_hiatus_period(conn, task_id, today_str)

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
