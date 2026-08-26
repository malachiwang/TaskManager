"""
Execution analytics (V5.4 / Semester OS V5 Parts IX–XII).

Factual arithmetic over recorded history — planned vs actual, estimate
accuracy, behavioral patterns, and forward load. Hard rules carried from
the product philosophy:

  • no composite productivity/efficiency score, ever (§42)
  • no inferred biological capacity (§48) — only user-declared facts
  • medians + sample counts over averages (§36)
  • below MIN_SAMPLE a group says "not enough history yet" instead of
    pretending statistical confidence (§41)
  • calendar-only entries are reported separately from Grid work unless the
    caller deliberately includes them (§33)
  • forecasts separate Fixed commitments from Flexible estimated work (§46)
    and their drilldowns sum exactly to the headline (§65)

Every function is pure given a connection + explicit dates, so tests can
freeze the clock.
"""
from datetime import date, timedelta
from statistics import median

MIN_SAMPLE = 5

_PLANNED_MIN = ("CAST(ROUND((julianday(planned_end) - julianday(planned_start)) "
                "* 1440) AS INTEGER)")


def _actual_of(row) -> int:
    """Actual minutes credited to a session (matches rollup semantics)."""
    if row["status"] == "completed":
        if row["actual_minutes"] is not None:
            return row["actual_minutes"]
        return row["planned_minutes"]
    if row["status"] == "partial":
        return row["actual_minutes"] or 0
    return 0


def _fetch_sessions(conn, start_iso, end_iso):
    return [dict(r) for r in conn.execute(
        f"""
        SELECT s.*, {_PLANNED_MIN} AS planned_minutes,
               CASE WHEN s.task_id IS NULL THEN s.title ELSE t.name END AS name,
               CASE WHEN s.task_id IS NULL THEN s.depth ELSE t.depth END AS eff_depth,
               CASE WHEN s.task_id IS NULL THEN s.context_id ELSE t.context_id END AS eff_context_id
        FROM task_sessions s
        LEFT JOIN tasks t ON t.id = s.task_id
        WHERE (s.task_id IS NULL OR t.is_active = 1)
          AND s.planned_start >= ? AND s.planned_start <= ?
        ORDER BY s.planned_start, s.id
        """, (start_iso + "T00:00", end_iso + "T23:59")).fetchall()]


def execution_report(conn, start_iso, end_iso, include_entries=False):
    """Planned vs actual for sessions whose planned start falls in range
    (§32–§34). Grid-linked sessions carry the headline; calendar-only
    entries are totaled separately unless deliberately included."""
    rows = _fetch_sessions(conn, start_iso, end_iso)
    ctx_names = {r["id"]: r["name"] for r in conn.execute(
        "SELECT id, name FROM contexts").fetchall()}

    headline = {"planned_minutes": 0, "actual_minutes": 0}
    entries = {"planned_minutes": 0, "actual_minutes": 0}
    by_day: dict = {}
    by_depth: dict = {}
    by_context: dict = {}
    by_task: dict = {}
    log = []

    for s in rows:
        actual = _actual_of(s)
        planned = s["planned_minutes"]
        is_entry = s["task_id"] is None
        bucket = entries if (is_entry and not include_entries) else headline
        bucket["planned_minutes"] += planned
        bucket["actual_minutes"] += actual

        counts = not is_entry or include_entries
        if counts:
            day = s["planned_start"][:10]
            d = by_day.setdefault(day, {"date": day, "planned_minutes": 0, "actual_minutes": 0})
            d["planned_minutes"] += planned
            d["actual_minutes"] += actual
            dk = s["eff_depth"] or 0
            dd = by_depth.setdefault(dk, {"depth": dk, "planned_minutes": 0, "actual_minutes": 0})
            dd["planned_minutes"] += planned
            dd["actual_minutes"] += actual
            ck = s["eff_context_id"]
            cc = by_context.setdefault(ck, {
                "context_id": ck, "context_name": ctx_names.get(ck),
                "planned_minutes": 0, "actual_minutes": 0})
            cc["planned_minutes"] += planned
            cc["actual_minutes"] += actual
        if not is_entry:
            tt = by_task.setdefault(s["task_id"], {
                "task_id": s["task_id"], "name": s["name"],
                "planned_minutes": 0, "actual_minutes": 0, "sessions": 0})
            tt["planned_minutes"] += planned
            tt["actual_minutes"] += actual
            tt["sessions"] += 1

        log.append({
            "id": s["id"],
            "task_id": s["task_id"],
            "name": s["name"],
            "is_entry": is_entry,
            "status": s["status"],
            "depth": s["eff_depth"],
            "context_name": ctx_names.get(s["eff_context_id"]),
            "planned_start": s["planned_start"],
            "planned_end": s["planned_end"],
            "planned_minutes": planned,
            "actual_start": s["actual_start"],
            "actual_end": s["actual_end"],
            "actual_minutes": actual if s["status"] in ("completed", "partial") else None,
        })

    return {
        "start": start_iso,
        "end": end_iso,
        "include_entries": bool(include_entries),
        **headline,
        "entries_planned_minutes": entries["planned_minutes"],
        "entries_actual_minutes": entries["actual_minutes"],
        "by_day": sorted(by_day.values(), key=lambda x: x["date"]),
        "by_depth": sorted(by_depth.values(), key=lambda x: x["depth"]),
        "by_context": sorted(by_context.values(),
                             key=lambda x: -(x["planned_minutes"])),
        "by_task": sorted(by_task.values(), key=lambda x: -(x["planned_minutes"])),
        "log": log,
    }


