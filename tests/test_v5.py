"""
Semester OS V5 — Part I cleanup (§58): calendar-entry contexts and
moved-external-event repositioning proposals.

Entry contexts are relational metadata only — assigning/removing one must
never alter the entry's schedule, depth, status, or linkage. Event-move
proposals are computed server-side (delta arithmetic, flexible-only) and
applied exclusively through the ordinary session PATCH, so acceptance and
rejection are both explicit user acts.
"""
import backend.main as main_module


NOW = "2026-08-25T13:00"


def _task(client, name="Task", **overrides):
    # Pin active_from to the frozen NOW date — the server defaults it to the
    # real creation date, which would drift ahead of NOW (see test_contextual).
    params = {"name": name, "active_from": NOW[:10]}
    params.update(overrides)
    res = client.post("/tasks", params=params)
    assert res.status_code == 201, res.text
    return res.json()


def _entry(client, title, start, end, **extra):
    body = {"title": title, "planned_start": start, "planned_end": end}
    body.update(extra)
    res = client.post("/sessions", json=body)
    assert res.status_code == 201, res.text
    return res.json()


def _context(client, name):
    res = client.post("/contexts", json={"name": name})
    assert res.status_code in (200, 201)
    return res.json()


def _ics(start="20260828T140000", end="20260828T150000"):
    return (
        "BEGIN:VCALENDAR\r\nVERSION:2.0\r\n"
        "BEGIN:VEVENT\r\nUID:meeting@v5\r\nSUMMARY:Research Meeting\r\n"
        f"DTSTART:{start}\r\nDTEND:{end}\r\nEND:VEVENT\r\n"
        "END:VCALENDAR\r\n"
    )


def _calendar(client, monkeypatch, text=None):
    monkeypatch.setattr(main_module, "_fetch_ics_text", lambda url: text or _ics())
    res = client.post("/external-calendars",
                      json={"name": "GT", "url": "https://x.test/secret-v5/basic.ics"})
    assert res.status_code == 201
    return res.json()


def _resync(client, monkeypatch, cal, text):
    monkeypatch.setattr(main_module, "_fetch_ics_text", lambda url: text)
    res = client.post(f"/external-calendars/{cal['id']}/sync")
    assert res.status_code == 200


def _proposal(client, cal, uid="meeting@v5", now=NOW):
    res = client.get("/event-move-proposals",
                     params={"calendar_id": cal["id"], "uid": uid, "now": now})
    assert res.status_code == 200
    return res.json()


