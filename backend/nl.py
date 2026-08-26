"""
Natural-language scheduling parser (V5.2 / Semester OS V5 Part III).

Deterministic regex parsing — no AI, no network. parse_nl() only INTERPRETS:
it returns a structured proposal plus plain-language notes about everything
it assumed or defaulted, and the caller shows that interpretation for
confirmation before anything is created (§10). Nothing here writes.

Recognized, in consumption order (character spans are consumed so leftover
text becomes the title):
  dates      2026-09-03 · 9/3 · sep 3 / september 3 · today · tonight ·
             tomorrow · weekday names (next occurrence; today counts)
  times      7-9pm · 9am · 3:30pm · 19:30 · "at 3" (bare hour: 8–11 → AM,
             everything else → PM, noted) · morning/afternoon/evening
  duration   90m · 2h · 1h30m · "for 2 hours"
  depth      d1 / d2 / d3
  pinning    "fixed" / "flexible"
Context/course and existing-task references are matched against the caller-
supplied lists without consuming title text.
"""
import re
from datetime import timedelta

WEEKDAYS = {
    "monday": 0, "mon": 0,
    "tuesday": 1, "tues": 1, "tue": 1,
    "wednesday": 2, "wed": 2,
    "thursday": 3, "thurs": 3, "thu": 3,
    "friday": 4, "fri": 4,
    "saturday": 5, "sat": 5,
    "sunday": 6, "sun": 6,
}

MONTHS = {
    "jan": 1, "january": 1, "feb": 2, "february": 2, "mar": 3, "march": 3,
    "apr": 4, "april": 4, "may": 5, "jun": 6, "june": 6, "jul": 7, "july": 7,
    "aug": 8, "august": 8, "sep": 9, "sept": 9, "september": 9,
    "oct": 10, "october": 10, "nov": 11, "november": 11,
    "dec": 12, "december": 12,
}

DAYPARTS = {"morning": 9 * 60, "afternoon": 14 * 60, "evening": 19 * 60, "night": 20 * 60}

LEADING_VERBS = ("schedule", "add", "plan", "book", "create")

DEFAULT_DURATION = 60


def _clock(hour, minute, meridiem, notes, *, bare_note=True):
    """→ minutes from midnight, inferring AM/PM for bare hours (noted)."""
    h, m = int(hour), int(minute or 0)
    if meridiem:
        mer = meridiem.lower()
        if mer == "pm" and h != 12:
            h += 12
        elif mer == "am" and h == 12:
            h = 0
    elif h <= 7:  # bare 1–7 reads as afternoon/evening; 8–11 as morning
        h += 12
        if bare_note:
            notes.append(f"assumed {h - 12} PM")
    elif h <= 11 and bare_note:
        notes.append(f"assumed {h} AM")
    return min(24 * 60 - 1, h * 60 + m)


