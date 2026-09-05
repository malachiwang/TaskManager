"""
Calendar recurrence engine (Calendar Recurring Tasks ticket).

A recurrence_series row describes a local recurring SCHEDULE ("every Tuesday
3:00–4:00 PM"), for either sessions of one canonical task (task_id set) or a
calendar-only entry (task_id NULL + title). This is scheduling recurrence —
"work happens at these times" — and is deliberately distinct from the Grid's
tasks.interval_days pressure recurrence ("obligation exists on these dates").

Occurrences are ordinary task_sessions rows, materialized lazily over
whatever window the calendar asks for (plus series-start→today, so missed
past occurrences always exist for reconciliation). Identity is deterministic:
(series_id, occurrence_date) — a partial UNIQUE index makes regeneration
duplicate-proof no matter how often a window is refetched.

Exceptions:
  - moved/edited single occurrence → the row stays, series_detached = 1;
    its slot is taken, so nothing regenerates on that date.
  - deleted single occurrence → recurrence_skips row; the slot is never
    regenerated (same pattern as depth_window_skips).

Times are the app's local-naive "YYYY-MM-DDTHH:MM" wall-clock strings, so a
3 PM series stays 3 PM across DST by construction.
"""
import json
from datetime import date, datetime, timedelta

# Never enumerate more than ~2 years in one call, whatever the caller asks
# for. The calendar's widest fetch is today+365; this is a safety net, not a
# tuning knob.
MAX_ENUMERATION_DAYS = 750


def _monday_of(d: date) -> date:
    return d - timedelta(days=d.weekday())


def parse_weekdays(raw) -> list:
    """weekdays JSON column → sorted unique list of ints 0=Mon…6=Sun."""
    if isinstance(raw, str):
        try:
            raw = json.loads(raw or "[]")
        except ValueError:
            raw = []
    days = sorted({int(w) for w in (raw or []) if 0 <= int(w) <= 6})
    return days


