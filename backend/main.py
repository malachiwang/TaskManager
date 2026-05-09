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
    section: str = "General",
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
                name, section, category, subtask, priority, interval_days,
                status, notes, created_at, is_active, is_paused,
                manual_last_done_override, display_order
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, ?, ?)
            """,
            (
                name, section, category, subtask, priority, interval_days,
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
    if name is not None:
        updates["name"] = name
    if section is not None:
        updates["section"] = section
    if category is not None:
        updates["category"] = category
    if subtask is not None:
        updates["subtask"] = subtask
    if status is not None:
        updates["status"] = status
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

    for t in tasks:
        t["completions"] = comp_map.get(t["id"], {})

    snapshot = {"start_date": start_date, "end_date": end_date, "tasks": tasks}
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
    archive_rows = conn.execute("SELECT * FROM archive_snapshots").fetchall()
    archives = []
    for r in archive_rows:
        row = dict(r)
        row["snapshot_data_json"] = json.loads(row["snapshot_data_json"])
        archives.append(row)
    conn.close()

    payload = {
        "schema_version": 1,
        "exported_at": datetime.now().isoformat(),
        "tasks": tasks,
        "completions": completions,
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
                 "status", "urgency", "days_since", "notes"]

    output = io.StringIO()
    writer = csv.writer(output)
    writer.writerow(meta_cols + dates)
    for t in tasks:
        row = [
            t["name"], t.get("section", "General"), t.get("category", ""),
            t.get("subtask", ""), t["priority"], t["interval_days"], t["status"],
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
            status = fv("status") or "active"
            notes = fv("notes") or ""
            manual_override = fv("manual_last_done_override")

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
                    status, notes, created_at, is_active, is_paused,
                    manual_last_done_override, display_order
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, ?, 0)
                """,
                (
                    name_val, section, category, subtask, priority, interval_days,
                    status, notes, today_str, manual_override,
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