def _ratio_group(pairs):
    """pairs: [(planned/estimated, actual)] → robust summary or
    insufficient-data marker (§36/§41)."""
    n = len(pairs)
    if n < MIN_SAMPLE:
        return {"n": n, "insufficient": True}
    ratios = [a / p for (p, a) in pairs if p > 0]
    if len(ratios) < MIN_SAMPLE:
        return {"n": n, "insufficient": True}
    return {
        "n": n,
        "insufficient": False,
        "median_planned_minutes": round(median(p for (p, _) in pairs)),
        "median_actual_minutes": round(median(a for (_, a) in pairs)),
        "median_ratio": round(median(ratios), 2),
    }


def estimates_report(conn, today_iso):
    """Estimate accuracy (§35–§37): session planned-vs-actual by depth, and
    task estimate-vs-logged for finished tasks — overall and by context.
    Informational only; nothing here rewrites an estimate."""
    sess_rows = [dict(r) for r in conn.execute(
        f"""
        SELECT s.*, {_PLANNED_MIN} AS planned_minutes,
               CASE WHEN s.task_id IS NULL THEN s.depth ELSE t.depth END AS eff_depth
        FROM task_sessions s
        LEFT JOIN tasks t ON t.id = s.task_id
        WHERE s.status IN ('completed', 'partial')
          AND s.actual_minutes IS NOT NULL
        """).fetchall()]
    by_depth: dict = {}
    for s in sess_rows:
        by_depth.setdefault(s["eff_depth"] or 0, []).append(
            (s["planned_minutes"], s["actual_minutes"]))

    task_rows = [dict(r) for r in conn.execute(
        """
        SELECT t.id, t.name, t.context_id, t.estimated_minutes, t.end_date,
               c.name AS context_name,
               (SELECT MAX(completion_date) FROM completions x WHERE x.task_id = t.id) AS latest_completion,
               (SELECT COALESCE(SUM(CASE
                     WHEN s.status = 'completed' THEN COALESCE(s.actual_minutes,
                          CAST(ROUND((julianday(s.planned_end) - julianday(s.planned_start)) * 1440) AS INTEGER))
                     WHEN s.status = 'partial' THEN COALESCE(s.actual_minutes, 0)
                     ELSE 0 END), 0)
                FROM task_sessions s WHERE s.task_id = t.id) AS logged
        FROM tasks t LEFT JOIN contexts c ON c.id = t.context_id
        WHERE t.is_active = 1 AND t.estimated_minutes IS NOT NULL AND t.estimated_minutes > 0
        """).fetchall()]
    finished = [t for t in task_rows if t["logged"] > 0 and (
        (t["end_date"] and t["end_date"] <= today_iso) or t["latest_completion"])]
    by_context: dict = {}
    overall = []
    for t in finished:
        pair = (t["estimated_minutes"], t["logged"])
        overall.append(pair)
        by_context.setdefault(t["context_name"] or "(no context)", []).append(pair)

    return {
        "min_sample": MIN_SAMPLE,
        "sessions_by_depth": [
            {"depth": d, **_ratio_group(pairs)}
            for d, pairs in sorted(by_depth.items())
        ],
        "tasks_overall": _ratio_group(overall),
        "tasks_by_context": [
            {"context_name": name, **_ratio_group(pairs)}
            for name, pairs in sorted(by_context.items())
        ],
    }


_DAYPART_BOUNDS = (("morning", 0, 12 * 60), ("afternoon", 12 * 60, 17 * 60),
                   ("evening", 17 * 60, 24 * 60))
_WEEKDAY_NAMES = ("Monday", "Tuesday", "Wednesday", "Thursday", "Friday",
                  "Saturday", "Sunday")