class TestEntryContexts:
    def test_create_entry_with_context(self, client):
        ctx = _context(client, "ISYE 2027")
        e = _entry(client, "Study group", "2026-08-27T19:00", "2026-08-27T21:00",
                   context_id=ctx["id"])
        assert e["context_id"] == ctx["id"]
        assert e["context_name"] == "ISYE 2027"

    def test_assign_and_remove_context_is_non_destructive(self, client):
        ctx = _context(client, "MATH 2603")
        e = _entry(client, "Office hours visit", "2026-08-27T15:00", "2026-08-27T15:30",
                   depth=2)
        before = {k: e[k] for k in
                  ("title", "depth", "planned_start", "planned_end", "status",
                   "is_fixed", "task_id")}
        # assign
        got = client.patch(f"/sessions/{e['id']}", json={"context_id": ctx["id"]}).json()
        assert got["context_name"] == "MATH 2603"
        assert {k: got[k] for k in before} == before
        # remove (0 clears)
        got = client.patch(f"/sessions/{e['id']}", json={"context_id": 0}).json()
        assert got["context_id"] is None
        assert got["context_name"] is None
        assert {k: got[k] for k in before} == before

    def test_context_not_required(self, client):
        e = _entry(client, "Walk", "2026-08-27T08:00", "2026-08-27T08:30")
        assert e["context_id"] is None
        assert e["context_name"] is None

    def test_unknown_context_rejected(self, client):
        res = client.post("/sessions", json={
            "title": "X", "planned_start": "2026-08-27T08:00",
            "planned_end": "2026-08-27T09:00", "context_id": 9999})
        assert res.status_code == 404

    def test_linked_session_rejects_direct_context(self, client):
        ctx = _context(client, "Research")
        t = _task(client, name="Research Coding", context_id=ctx["id"])
        res = client.post("/sessions", json={
            "task_id": t["id"], "planned_start": "2026-08-27T09:00",
            "planned_end": "2026-08-27T10:00"})
        s = res.json()
        # linked sessions resolve context from the task…
        assert s["context_name"] == "Research"
        # …and refuse a direct edit.
        res = client.patch(f"/sessions/{s['id']}", json={"context_id": ctx["id"]})
        assert res.status_code == 422

    def test_promotion_clears_entry_context(self, client):
        ctx = _context(client, "ISYE 2027")
        e = _entry(client, "HW grind", "2026-08-27T19:00", "2026-08-27T20:00",
                   context_id=ctx["id"])
        t = _task(client, name="ISYE Homework")  # no context
        got = client.patch(f"/sessions/{e['id']}", json={"link_task_id": t["id"]}).json()
        assert got["task_id"] == t["id"]
        assert got["context_id"] is None          # own copy cleared
        assert got["context_name"] is None        # resolves from the (context-less) task

    def test_deleting_context_keeps_entry(self, client):
        ctx = _context(client, "Doomed Course")
        e = _entry(client, "Recitation", "2026-08-27T10:00", "2026-08-27T11:00",
                   context_id=ctx["id"])
        client.delete(f"/contexts/{ctx['id']}")
        listed = client.get("/sessions",
                            params={"start": "2026-08-27", "end": "2026-08-27"}).json()
        got = next(s for s in listed if s["id"] == e["id"])
        assert got["task_name"] == "Recitation"
        assert got["context_id"] is None
        assert got["context_name"] is None


