"""
Academic importer (V5.3 / Semester OS V5 Part VIII) — deterministic text
parsing of pasted syllabi / schedules into CANDIDATE records.

Architecture (§23): Source → this parser → candidate rows → user review →
approved canonical records. Nothing here touches canonical tables; the
parser is a pure function from text to candidate dicts, each carrying the
exact source line that produced it (§27) so extraction errors are visible.

Recognized per line:
  kind      keyword-based, explicit (§25): office_hours, quiz, homework,
            project, presentation, reading, milestone, exam, class;
            a dated line with no keyword becomes 'deadline'
  date      "September 3" / "Sep 3" / 9/3 / 2026-09-03 (year inferred
            forward when missing)
  time      "11:00am-12:15pm" / "2-3pm" / "at 11" (single times get no
            default duration — candidates keep exactly what the text says)
  recurrence  weekday sets ("TR", "MWF", "Monday/Wednesday", "Tuesdays and
            Thursdays") + a time range, only when the line has NO date
Lines with neither a date nor a recurring weekday+time produce nothing.
"""
import re
from datetime import date as _date

MAX_LINES = 500
MAX_CANDIDATES = 200

# Order matters: "Final Project" must be a project, not an exam.
KIND_PATTERNS = [
    ("office_hours", r"office\s+hours?"),
    ("quiz", r"\bquiz(?:zes)?\b"),
    ("homework", r"\b(?:homework|hw|problem\s+set|pset)\b"),
    ("project", r"\bproject\b"),
    ("presentation", r"\bpresentation\b"),
    ("reading", r"\b(?:reading|chapter|ch\.)\b"),
    ("milestone", r"\bmilestone\b"),
    ("exam", r"\b(?:final|midterm|exam|test)\b"),
    ("class", r"\b(?:lecture|class|recitation|section|lab)\b"),
]

TASK_KINDS = frozenset({
    "assignment", "homework", "quiz", "project", "reading",
    "presentation", "deadline", "milestone",
})
EVENT_KINDS = frozenset({"exam", "class", "office_hours"})

MONTHS = {
    "jan": 1, "january": 1, "feb": 2, "february": 2, "mar": 3, "march": 3,
    "apr": 4, "april": 4, "may": 5, "jun": 6, "june": 6, "jul": 7, "july": 7,
    "aug": 8, "august": 8, "sep": 9, "sept": 9, "september": 9,
    "oct": 10, "october": 10, "nov": 11, "november": 11,
    "dec": 12, "december": 12,
}

WEEKDAY_NAMES = {
    "monday": 0, "mondays": 0, "mon": 0,
    "tuesday": 1, "tuesdays": 1, "tues": 1, "tue": 1,
    "wednesday": 2, "wednesdays": 2, "wed": 2,
    "thursday": 3, "thursdays": 3, "thurs": 3, "thu": 3,
    "friday": 4, "fridays": 4, "fri": 4,
    "saturday": 5, "saturdays": 5, "sat": 5,
    "sunday": 6, "sundays": 6, "sun": 6,
}

# Compact codes: M T(u) W R/Th F — "TR", "MWF", "TTh", …
_COMPACT_DAY = {"M": 0, "Tu": 1, "T": 1, "W": 2, "Th": 3, "R": 3, "F": 4}
_COMPACT_RE = re.compile(r"^(M|Tu|Th|T|W|R|F){2,5}$")
_COMPACT_TOKEN = re.compile(r"M|Tu|Th|T|W|R|F")


def _clock(hour, minute, meridiem):
    h, m = int(hour), int(minute or 0)
    if meridiem:
        mer = meridiem.lower()
        if mer == "pm" and h != 12:
            h += 12
        elif mer == "am" and h == 12:
            h = 0
    elif h <= 7:
        h += 12  # bare 1–7 in schedules reads as afternoon
    return min(24 * 60 - 1, h * 60 + m)


def _range_start(hour, minute, own_meridiem, end_min):
    """Start of a range like "11:00-12:15pm": a first hour without its own
    meridiem takes whichever AM/PM form lands closest BELOW the end
    ("2-3pm" → 2 PM, "11-12:15pm" → 11 AM)."""
    if own_meridiem:
        return _clock(hour, minute, own_meridiem)
    base = int(hour) % 12 * 60 + int(minute or 0)
    candidates = [s for s in (base, base + 12 * 60) if s < end_min]
    return max(candidates) if candidates else base