def patterns_report(conn):
    """Behavioral calibration (§38–§41): historical observations with sample
    counts. Groups under MIN_SAMPLE report insufficient data instead of a
    rate — no fabricated confidence, no universal score (§42)."""
    rows = [dict(r) for r in conn.execute(
        f"""
        SELECT s.*, {_PLANNED_MIN} AS planned_minutes,
               CASE WHEN s.task_id IS NULL THEN s.depth ELSE t.depth END AS eff_depth,
               CASE WHEN s.task_id IS NULL THEN s.context_id ELSE t.context_id END AS eff_context_id
        FROM task_sessions s
        LEFT JOIN tasks t ON t.id = s.task_id
        WHERE s.status IN ('completed', 'partial', 'skipped')
        """).fetchall()]
    ctx_names = {r["id"]: r["name"] for r in conn.execute(
        "SELECT id, name FROM contexts").fetchall()}

    # Time-of-day × depth: share of resolved sessions completed as planned.
    tod: dict = {}
    for s in rows:
        h = int(s["planned_start"][11:13]) * 60 + int(s["planned_start"][14:16])
        part = next(name for name, lo, hi in _DAYPART_BOUNDS if lo <= h < hi)
        key = (s["eff_depth"] or 0, part)
        g = tod.setdefault(key, {"n": 0, "completed": 0})
        g["n"] += 1
        if s["status"] == "completed":
            g["completed"] += 1
    time_of_day = []
    for (depth, part), g in sorted(tod.items()):
        entry = {"depth": depth, "part": part, "n": g["n"]}
        if g["n"] < MIN_SAMPLE:
            entry["insufficient"] = True
        else:
            entry["insufficient"] = False
            entry["completed_share"] = round(g["completed"] / g["n"], 2)
        time_of_day.append(entry)

    # Weekday: median ACTUAL minutes per day-with-work (§39 — "n Tuesdays").
    daily: dict = {}
    for s in rows:
        day = s["planned_start"][:10]
        daily.setdefault(day, 0)
        daily[day] += _actual_of(s)
    per_weekday: dict = {}
    for day, minutes in daily.items():
        wd = date.fromisoformat(day).weekday()
        per_weekday.setdefault(wd, []).append(minutes)
    weekday = []
    for wd in range(7):
        totals = per_weekday.get(wd, [])
        entry = {"weekday": wd, "name": _WEEKDAY_NAMES[wd], "n_days": len(totals)}
        if len(totals) < MIN_SAMPLE:
            entry["insufficient"] = True
        else:
            entry["insufficient"] = False
            entry["median_actual_minutes"] = round(median(totals))
        weekday.append(entry)

    # Context: median overrun ratio for completed sessions with actuals (§40).
    per_ctx: dict = {}
    for s in rows:
        if s["status"] != "completed" or s["actual_minutes"] is None:
            continue
        if s["planned_minutes"] <= 0:
            continue
        per_ctx.setdefault(s["eff_context_id"], []).append(
            s["actual_minutes"] / s["planned_minutes"])
    context = []
    for ctx_id, ratios in per_ctx.items():
        entry = {"context_id": ctx_id, "context_name": ctx_names.get(ctx_id),
                 "n": len(ratios)}
        if len(ratios) < MIN_SAMPLE:
            entry["insufficient"] = True
        else:
            entry["insufficient"] = False
            entry["median_ratio"] = round(median(ratios), 2)
        context.append(entry)

    return {
        "min_sample": MIN_SAMPLE,
        "time_of_day": time_of_day,
        "weekday": weekday,
        "context": sorted(context, key=lambda x: -(x["n"])),
    }