class TestEventMoveProposal:
    def _setup(self, client, monkeypatch):
        """Meeting 08-28 14:00–15:00; prep session before, follow-up after."""
        cal = _calendar(client, monkeypatch)
        prep = _task(client, name="Prepare plots")
        follow = _task(client, name="Send follow-up")
        client.post("/task-event-links", json={
            "task_id": prep["id"], "calendar_id": cal["id"], "uid": "meeting@v5",
            "relation": "before", "offset_minutes": 30, "event_start": "2026-08-28T14:00"})
        client.post("/task-event-links", json={
            "task_id": follow["id"], "calendar_id": cal["id"], "uid": "meeting@v5",
            "relation": "after", "offset_minutes": 15, "event_start": "2026-08-28T14:00"})
        s_prep = client.post("/sessions", json={
            "task_id": prep["id"], "planned_start": "2026-08-28T13:30",
            "planned_end": "2026-08-28T14:00"}).json()
        s_follow = client.post("/sessions", json={
            "task_id": follow["id"], "planned_start": "2026-08-28T15:00",
            "planned_end": "2026-08-28T15:15"}).json()
        return cal, prep, follow, s_prep, s_follow

    def test_no_proposal_when_event_unmoved(self, client, monkeypatch):
        cal, *_ = self._setup(client, monkeypatch)
        assert _proposal(client, cal)["moved"] is False

    def test_proposal_times_shift_by_event_delta(self, client, monkeypatch):
        cal, prep, follow, s_prep, s_follow = self._setup(client, monkeypatch)
        _resync(client, monkeypatch, cal, _ics("20260828T150000", "20260828T160000"))
        p = _proposal(client, cal)
        assert p["moved"] is True
        assert p["old_start"] == "2026-08-28T14:00"
        assert p["new_start"] == "2026-08-28T15:00"
        by_id = {i["session_id"]: i for i in p["items"]}
        assert by_id[s_prep["id"]]["proposed_start"] == "2026-08-28T14:30"
        assert by_id[s_prep["id"]]["proposed_end"] == "2026-08-28T15:00"
        assert by_id[s_follow["id"]]["proposed_start"] == "2026-08-28T16:00"
        assert by_id[s_follow["id"]]["proposed_end"] == "2026-08-28T16:15"

    def test_backward_move_shifts_earlier(self, client, monkeypatch):
        cal, prep, follow, s_prep, _ = self._setup(client, monkeypatch)
        _resync(client, monkeypatch, cal, _ics("20260828T130000", "20260828T140000"))
        p = _proposal(client, cal)
        by_id = {i["session_id"]: i for i in p["items"]}
        assert by_id[s_prep["id"]]["proposed_start"] == "2026-08-28T12:30"

    def test_fixed_sessions_never_proposed(self, client, monkeypatch):
        cal, prep, *_ = self._setup(client, monkeypatch)
        fixed = client.post("/sessions", json={
            "task_id": prep["id"], "planned_start": "2026-08-28T11:00",
            "planned_end": "2026-08-28T12:00", "is_fixed": True}).json()
        _resync(client, monkeypatch, cal, _ics("20260828T150000", "20260828T160000"))
        p = _proposal(client, cal)
        assert fixed["id"] not in [i["session_id"] for i in p["items"]]
        assert p["fixed_count"] == 1

    def test_past_and_resolved_sessions_excluded(self, client, monkeypatch):
        cal, prep, *_ = self._setup(client, monkeypatch)
        past = client.post("/sessions", json={
            "task_id": prep["id"], "planned_start": "2026-08-24T09:00",
            "planned_end": "2026-08-24T10:00"}).json()
        done = client.post("/sessions", json={
            "task_id": prep["id"], "planned_start": "2026-08-28T09:00",
            "planned_end": "2026-08-28T10:00"}).json()
        client.patch(f"/sessions/{done['id']}", json={"status": "completed"})
        _resync(client, monkeypatch, cal, _ics("20260828T150000", "20260828T160000"))
        ids = [i["session_id"] for i in _proposal(client, cal)["items"]]
        assert past["id"] not in ids
        assert done["id"] not in ids

    def test_accepting_moves_selected_sessions(self, client, monkeypatch):
        cal, prep, follow, s_prep, s_follow = self._setup(client, monkeypatch)
        _resync(client, monkeypatch, cal, _ics("20260828T150000", "20260828T160000"))
        p = _proposal(client, cal)
        # Apply exactly as the UI does: ordinary PATCH per chosen session,
        # then acknowledge by updating each link's remembered event_start.
        for item in p["items"]:
            client.patch(f"/sessions/{item['session_id']}", json={
                "planned_start": item["proposed_start"],
                "planned_end": item["proposed_end"]})
        for link_id in p["link_ids"]:
            client.patch(f"/task-event-links/{link_id}",
                         json={"event_start": p["new_start"]})
        moved = client.get("/sessions", params={"task_id": prep["id"]}).json()
        assert moved[0]["planned_start"] == "2026-08-28T14:30"
        # Acknowledged → no lingering proposal.
        assert _proposal(client, cal)["moved"] is False

    def test_rejecting_leaves_schedule_unchanged(self, client, monkeypatch):
        cal, prep, follow, s_prep, s_follow = self._setup(client, monkeypatch)
        _resync(client, monkeypatch, cal, _ics("20260828T150000", "20260828T160000"))
        p = _proposal(client, cal)
        # "Keep current schedule" = acknowledge only.
        for link_id in p["link_ids"]:
            client.patch(f"/task-event-links/{link_id}",
                         json={"event_start": p["new_start"]})
        kept = client.get("/sessions", params={"task_id": prep["id"]}).json()
        assert kept[0]["planned_start"] == "2026-08-28T13:30"
        assert _proposal(client, cal)["moved"] is False

    def test_event_moved_reminder_counts_flexible_sessions(self, client, monkeypatch):
        cal, *_ = self._setup(client, monkeypatch)
        _resync(client, monkeypatch, cal, _ics("20260828T150000", "20260828T160000"))
        rems = client.get("/reminders", params={"now": NOW}).json()
        moved = [r for r in rems if r["type"] == "event_moved"]
        assert len(moved) == 1
        assert "2 related flexible sessions" in moved[0]["detail"]
        assert moved[0]["uid"] == "meeting@v5"
        # Stable key: recomputing yields the identical reminder key.
        again = [r for r in client.get("/reminders", params={"now": NOW}).json()
                 if r["type"] == "event_moved"]
        assert again[0]["key"] == moved[0]["key"]

    def test_no_reminder_without_flexible_sessions(self, client, monkeypatch):
        cal = _calendar(client, monkeypatch)
        t = _task(client, name="Linked but sessionless")
        client.post("/task-event-links", json={
            "task_id": t["id"], "calendar_id": cal["id"], "uid": "meeting@v5",
            "relation": "before", "event_start": "2026-08-28T14:00"})
        _resync(client, monkeypatch, cal, _ics("20260828T150000", "20260828T160000"))
        rems = client.get("/reminders", params={"now": NOW}).json()
        assert not [r for r in rems if r["type"] == "event_moved"]