def _parse_line(line, today):
    text = line.strip()
    if not text or len(text) < 3:
        return None
    consumed = [False] * len(text)
    lower = text.lower()

    def consume(span):
        for i in range(*span):
            consumed[i] = True

    def free(m):
        return not any(consumed[m.start():m.end()])

    # ── date ────────────────────────────────────────────────────────────────
    the_date = None
    m = re.search(r"\b(20\d{2})-(\d{2})-(\d{2})\b", text)
    if m and free(m):
        try:
            the_date = _date(int(m.group(1)), int(m.group(2)), int(m.group(3)))
            consume(m.span())
        except ValueError:
            pass
    if the_date is None:
        m = re.search(
            r"\b(" + "|".join(MONTHS) + r")\.?,?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(20\d{2}))?\b",
            text, re.I)
        if m and free(m):
            year = int(m.group(3)) if m.group(3) else today.year
            try:
                the_date = _date(year, MONTHS[m.group(1).lower()], int(m.group(2)))
                if not m.group(3) and the_date < today.replace(year=today.year) and \
                        (today - the_date).days > 90:
                    the_date = the_date.replace(year=year + 1)
                consume(m.span())
            except ValueError:
                pass
    if the_date is None:
        m = re.search(r"\b(\d{1,2})/(\d{1,2})(?:/(\d{2,4}))?\b", text)
        if m and free(m):
            year = int(m.group(3)) if m.group(3) else today.year
            if year < 100:
                year += 2000
            try:
                the_date = _date(year, int(m.group(1)), int(m.group(2)))
                if not m.group(3) and (today - the_date).days > 90:
                    the_date = the_date.replace(year=year + 1)
                consume(m.span())
            except ValueError:
                pass

    # ── time / time range ───────────────────────────────────────────────────
    start_min = end_min = None
    m = re.search(
        r"\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*[-–—]\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b",
        text, re.I)
    if not m:
        m = re.search(
            r"\b(\d{1,2}):(\d{2})\s*(am|pm)?\s*[-–—]\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b",
            text, re.I)
    if m and free(m):
        end_min = _clock(m.group(4), m.group(5), m.group(6))
        start_min = _range_start(m.group(1), m.group(2), m.group(3), end_min)
        if end_min <= start_min:
            end_min = min(24 * 60 - 1, end_min + 12 * 60)
        consume(m.span())
    if start_min is None:
        m = re.search(r"\b(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b", text, re.I)
        if m and free(m):
            start_min = _clock(m.group(1), m.group(2), m.group(3))
            consume(m.span())

    # ── recurrence (only meaningful without a concrete date) ────────────────
    weekdays = []
    if the_date is None:
        found = set()
        for m in re.finditer(r"[A-Za-z]+", text):
            if not free(m):
                continue
            word = m.group(0)
            if word.lower() in WEEKDAY_NAMES:
                found.add(WEEKDAY_NAMES[word.lower()])
                consume(m.span())
            elif _COMPACT_RE.match(word):
                for tok in _COMPACT_TOKEN.findall(word):
                    found.add(_COMPACT_DAY[tok])
                consume(m.span())
        weekdays = sorted(found)
    else:
        # A weekday alongside an explicit date is decoration ("Thursday,
        # September 24") — consume it so the title stays clean.
        for m in re.finditer(r"[A-Za-z]+", text):
            if free(m) and m.group(0).lower() in WEEKDAY_NAMES:
                consume(m.span())

    if the_date is None and not (weekdays and start_min is not None):
        return None  # no schedulable information on this line

    # ── kind ────────────────────────────────────────────────────────────────
    kind = None
    for k, pattern in KIND_PATTERNS:
        if re.search(pattern, lower):
            kind = k
            break
    if kind is None:
        kind = "deadline"

    # ── title = leftover text, cleaned ──────────────────────────────────────
    left = "".join(ch if not consumed[i] else "\x00" for i, ch in enumerate(text))
    left = left.replace("\x00", " ")
    left = re.sub(r"\b(due|by|on|at)\b\s*$", "", left, flags=re.I)
    left = re.sub(r"^\s*(due|by)\b", "", left, flags=re.I)
    title = re.sub(r"\s+", " ", left).strip(" \t•·-–—:,.;|")
    title = re.sub(r"\s+", " ", title)
    if len(title) < 2:
        title = kind.replace("_", " ").title()

    return {
        "kind": kind,
        "title": title[:200],
        "date": the_date.isoformat() if the_date else None,
        "start_minutes": start_min,
        "end_minutes": end_min,
        "weekdays": weekdays,
        "source_text": line.strip()[:300],
    }


def parse_academic_text(text, today):
    """Parse pasted syllabus/schedule text → candidate dicts. Pure."""
    out = []
    for line in text.splitlines()[:MAX_LINES]:
        try:
            cand = _parse_line(line, today)
        except Exception:
            cand = None  # a malformed line never poisons the batch (§55)
        if cand:
            out.append(cand)
        if len(out) >= MAX_CANDIDATES:
            break
    return out


def normalize_title(title):
    """Duplicate-detection key (§30): case/punctuation-insensitive."""
    return re.sub(r"[^a-z0-9]+", "", str(title).lower())
