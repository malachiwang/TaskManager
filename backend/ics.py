"""
Minimal iCalendar (RFC 5545) parsing for read-only external commitments.

Scope (P15.0): the subset Google Calendar's secret iCal address and typical
class/meeting feeds actually use —
  - VEVENT with DTSTART / DTEND / DURATION / SUMMARY / UID
  - UTC ("...Z"), TZID=<zone> (via stdlib zoneinfo), floating local times,
    and VALUE=DATE all-day events
  - RRULE FREQ=WEEKLY (BYDAY, INTERVAL, COUNT, UNTIL) and FREQ=DAILY —
    other frequencies fall back to the base occurrence only
  - EXDATE exceptions and RECURRENCE-ID occurrence overrides

Everything returns LOCAL-NAIVE "YYYY-MM-DDTHH:MM" strings to match the rest
of the app. Pure functions, no network — callers fetch the feed text.
"""
from datetime import date, datetime, timedelta

try:
    from zoneinfo import ZoneInfo
except ImportError:  # pragma: no cover — Python < 3.9
    ZoneInfo = None

# Hard caps so a malformed feed can never wedge the app.
MAX_OCCURRENCES_PER_EVENT = 500
MAX_EVENTS = 5000

_WEEKDAYS = {"MO": 0, "TU": 1, "WE": 2, "TH": 3, "FR": 4, "SA": 5, "SU": 6}


def _unfold(text: str) -> list[str]:
    """RFC 5545 line unfolding: a line starting with space/tab continues the
    previous line."""
    lines: list[str] = []
    for raw in text.replace("\r\n", "\n").replace("\r", "\n").split("\n"):
        if raw[:1] in (" ", "\t") and lines:
            lines[-1] += raw[1:]
        else:
            lines.append(raw)
    return lines


def _unescape(value: str) -> str:
    return (value.replace("\\n", " ").replace("\\N", " ")
            .replace("\\,", ",").replace("\\;", ";").replace("\\\\", "\\"))


def _split_prop(line: str):
    """'NAME;PARAM=V;PARAM2=V2:value' → (name, {param: v}, value)."""
    head, _, value = line.partition(":")
    parts = head.split(";")
    name = parts[0].upper()
    params = {}
    for p in parts[1:]:
        k, _, v = p.partition("=")
        params[k.upper()] = v
    return name, params, value


def _parse_dt(value: str, params: dict):
    """Parse an iCal date/date-time → (datetime local-naive, all_day).

    UTC and TZID-aware values convert to the machine's local time; floating
    values are taken as already local; VALUE=DATE yields midnight + all_day.
    Unparseable input returns (None, False).
    """
    value = value.strip()
    try:
        if params.get("VALUE") == "DATE" or (len(value) == 8 and value.isdigit()):
            return datetime.strptime(value, "%Y%m%d"), True
        if value.endswith("Z"):
            dt = datetime.strptime(value[:-1], "%Y%m%dT%H%M%S")
            if ZoneInfo is not None:
                dt = dt.replace(tzinfo=ZoneInfo("UTC")).astimezone().replace(tzinfo=None)
            return dt, False
        dt = datetime.strptime(value, "%Y%m%dT%H%M%S")
        tzid = params.get("TZID")
        if tzid and ZoneInfo is not None:
            try:
                dt = dt.replace(tzinfo=ZoneInfo(tzid)).astimezone().replace(tzinfo=None)
            except Exception:
                pass  # unknown zone → treat as local
        return dt, False
    except ValueError:
        return None, False


def _parse_duration(value: str):
    """'PT1H30M' / 'P1D' → timedelta, or None."""
    value = value.strip().upper()
    if not value.startswith(("P", "+P", "-P")):
        return None
    sign = -1 if value.startswith("-") else 1
    value = value.lstrip("+-")[1:]
    days = hours = minutes = seconds = 0
    num = ""
    in_time = False
    for ch in value:
        if ch == "T":
            in_time = True
        elif ch.isdigit():
            num += ch
        elif ch == "W" and num:
            days += int(num) * 7; num = ""
        elif ch == "D" and num:
            days += int(num); num = ""
        elif ch == "H" and num and in_time:
            hours = int(num); num = ""
        elif ch == "M" and num and in_time:
            minutes = int(num); num = ""
        elif ch == "S" and num and in_time:
            seconds = int(num); num = ""
        else:
            num = ""
    return sign * timedelta(days=days, hours=hours, minutes=minutes, seconds=seconds)


def _parse_rrule(value: str) -> dict:
    rule = {}
    for part in value.split(";"):
        k, _, v = part.partition("=")
        rule[k.upper()] = v
    return rule