# ═══════════════════════════════════════════════════════════════════════════
# V5.2 — natural-language scheduling (§60) and Calendar search (§61)
# ═══════════════════════════════════════════════════════════════════════════

def _parse(client, q, now=NOW):
    res = client.get("/nl/parse", params={"q": q, "now": now})
    assert res.status_code == 200, res.text
    return res.json()


class TestNaturalLanguage:
    # NOW is Tuesday 2026-08-25 13:00.

    def test_explicit_everything(self, client):
        p = _parse(client, "research tomorrow 9am 90m d1")
        assert p["title"] == "research"
        assert p["date"] == "2026-08-26"
        assert p["start_minutes"] == 9 * 60
        assert p["end_minutes"] == 9 * 60 + 90
        assert p["depth"] == 1
        assert p["kind"] == "entry"          # §11 calendar-only default

    def test_weekday_and_short_duration(self, client):
        p = _parse(client, "email professor friday 4pm 20m d3")
        assert p["date"] == "2026-08-28"     # next Friday
        assert p["start_minutes"] == 16 * 60
        assert p["duration_minutes"] == 20
        assert p["depth"] == 3
        assert p["title"] == "email professor"

    def test_time_range(self, client):
        p = _parse(client, "study group thursday 7-9pm d2")
        assert p["date"] == "2026-08-27"
        assert p["start_minutes"] == 19 * 60
        assert p["end_minutes"] == 21 * 60
        assert p["duration_minutes"] == 120
        assert p["depth"] == 2
        assert p["title"] == "study group"

    def test_existing_task_reference(self, client):
        _task(client, name="ISYE HW")
        p = _parse(client, "schedule ISYE HW tomorrow morning for 2h")
        assert p["task_name"] == "ISYE HW"
        assert p["date"] == "2026-08-26"
        assert p["start_minutes"] == 9 * 60   # morning
        assert p["duration_minutes"] == 120
        assert p["title"] == "ISYE HW"        # verb stripped

    def test_missing_duration_defaults_with_note(self, client):
        p = _parse(client, "ISYE tomorrow at 3")
        assert p["start_minutes"] == 15 * 60  # bare 3 → PM
        assert p["end_minutes"] == 16 * 60
        assert any("1h" in n for n in p["notes"])
        assert any("PM" in n for n in p["notes"])
        assert p["kind"] == "entry"           # §10: shown for confirmation

    def test_context_matched_without_eating_title(self, client):
        ctx = _context(client, "ISYE 2027")
        p = _parse(client, "ISYE review session tomorrow 2pm 45m")
        assert p["context_id"] == ctx["id"]
        assert "ISYE" in p["title"]           # context match is associative only

    def test_fixed_keyword(self, client):
        p = _parse(client, "advising appointment friday 10am 30m fixed")
        assert p["is_fixed"] is True
        assert "fixed" not in p["title"].lower()

    def test_no_date_no_time_all_noted(self, client):
        p = _parse(client, "reading notes")
        assert p["date"] == "2026-08-25"
        assert p["title"] == "reading notes"
        assert len(p["notes"]) >= 2           # assumed today + assumed time

    def test_malformed_inputs(self, client):
        assert client.get("/nl/parse", params={"q": "   "}).status_code == 422
        # nonsense parses safely into a title-only proposal
        p = _parse(client, "zzz qqq 999xyz")
        assert "zzz" in p["title"]

    def test_parse_never_creates_anything(self, client):
        before_tasks = len(client.get("/tasks").json())
        _parse(client, "research tomorrow 9am 90m d1")
        _parse(client, "schedule something friday")
        assert len(client.get("/tasks").json()) == before_tasks
        res = client.get("/sessions", params={"start": "2026-08-01", "end": "2026-12-31"})
        assert res.json() == []


