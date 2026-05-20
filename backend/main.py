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
from collections import defaultdict
from contextlib import asynccontextmanager
from datetime import date, datetime, timedelta
from typing import Optional

from fastapi import FastAPI, File, HTTPException, Query, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response

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
    manual_iso = _normalize_date_override(t.get("manual_last_done_override"))
    manual = date.fromisoformat(manual_iso) if manual_iso else None
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
):
    if not 1 <= priority <= 10:
        raise HTTPException(status_code=422, detail="Priority must be between 1 and 10")
    if interval_days < 1:
        raise HTTPException(status_code=422, detail="interval_days must be >= 1")

    norm_status = _normalize_status(status)
    is_paused_val = 1 if norm_status == 'hiatus' else 0
    paused_at_val = datetime.now().isoformat() if is_paused_val else None
    active_from_val = active_from.strip() if active_from and active_from.strip() else None
    manual_override_val = _normalize_date_override(manual_last_done_override)

    conn = get_connection()
    today_str = date.today().isoformat()
    with conn:
        cursor = conn.execute(
            """
            INSERT INTO tasks (
                name, section, category, subtask, priority, interval_days,
                status, notes, created_at, is_active, is_paused, paused_at,
                manual_last_done_override, display_order, active_from
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)
            """,
            (
                name, section, category, subtask, priority, interval_days,
                norm_status, notes, today_str, is_paused_val, paused_at_val,
                manual_override_val, display_order, active_from_val,
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
):
    """Update mutable task fields. Only provided fields are changed.

    status and is_paused are always kept in sync:
    - Setting status drives is_paused (status='hiatus' → is_paused=1, status='active' → is_paused=0).
    - Setting is_paused drives status (True → status='hiatus', False → status='active').
    - If both are provided in the same request, status takes priority.
    """
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
        updates["active_from"] = active_from.strip() if active_from.strip() else None

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
    conn.close()

    payload = {
        "schema_version": 2,
        "exported_at": datetime.now().isoformat(),
        "tasks": tasks,
        "completions": completions,
        "cell_notes": cell_notes,
        "archive_snapshots": archives,
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
                 "status", "active_from", "urgency", "days_since", "notes"]

    output = io.StringIO()
    writer = csv.writer(output)
    writer.writerow(meta_cols + dates)
    for t in tasks:
        row = [
            t["name"], t.get("section", "General"), t.get("category", ""),
            t.get("subtask", ""), t["priority"], t["interval_days"], t["status"],
            t.get("active_from") or "", t["urgency"], t["days_since"], t.get("notes", ""),
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
            active_from_raw = fv("active_from")
            active_from_val = active_from_raw.strip() if active_from_raw and active_from_raw.strip() else None
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
                    manual_last_done_override, display_order, active_from
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, 0, ?)
                """,
                (
                    name_val, section, category, subtask, priority, interval_days,
                    status, notes, today_str, is_paused_val, paused_at_val,
                    manual_override, active_from_val,
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