def occurrence_dates(series: dict, window_start: date, window_end: date) -> list:
    """All occurrence dates of `series` within [window_start, window_end]
    (inclusive), honoring start_date, weekdays, interval_weeks, until_date and
    count. Skips are NOT applied here — a skipped date still consumes its
    slot, it just materializes nothing."""
    start = date.fromisoformat(series["start_date"])
    weekdays = parse_weekdays(series["weekdays"])
    if not weekdays:
        return []
    interval = max(1, int(series["interval_weeks"] or 1))
    until = date.fromisoformat(series["until_date"]) if series.get("until_date") else None
    count = series.get("count")

    end = window_end
    if until is not None and until < end:
        end = until
    hard_cap = start + timedelta(days=MAX_ENUMERATION_DAYS)
    if end > hard_cap:
        end = hard_cap
    if end < start:
        return []

    # Slot indices are counted from start_date so `count` stays deterministic
    # regardless of the requested window.
    out = []
    base_week = _monday_of(start)
    slot = 0
    d = start
    while d <= end:
        if d.weekday() in weekdays and ((_monday_of(d) - base_week).days // 7) % interval == 0:
            slot += 1
            if count is not None and slot > int(count):
                break
            if d >= window_start:
                out.append(d)
        d += timedelta(days=1)
    return out


def _planned_strings(day: date, start_minutes: int, duration_minutes: int):
    """(planned_start, planned_end) local-naive strings; ends past midnight
    roll into the next day, matching the frontend's combinePlannedEnd."""
    sm = int(start_minutes)
    em = sm + int(duration_minutes)
    start_s = f"{day.isoformat()}T{sm // 60:02d}:{sm % 60:02d}"
    end_day = day + timedelta(days=em // 1440) if em >= 1440 else day
    em_rem = em % 1440
    if em >= 1440 and em_rem == 0:
        end_s = f"{end_day.isoformat()}T00:00"
    elif em >= 1440:
        end_s = f"{end_day.isoformat()}T{em_rem // 60:02d}:{em_rem % 60:02d}"
    else:
        end_s = f"{day.isoformat()}T{em // 60:02d}:{em % 60:02d}"
    return start_s, end_s


def materialize_window(conn, window_start: date, window_end: date, today: date) -> int:
    """Ensure every due occurrence of every series exists as a task_sessions
    row for [window_start, window_end]. Past occurrences (series start→today)
    are always materialized too, so unresolved ones reach reconciliation even
    if their week was never viewed. Returns the number of rows inserted.

    Duplicate-safe: existing (series_id, occurrence_date) rows — including
    moved/detached ones — and recurrence_skips slots are left alone, and the
    partial UNIQUE index backstops any race."""
    gen_end = max(window_end, today)
    series_rows = conn.execute(
        "SELECT rs.*, t.is_active AS task_is_active, t.end_date AS task_end_date "
        "FROM recurrence_series rs LEFT JOIN tasks t ON t.id = rs.task_id"
    ).fetchall()
    inserted = 0
    now_iso = datetime.now().isoformat()
    for row in series_rows:
        s = dict(row)
        if s["task_id"] is not None and not s["task_is_active"]:
            continue  # soft-deleted task: never generate
        dates = occurrence_dates(s, date.fromisoformat(s["start_date"]), gen_end)
        if not dates:
            continue
        # Finished task semantics: no occurrences past the task's end_date.
        task_end = s.get("task_end_date")
        if s["task_id"] is not None and task_end:
            dates = [d for d in dates if d.isoformat() <= task_end]
        existing = {
            r["occurrence_date"]
            for r in conn.execute(
                "SELECT occurrence_date FROM task_sessions WHERE series_id = ?",
                (s["id"],),
            )
        }
        skipped = {
            r["date"]
            for r in conn.execute(
                "SELECT date FROM recurrence_skips WHERE series_id = ?",
                (s["id"],),
            )
        }
        for d in dates:
            iso = d.isoformat()
            if iso in existing or iso in skipped:
                continue
            ps, pe = _planned_strings(d, s["start_minutes"], s["duration_minutes"])
            conn.execute(
                "INSERT OR IGNORE INTO task_sessions "
                "(task_id, title, depth, context_id, planned_start, planned_end, "
                " is_fixed, series_id, occurrence_date, created_at, updated_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (s["task_id"], s["title"] if s["task_id"] is None else "",
                 s["depth"] if s["task_id"] is None else None,
                 s["context_id"] if s["task_id"] is None else None,
                 ps, pe, s["is_fixed"], s["id"], iso, now_iso, now_iso),
            )
            inserted += 1
    if inserted:
        conn.commit()
    return inserted


def prune_unexecuted(conn, series_id: int, from_date_iso: str, *, include_detached: bool = False) -> int:
    """Delete this series' still-scheduled, never-executed occurrence rows on
    or after from_date_iso. Executed truth (completed/partial/skipped rows,
    anything with actual data) is never touched; individually-moved
    (detached) occurrences survive unless include_detached is set."""
    q = (
        "DELETE FROM task_sessions WHERE series_id = ? AND occurrence_date >= ? "
        "AND status = 'scheduled' AND actual_start IS NULL AND actual_end IS NULL "
        "AND actual_minutes IS NULL"
    )
    if not include_detached:
        q += " AND series_detached = 0"
    cur = conn.execute(q, (series_id, from_date_iso))
    return cur.rowcount


def describe(series: dict) -> str:
    """Compact human-readable rule summary — "Every Tuesday", "Every Mon,
    Wed, Fri", "Every 2 weeks on Wednesday", with end condition appended."""
    names = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
    weekdays = parse_weekdays(series["weekdays"])
    interval = max(1, int(series.get("interval_weeks") or 1))
    if weekdays == [0, 1, 2, 3, 4, 5, 6] and interval == 1:
        label = "Every day"
    elif weekdays == [0, 1, 2, 3, 4] and interval == 1:
        label = "Every weekday"
    else:
        full = {
            0: "Monday", 1: "Tuesday", 2: "Wednesday", 3: "Thursday",
            4: "Friday", 5: "Saturday", 6: "Sunday",
        }
        day_part = (full[weekdays[0]] if len(weekdays) == 1
                    else ", ".join(names[w] for w in weekdays))
        if interval == 1:
            label = f"Every {day_part}"
        else:
            label = f"Every {interval} weeks on {day_part}"
    if series.get("until_date"):
        d = date.fromisoformat(series["until_date"])
        label += f" · until {names_month(d)}"
    elif series.get("count"):
        label += f" · {series['count']}×"
    return label


def names_month(d: date) -> str:
    months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
              "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
    return f"{months[d.month - 1]} {d.day}"