class TestSearch:
    def _seed(self, client, monkeypatch):
        cal = _calendar(client, monkeypatch, text=(
            "BEGIN:VCALENDAR\r\nVERSION:2.0\r\n"
            "BEGIN:VEVENT\r\nUID:lec@v5\r\nSUMMARY:ISYE Lecture\r\n"
            "DTSTART:20260827T110000\r\nDTEND:20260827T121500\r\nEND:VEVENT\r\n"
            "END:VCALENDAR\r\n"))
        ctx = _context(client, "ISYE 2027")
        client.post("/context-event-links", json={
            "context_id": ctx["id"], "calendar_id": cal["id"], "uid": "lec@v5"})
        t = _task(client, name="ISYE Homework", context_id=ctx["id"], depth=2)
        s = client.post("/sessions", json={
            "task_id": t["id"], "planned_start": "2026-08-26T10:00",
            "planned_end": "2026-08-26T11:00"}).json()
        e = _entry(client, "ISYE study group", "2026-09-02T19:00", "2026-09-02T21:00")
        return cal, ctx, t, s, e

    def test_search_spans_all_types(self, client, monkeypatch):
        self._seed(client, monkeypatch)
        r = client.get("/search", params={"q": "isye"}).json()
        assert [t["name"] for t in r["tasks"]] == ["ISYE Homework"]
        names = [s["name"] for s in r["sessions"]]
        assert "ISYE Homework" in names and "ISYE study group" in names
        assert r["events"][0]["title"] == "ISYE Lecture"
        assert r["contexts"][0]["name"] == "ISYE 2027"

    def test_type_filter(self, client, monkeypatch):
        self._seed(client, monkeypatch)
        r = client.get("/search", params={"q": "isye", "types": "entry"}).json()
        assert r["tasks"] == [] and r["events"] == []
        assert [s["name"] for s in r["sessions"]] == ["ISYE study group"]
        assert r["sessions"][0]["task_id"] is None

    def test_date_range_filter(self, client, monkeypatch):
        self._seed(client, monkeypatch)
        r = client.get("/search", params={
            "q": "isye", "types": "session,entry",
            "start": "2026-09-01", "end": "2026-09-30"}).json()
        assert [s["name"] for s in r["sessions"]] == ["ISYE study group"]

    def test_status_filter(self, client, monkeypatch):
        _, _, t, s, _ = self._seed(client, monkeypatch)
        client.patch(f"/sessions/{s['id']}", json={"status": "completed"})
        done = client.get("/search", params={"q": "isye", "status": "completed"}).json()
        assert [x["name"] for x in done["sessions"]] == ["ISYE Homework"]
        open_ = client.get("/search", params={"q": "isye", "status": "incomplete"}).json()
        assert [x["name"] for x in open_["sessions"]] == ["ISYE study group"]

    def test_context_filter_without_query(self, client, monkeypatch):
        _, ctx, t, *_ = self._seed(client, monkeypatch)
        other = _task(client, name="Unrelated chore")
        r = client.get("/search", params={"q": "", "context_id": ctx["id"]}).json()
        assert [x["name"] for x in r["tasks"]] == ["ISYE Homework"]
        assert r["events"][0]["title"] == "ISYE Lecture"

    def test_search_is_read_only(self, client, monkeypatch):
        self._seed(client, monkeypatch)
        before = client.get("/sessions", params={"start": "2026-08-01", "end": "2026-12-31"}).json()
        client.get("/search", params={"q": "isye"})
        after = client.get("/sessions", params={"start": "2026-08-01", "end": "2026-12-31"}).json()
        assert before == after

    def test_empty_query_without_context_rejected(self, client):
        assert client.get("/search", params={"q": "  "}).status_code == 422


# ═══════════════════════════════════════════════════════════════════════════
# V5.3 — academic importer (§62)
# ═══════════════════════════════════════════════════════════════════════════

