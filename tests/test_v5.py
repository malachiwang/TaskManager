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