def parse_nl(q, now_dt, contexts=None, tasks=None):
    """Parse `q` relative to now_dt. contexts/tasks: [{'id','name'}, …]."""
    raw = q.strip()
    if not raw:
        raise ValueError("empty query")
    text = raw
    lower = text.lower()
    consumed = [False] * len(text)
    notes = []

    def consume(span):
        for i in range(*span):
            consumed[i] = True

    def search_once(pattern, flags=re.I):
        for m in re.finditer(pattern, text, flags):
            if not any(consumed[m.start():m.end()]):
                return m
        return None

    # ── date ────────────────────────────────────────────────────────────────
    target_date = None
    m = search_once(r"\b(20\d{2})-(\d{2})-(\d{2})\b")
    if m:
        target_date = now_dt.date().replace(
            year=int(m.group(1)), month=int(m.group(2)), day=int(m.group(3)))
        consume(m.span())
    if target_date is None:
        m = search_once(r"\b(\d{1,2})/(\d{1,2})(?:/(\d{2,4}))?\b")
        if m:
            year = int(m.group(3)) if m.group(3) else now_dt.year
            if year < 100:
                year += 2000
            try:
                target_date = now_dt.date().replace(
                    year=year, month=int(m.group(1)), day=int(m.group(2)))
                if target_date < now_dt.date() and not m.group(3):
                    target_date = target_date.replace(year=year + 1)
                consume(m.span())
            except ValueError:
                pass
    if target_date is None:
        m = search_once(
            r"\b(" + "|".join(MONTHS) + r")\.?\s+(\d{1,2})\b")
        if m:
            try:
                target_date = now_dt.date().replace(
                    month=MONTHS[m.group(1).lower()], day=int(m.group(2)))
                if target_date < now_dt.date():
                    target_date = target_date.replace(year=target_date.year + 1)
                consume(m.span())
            except ValueError:
                pass
    evening_hint = False
    if target_date is None:
        m = search_once(r"\b(today|tonight|tomorrow|tmrw|tmr)\b")
        if m:
            word = m.group(1).lower()
            if word in ("tomorrow", "tmrw", "tmr"):
                target_date = now_dt.date() + timedelta(days=1)
            else:
                target_date = now_dt.date()
                evening_hint = word == "tonight"
            consume(m.span())
    if target_date is None:
        m = search_once(r"\b(" + "|".join(WEEKDAYS) + r")\b")
        if m:
            ahead = (WEEKDAYS[m.group(1).lower()] - now_dt.weekday()) % 7
            target_date = now_dt.date() + timedelta(days=ahead)
            if ahead == 0:
                notes.append("interpreted as today")
            consume(m.span())
    if target_date is None:
        target_date = now_dt.date()
        notes.append("no date given — assumed today")

    # ── time range / single time ────────────────────────────────────────────
    start_min = None
    end_min = None
    # A range needs am/pm or minutes on at least one side, so "chapter 7-9"
    # stays title text.
    m = search_once(
        r"\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*[-–—]\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b")
    if not m:
        m = search_once(
            r"\b(\d{1,2}):(\d{2})\s*(am|pm)?\s*[-–—]\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b")
    if m:
        end_min = _clock(m.group(4), m.group(5), m.group(6), notes, bare_note=False)
        if m.group(3):
            start_min = _clock(m.group(1), m.group(2), m.group(3), notes, bare_note=False)
        else:
            # A first hour without its own meridiem takes whichever AM/PM
            # form lands closest below the end ("7-9pm" → 7 PM,
            # "11-12:15pm" → 11 AM).
            base = int(m.group(1)) % 12 * 60 + int(m.group(2) or 0)
            candidates = [s for s in (base, base + 12 * 60) if s < end_min]
            start_min = max(candidates) if candidates else base
        if end_min <= start_min:
            end_min = min(24 * 60 - 1, end_min + 12 * 60)
        consume(m.span())
    if start_min is None:
        m = search_once(r"\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b")
        if m:
            start_min = _clock(m.group(1), m.group(2), m.group(3), notes)
            consume(m.span())
    if start_min is None:
        m = search_once(r"\bat\s+(\d{1,2})(?::(\d{2}))?\b")
        if m:
            start_min = _clock(m.group(1), m.group(2), None, notes)
            consume(m.span())
    if start_min is None:
        m = search_once(r"\b([01]?\d|2[0-3]):([0-5]\d)\b")
        if m:
            start_min = int(m.group(1)) * 60 + int(m.group(2))
            consume(m.span())
    m = search_once(r"\b(morning|afternoon|evening|night)\b")
    if m:
        if start_min is None:
            start_min = DAYPARTS[m.group(1).lower()]
            notes.append(f"{m.group(1).lower()} → {start_min // 60}:00")
        consume(m.span())

    # ── duration ────────────────────────────────────────────────────────────
    duration = None
    m = search_once(r"\b(\d+)\s*h(?:ours?|rs?)?\s+?(\d+)\s*m(?:in(?:utes?)?)?\b")
    if not m:
        m = search_once(r"\b(\d+)h(\d+)m?\b")
    if m:
        duration = int(m.group(1)) * 60 + int(m.group(2))
        consume(m.span())
    if duration is None:
        m = search_once(r"\b(?:for\s+)?(\d+(?:\.\d+)?)\s*h(?:ours?|rs?)?\b")
        if m:
            duration = round(float(m.group(1)) * 60)
            consume(m.span())
    if duration is None:
        m = search_once(r"\b(?:for\s+)?(\d+)\s*m(?:in(?:utes?)?)?\b")
        if m:
            duration = int(m.group(1))
            consume(m.span())

    # ── depth / pinning ─────────────────────────────────────────────────────
    depth = None
    m = search_once(r"\bd([123])\b")
    if m:
        depth = int(m.group(1))
        consume(m.span())
    is_fixed = False
    m = search_once(r"\bfixed\b")
    if m:
        is_fixed = True
        consume(m.span())
    m = search_once(r"\bflexible\b")
    if m:
        consume(m.span())

    # ── resolve start/end ───────────────────────────────────────────────────
    if start_min is None:
        start_min = DAYPARTS["evening"] if evening_hint else 9 * 60
        notes.append(f"no time given — assumed {start_min // 60}:00")
    if end_min is None:
        if duration is None:
            duration = DEFAULT_DURATION
            notes.append("assumed 1h")
        end_min = start_min + duration
    if end_min > 24 * 60:
        end_min = 24 * 60
    duration = end_min - start_min

    # ── title = leftover text ───────────────────────────────────────────────
    left = "".join(ch if not consumed[i] else "\x00" for i, ch in enumerate(text))
    words = [w for w in re.split(r"[\x00\s]+", left) if w]
    while words and words[0].lower() in LEADING_VERBS:
        words.pop(0)
    title = re.sub(r"\s+", " ", " ".join(words)).strip(" ,.·-")

    # ── context / existing-task references (never consume title text) ───────
    title_tokens = [w.lower().strip(".,") for w in title.split() if len(w) >= 2]
    context_id = context_name = None
    matches = []
    for c in contexts or []:
        cwords = {w.lower() for w in str(c["name"]).split()}
        if str(c["name"]).lower() in lower or any(t in cwords for t in title_tokens):
            matches.append(c)
    if len(matches) == 1:
        context_id, context_name = matches[0]["id"], matches[0]["name"]
    elif len(matches) > 1:
        notes.append("several contexts match — none applied")

    task_id = task_name = None
    if title_tokens:
        cands = []
        for t in tasks or []:
            name = str(t["name"]).lower()
            if all(tok in name for tok in title_tokens):
                cands.append(t)
        if len(cands) == 1:
            task_id, task_name = cands[0]["id"], cands[0]["name"]
        elif len(cands) > 1:
            notes.append(f"{len(cands)} existing tasks match — pick one explicitly")

    return {
        "title": title,
        "date": target_date.isoformat(),
        "start_minutes": start_min,
        "end_minutes": end_min,
        "duration_minutes": duration,
        "depth": depth,
        "is_fixed": is_fixed,
        "context_id": context_id,
        "context_name": context_name,
        "task_id": task_id,
        "task_name": task_name,
        # Calendar-only remains the default outcome (§11); the UI may switch
        # to the existing-task tab when task_id matched, but the user chooses.
        "kind": "entry",
        "notes": notes,
    }