SYLLABUS = """ISYE 2027 — Fall 2026 Syllabus
Lecture: TR 11:00-12:15pm
Office Hours: Wednesday 2-3pm
Homework 1 due September 3
Homework 2 due September 10
Quiz 1: September 8
Reading: Chapter 4 by Sep 10
Midterm Exam: Thursday, September 24, 11:00am-12:15pm
Final Project due Dec 4
Grading is based on participation and effort.
"""


def _import(client, text=SYLLABUS, **extra):
    body = {"text": text, "context_name": "ISYE 2027", "today": NOW[:10]}
    body.update(extra)
    res = client.post("/academic/import", json=body)
    assert res.status_code == 201, res.text
    return res.json()


class TestAcademicImport:
    def test_extraction(self, client):
        batch = _import(client)
        by_title = {c["title"]: c for c in batch["candidates"]}
        assert by_title["Homework 1"]["kind"] == "homework"
        assert by_title["Homework 1"]["date"] == "2026-09-03"
        assert by_title["Quiz 1"]["date"] == "2026-09-08"
        assert by_title["Midterm Exam"]["kind"] == "exam"
        assert by_title["Midterm Exam"]["date"] == "2026-09-24"
        assert by_title["Midterm Exam"]["start_minutes"] == 11 * 60
        assert by_title["Final Project"]["kind"] == "project"   # not an exam
        assert by_title["Final Project"]["date"] == "2026-12-04"
        assert by_title["Lecture"]["weekdays"] == [1, 3]        # TR
        assert by_title["Office Hours"]["weekdays"] == [2]
        # prose line produced nothing
        assert not any("participation" in c["title"] for c in batch["candidates"])

    def test_source_evidence_preserved(self, client):
        batch = _import(client)
        exam = next(c for c in batch["candidates"] if c["kind"] == "exam")
        assert exam["source_text"] == "Midterm Exam: Thursday, September 24, 11:00am-12:15pm"

    def test_candidates_are_not_canonical(self, client):
        _import(client)
        assert client.get("/tasks").json() == []
        assert client.get("/sessions", params={"start": "2026-08-01", "end": "2026-12-31"}).json() == []

    def test_reject_creates_nothing(self, client):
        batch = _import(client)
        for c in batch["candidates"]:
            res = client.post(f"/academic/candidates/{c['id']}/reject")
            assert res.status_code == 200
            assert res.json()["status"] == "rejected"
        assert client.get("/tasks").json() == []
        assert client.get("/sessions", params={"start": "2026-08-01", "end": "2026-12-31"}).json() == []

    def test_approve_assignment_creates_task_with_due_date(self, client):
        batch = _import(client)
        hw = next(c for c in batch["candidates"] if c["title"] == "Homework 1")
        out = client.post(f"/academic/candidates/{hw['id']}/approve")
        assert out.status_code == 200, out.text
        assert out.json()["created_record"].startswith("task:")
        tasks = client.get("/tasks").json()
        assert len(tasks) == 1
        t = tasks[0]
        assert t["name"] == "Homework 1"
        assert t["due_date"] == "2026-09-03"
        assert t["context_name"] == "ISYE 2027"
        assert t["section"] == "ISYE 2027"

    def test_approve_timed_exam_creates_fixed_entry(self, client):
        batch = _import(client)
        exam = next(c for c in batch["candidates"] if c["kind"] == "exam")
        out = client.post(f"/academic/candidates/{exam['id']}/approve").json()
        assert out["created_record"].startswith("entry:")
        sess = client.get("/sessions", params={"start": "2026-09-24", "end": "2026-09-24"}).json()
        assert len(sess) == 1
        assert sess[0]["task_id"] is None
        assert sess[0]["is_fixed"] == 1
        assert sess[0]["planned_start"] == "2026-09-24T11:00"
        assert sess[0]["planned_end"] == "2026-09-24T12:15"
        assert sess[0]["context_name"] == "ISYE 2027"
        assert client.get("/tasks").json() == []   # no task pollution

    def test_recurring_requires_horizon_then_expands(self, client):
        batch = _import(client)
        lec = next(c for c in batch["candidates"] if c["title"] == "Lecture")
        res = client.post(f"/academic/candidates/{lec['id']}/approve")
        assert res.status_code == 422               # no silent unbounded expansion
        out = client.post(f"/academic/candidates/{lec['id']}/approve", json={
            "until": "2026-09-08", "from_date": "2026-08-25"}).json()
        assert out["created_record"] == "entries:5"  # Tu 25, Th 27, Tu 1, Th 3, Tu 8
        sess = client.get("/sessions", params={"start": "2026-08-25", "end": "2026-09-08"}).json()
        assert len(sess) == 5
        assert all(s["is_fixed"] == 1 and s["task_id"] is None for s in sess)
        assert sess[0]["planned_start"] == "2026-08-25T11:00"

    def test_duplicate_detection_against_existing_task(self, client):
        ctx = _context(client, "ISYE 2027")
        _task(client, name="Homework 1", context_id=ctx["id"], due_date="2026-09-03")
        batch = _import(client)
        hw = next(c for c in batch["candidates"] if c["title"] == "Homework 1")
        assert hw["duplicate_of"].startswith("task:")
        assert hw["date_conflict"] is None          # same date → duplicate, no change

    def test_changed_date_detected_and_updatable(self, client):
        ctx = _context(client, "ISYE 2027")
        t = _task(client, name="Homework 3", context_id=ctx["id"], due_date="2026-09-18")
        batch = _import(client, text="Homework 3 due September 20\n")
        hw = batch["candidates"][0]
        assert hw["duplicate_of"] == f"task:{t['id']}"
        assert hw["date_conflict"] == "2026-09-18"  # §31: Sep 18 → Sep 20
        out = client.post(f"/academic/candidates/{hw['id']}/approve",
                          json={"mode": "update_existing"}).json()
        assert out["created_record"] == f"task:{t['id']}:due_date"
        assert client.get(f"/tasks/{t['id']}").json()["due_date"] == "2026-09-20"
        assert len(client.get("/tasks").json()) == 1  # updated, not duplicated

    def test_reimport_flags_prior_candidates(self, client):
        first = _import(client)
        second = _import(client)
        hw = next(c for c in second["candidates"] if c["title"] == "Homework 1")
        assert hw["duplicate_of"] is not None

    def test_edit_candidate_before_approval(self, client):
        batch = _import(client, text="Homework 9 due September 3\n")
        c = batch["candidates"][0]
        edited = client.patch(f"/academic/candidates/{c['id']}", json={
            "title": "HW 9 (revised)", "date": "2026-09-05"}).json()
        assert edited["title"] == "HW 9 (revised)"
        out = client.post(f"/academic/candidates/{c['id']}/approve").json()
        t = client.get("/tasks").json()[0]
        assert t["name"] == "HW 9 (revised)"
        assert t["due_date"] == "2026-09-05"

    def test_bulk_isolation(self, client):
        batch = _import(client)
        ids = [c["id"] for c in batch["candidates"]]
        res = client.post("/academic/candidates/bulk", json={
            "ids": ids, "action": "approve"}).json()
        by_id = {r["id"]: r for r in res["results"]}
        lec = next(c for c in batch["candidates"] if c["title"] == "Lecture")
        hw = next(c for c in batch["candidates"] if c["title"] == "Homework 1")
        assert by_id[lec["id"]]["ok"] is False       # recurring needs a horizon
        assert by_id[hw["id"]]["ok"] is True          # …but others proceeded
        assert len(client.get("/tasks").json()) >= 4

    def test_batch_delete_keeps_created_records(self, client):
        batch = _import(client, text="Homework 1 due September 3\n")
        c = batch["candidates"][0]
        client.post(f"/academic/candidates/{c['id']}/approve")
        client.delete(f"/academic/batches/{batch['batch_id']}")
        assert client.get("/academic/candidates").json() == []
        assert len(client.get("/tasks").json()) == 1  # canonical record survives

    def test_malformed_import_isolated(self, client):
        assert client.post("/academic/import", json={"text": "   "}).status_code == 422
        batch = _import(client, text="??? \x01 garbage\nHomework 1 due September 3\n")
        assert len(batch["candidates"]) == 1          # bad line skipped, good line kept