def parse_ics(text: str) -> list[dict]:
    """Parse VEVENTs. Each event dict:
    { uid, summary, start (datetime), end (datetime), all_day,
      rrule (dict|None), exdates (set[datetime]), recurrence_id (datetime|None) }
    """
    events = []
    current = None
    for line in _unfold(text):
        if line.startswith("BEGIN:VEVENT"):
            current = {"uid": "", "summary": "", "start": None, "end": None,
                       "all_day": False, "rrule": None, "exdates": set(),
                       "recurrence_id": None, "duration": None,
                       "cancelled": False}
            continue
        if line.startswith("END:VEVENT"):
            if current is not None and current["start"] is not None:
                if current["end"] is None:
                    if current["duration"] is not None:
                        current["end"] = current["start"] + current["duration"]
                    elif current["all_day"]:
                        current["end"] = current["start"] + timedelta(days=1)
                    else:
                        current["end"] = current["start"]
                if not current["cancelled"]:
                    events.append(current)
            current = None
            if len(events) >= MAX_EVENTS:
                break
            continue
        if current is None or ":" not in line:
            continue
        name, params, value = _split_prop(line)
        if name == "UID":
            current["uid"] = value.strip()
        elif name == "SUMMARY":
            current["summary"] = _unescape(value).strip()
        elif name == "DTSTART":
            current["start"], current["all_day"] = _parse_dt(value, params)
        elif name == "DTEND":
            current["end"], _ = _parse_dt(value, params)
        elif name == "DURATION":
            current["duration"] = _parse_duration(value)
        elif name == "RRULE":
            current["rrule"] = _parse_rrule(value)
        elif name == "EXDATE":
            for v in value.split(","):
                dt, _ = _parse_dt(v, params)
                if dt is not None:
                    current["exdates"].add(dt)
        elif name == "RECURRENCE-ID":
            current["recurrence_id"], _ = _parse_dt(value, params)
        elif name == "STATUS" and value.strip().upper() == "CANCELLED":
            current["cancelled"] = True
    return events


def _fmt(dt: datetime) -> str:
    return dt.strftime("%Y-%m-%dT%H:%M")


def _occurrence(event: dict, start: datetime) -> dict:
    dur = event["end"] - event["start"]
    return {
        "uid": event["uid"],
        "title": event["summary"] or "(untitled)",
        "start": _fmt(start),
        "end": _fmt(start + dur),
        "all_day": bool(event["all_day"]),
    }


def _rrule_starts(event: dict, window_end: datetime):
    """Concrete occurrence start datetimes for a WEEKLY/DAILY RRULE, in order,
    bounded by COUNT/UNTIL/window_end and MAX_OCCURRENCES_PER_EVENT."""
    rule = event["rrule"]
    freq = rule.get("FREQ", "").upper()
    interval = max(1, int(rule.get("INTERVAL", 1) or 1))
    count = int(rule["COUNT"]) if rule.get("COUNT", "").isdigit() else None
    until = None
    if rule.get("UNTIL"):
        until, _ = _parse_dt(rule["UNTIL"], {})
    start = event["start"]
    hard_end = min(window_end, until) if until else window_end
    out = []

    if freq == "DAILY":
        cur = start
        while cur <= hard_end and len(out) < MAX_OCCURRENCES_PER_EVENT:
            out.append(cur)
            if count and len(out) >= count:
                break
            cur += timedelta(days=interval)
        return out

    if freq == "WEEKLY":
        byday = [d for d in rule.get("BYDAY", "").split(",") if d in _WEEKDAYS]
        weekdays = sorted(_WEEKDAYS[d] for d in byday) or [start.weekday()]
        # Walk day by day from the DTSTART week; INTERVAL applies to weeks
        # relative to the start's week (weeks begin Monday, matching Python).
        week0 = (start - timedelta(days=start.weekday())).date()
        cur_day = start.date()
        while len(out) < MAX_OCCURRENCES_PER_EVENT:
            cur = datetime.combine(cur_day, start.time())
            if cur > hard_end:
                break
            weeks_from_start = ((cur_day - timedelta(days=cur_day.weekday())) - week0).days // 7
            if cur >= start and cur_day.weekday() in weekdays and weeks_from_start % interval == 0:
                out.append(cur)
                if count and len(out) >= count:
                    break
            cur_day += timedelta(days=1)
        return out

    # Unsupported frequency (MONTHLY/YEARLY/…): base occurrence only.
    return [start] if start <= hard_end else []


def expand_events(events: list[dict], window_start: datetime, window_end: datetime) -> list[dict]:
    """Expand parsed events into concrete occurrences overlapping the window.

    RECURRENCE-ID overrides replace the matching base occurrence of the same
    UID (a moved instance of a recurring event); EXDATEs drop occurrences.
    """
    overrides: dict[tuple, dict] = {}
    for e in events:
        if e["recurrence_id"] is not None and e["uid"]:
            overrides[(e["uid"], e["recurrence_id"])] = e

    out = []
    for e in events:
        if e["recurrence_id"] is not None:
            # Emitted via its override slot below (or standalone if the base
            # series is absent from the feed).
            if not any(x["uid"] == e["uid"] and x["rrule"] for x in events):
                if e["end"] >= window_start and e["start"] <= window_end:
                    out.append(_occurrence(e, e["start"]))
            continue

        starts = _rrule_starts(e, window_end) if e["rrule"] else [e["start"]]
        for s in starts:
            if s in e["exdates"]:
                continue
            override = overrides.get((e["uid"], s)) if e["uid"] else None
            if override is not None:
                occ_event, occ_start = override, override["start"]
            else:
                occ_event, occ_start = e, s
            dur = occ_event["end"] - occ_event["start"]
            if occ_start + dur >= window_start and occ_start <= window_end:
                out.append(_occurrence(occ_event, occ_start))

    out.sort(key=lambda o: o["start"])
    return out