def forecast_report(conn, now_dt, weeks=8):
    """Upcoming weekly load (§43–§48). Facts only:
      fixed_minutes              external commitments + fixed sessions/entries
      scheduled_flexible_minutes flexible scheduled sessions in that week
      due_remaining_minutes      unscheduled remaining effort of tasks whose
                                 deadline falls in that week (overdue work
                                 lands in the current week, flagged)
    Drilldown items sum exactly to the flexible totals (§65). Tasks with
    remaining effort but no deadline are listed separately — their week is
    unknown and the forecast never invents one."""
    today = now_dt.date()
    week_start = today - timedelta(days=(today.weekday() + 1) % 7)  # Sunday
    now_stamp = now_dt.strftime("%Y-%m-%dT%H:%M")
    horizon_end = week_start + timedelta(days=7 * weeks - 1)

    week_windows = []
    for i in range(weeks):
        ws = week_start + timedelta(days=7 * i)
        week_windows.append({
            "week_start": ws.isoformat(),
            "week_end": (ws + timedelta(days=6)).isoformat(),
            "fixed_minutes": 0,
            "scheduled_flexible_minutes": 0,
            "due_remaining_minutes": 0,
            "flexible_minutes": 0,
            "depth_minutes": {"1": 0, "2": 0, "3": 0, "0": 0},
            "items": [],
        })

    def week_of(iso_day):
        d = date.fromisoformat(iso_day)
        idx = (d - week_start).days // 7
        return week_windows[idx] if 0 <= idx < weeks else None

    # Fixed: external events (visible calendars) + fixed sessions/entries.
    for r in conn.execute(
        f"""
        SELECT e.start, CAST(ROUND((julianday(e.end) - julianday(e.start)) * 1440) AS INTEGER) AS minutes
        FROM external_events e JOIN external_calendars c ON c.id = e.calendar_id
        WHERE c.visible = 1 AND e.all_day = 0 AND e.start >= ? AND e.start <= ?
        """, (week_start.isoformat() + "T00:00", horizon_end.isoformat() + "T23:59")
    ).fetchall():
        w = week_of(r["start"][:10])
        if w:
            w["fixed_minutes"] += max(0, r["minutes"] or 0)
    for r in conn.execute(
        f"""
        SELECT s.planned_start, s.is_fixed, s.status, {_PLANNED_MIN} AS minutes,
               CASE WHEN s.task_id IS NULL THEN s.title ELSE t.name END AS name,
               CASE WHEN s.task_id IS NULL THEN s.depth ELSE t.depth END AS eff_depth
        FROM task_sessions s LEFT JOIN tasks t ON t.id = s.task_id
        WHERE (s.task_id IS NULL OR t.is_active = 1)
          AND s.status = 'scheduled' AND s.planned_start >= ? AND s.planned_start <= ?
        """, (now_stamp, horizon_end.isoformat() + "T23:59")
    ).fetchall():
        w = week_of(r["planned_start"][:10])
        if not w:
            continue
        if r["is_fixed"]:
            w["fixed_minutes"] += r["minutes"]
        else:
            w["scheduled_flexible_minutes"] += r["minutes"]
            w["depth_minutes"][str(r["eff_depth"] or 0)] += r["minutes"]
            w["items"].append({"type": "scheduled", "name": r["name"],
                               "minutes": r["minutes"],
                               "date": r["planned_start"][:10]})

    # Remaining unscheduled effort lands in its deadline's week (§65 —
    # logged work excluded, scheduled coverage subtracted, no double count).
    undated = []
    for t in conn.execute(
        """
        SELECT t.id, t.name, t.depth, t.due_date, t.estimated_minutes,
               c.name AS context_name,
               (SELECT COALESCE(SUM(CASE
                     WHEN s.status = 'completed' THEN COALESCE(s.actual_minutes,
                          CAST(ROUND((julianday(s.planned_end) - julianday(s.planned_start)) * 1440) AS INTEGER))
                     WHEN s.status = 'partial' THEN COALESCE(s.actual_minutes, 0)
                     ELSE 0 END), 0) FROM task_sessions s WHERE s.task_id = t.id) AS logged,
               (SELECT COALESCE(SUM(CASE WHEN s.status = 'scheduled' THEN
                          CAST(ROUND((julianday(s.planned_end) - julianday(s.planned_start)) * 1440) AS INTEGER)
                     ELSE 0 END), 0) FROM task_sessions s WHERE s.task_id = t.id) AS pending
        FROM tasks t LEFT JOIN contexts c ON c.id = t.context_id
        WHERE t.is_active = 1 AND t.is_paused = 0
          AND t.estimated_minutes IS NOT NULL AND t.estimated_minutes > 0
          AND (t.end_date IS NULL OR t.end_date > ?)
        """, (today.isoformat(),)
    ).fetchall():
        remaining = max(0, t["estimated_minutes"] - t["logged"] - t["pending"])
        if remaining <= 0:
            continue
        item = {"type": "due_remaining", "task_id": t["id"], "name": t["name"],
                "context_name": t["context_name"], "minutes": remaining,
                "due_date": t["due_date"]}
        if not t["due_date"]:
            undated.append(item)
            continue
        due = date.fromisoformat(t["due_date"])
        if due > horizon_end:
            continue
        target = due if due >= week_start else today
        w = week_of(target.isoformat())
        if not w:
            continue
        if due < today:
            item["overdue"] = True
        w["due_remaining_minutes"] += remaining
        w["depth_minutes"][str(t["depth"] or 0)] += remaining
        w["items"].append(item)

    for w in week_windows:
        w["flexible_minutes"] = w["scheduled_flexible_minutes"] + w["due_remaining_minutes"]

    return {
        "now": now_stamp,
        "weeks": week_windows,
        "undated": {
            "total_minutes": sum(i["minutes"] for i in undated),
            "items": sorted(undated, key=lambda x: -x["minutes"]),
        },
    }
