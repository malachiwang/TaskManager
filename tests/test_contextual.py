"""
Calendar V4 (P16.0) — contextual scheduling, courses, event relationships,
reminders, deadline coverage, and ICS secret handling.

Suggestion/reminder engines run server-side with a `now` override so every
scenario here is deterministic.
"""
import pytest

import backend.main as main_module


NOW = "2026-08-25T13:00"


def _task(client, name="Task", **overrides):
    # active_from defaults to the REAL creation date on the server. This suite
    # runs against a frozen NOW, so pin active_from to that date — otherwise
    # every fixture task becomes "scheduled to start in the future" the day
    # after the suite was written and is_scheduled filters it out of Good Fits.
    params = {"name": name, "active_from": NOW[:10]}
    params.update(overrides)
    res = client.post("/tasks", params=params)
    assert res.status_code == 201, res.text
    return res.json()


def _session(client, task_id, start, end, **extra):
    body = {"task_id": task_id, "planned_start": start, "planned_end": end}
    body.update(extra)
    res = client.post("/sessions", json=body)
    assert res.status_code == 201, res.text
    return res.json()


def _entry(client, title, start, end):
    res = client.post("/sessions", json={"title": title, "planned_start": start, "planned_end": end})
    assert res.status_code == 201
    return res.json()


def _fixed_entry(client, title, start, end):
    return client.post("/sessions", json={
        "title": title, "planned_start": start, "planned_end": end, "is_fixed": True,
    }).json()


def _suggest(client, now=NOW):
    res = client.get("/suggestions", params={"now": now})
    assert res.status_code == 200
    return res.json()


class TestGapDetection:
    def test_gap_bounded_by_fixed_entry(self, client):
        _fixed_entry(client, "Class", "2026-08-25T14:00", "2026-08-25T15:00")
        gap = _suggest(client)["gap"]
        assert gap["start_minutes"] == 13 * 60
        assert gap["end_minutes"] == 14 * 60
        assert gap["minutes"] == 60
        assert gap["bounded_by"] == "Class"

    def test_flexible_work_does_not_bound_gap(self, client):
        t = _task(client, estimated_minutes=60)
        _session(client, t["id"], "2026-08-25T13:30", "2026-08-25T14:30")  # flexible
        gap = _suggest(client)["gap"]
        assert gap["minutes"] == 11 * 60  # until end of day

    def test_now_inside_fixed_block_starts_gap_after_it(self, client):
        _fixed_entry(client, "Meeting", "2026-08-25T12:30", "2026-08-25T13:30")
        _fixed_entry(client, "Class", "2026-08-25T15:00", "2026-08-25T16:00")
        gap = _suggest(client)["gap"]
        assert gap["start_minutes"] == 13 * 60 + 30
        assert gap["end_minutes"] == 15 * 60


class TestGoodFitsNow:
    def test_short_task_fits_short_gap(self, client):
        _fixed_entry(client, "Class", "2026-08-25T13:45", "2026-08-25T15:00")  # 45m gap
        _task(client, name="Quick review", depth=2, estimated_minutes=30)
        s = _suggest(client)
        names = [x["name"] for x in s["suggestions"]]
        assert "Quick review" in names
        row = next(x for x in s["suggestions"] if x["name"] == "Quick review")
        assert any("fits the 45m gap" in r for r in row["reasons"])

    def test_no_estimate_task_not_suggested(self, client):
        _task(client, name="Mystery work")
        assert _suggest(client)["suggestions"] == []

    def test_multi_session_task_offered_partially(self, client):
        _fixed_entry(client, "Class", "2026-08-25T13:50", "2026-08-25T15:00")  # 50m gap
        _task(client, name="Research implementation", depth=1, estimated_minutes=165)
        s = _suggest(client)
        row = next(x for x in s["suggestions"] if x["name"] == "Research implementation")
        assert row["suggested_minutes"] == 50
        assert any("split sessions" in r for r in row["reasons"])
        assert any("2h 45m remaining" in r for r in row["reasons"])

    def test_tiny_gap_excludes_split_sessions(self, client):
        _fixed_entry(client, "Class", "2026-08-25T13:17", "2026-08-25T15:00")  # 17m gap
        _task(client, name="Big work", estimated_minutes=180)
        _task(client, name="Tiny admin", depth=3, estimated_minutes=10)
        names = [x["name"] for x in _suggest(client)["suggestions"]]
        assert "Big work" not in names          # §8: no misleading offers
        assert "Tiny admin" in names

    def test_fully_scheduled_task_excluded(self, client):
        t = _task(client, name="Covered", estimated_minutes=60)
        _session(client, t["id"], "2026-08-26T09:00", "2026-08-26T10:00")
        assert [x["name"] for x in _suggest(client)["suggestions"]] == []

    def test_calendar_only_history_excluded(self, client):
        _entry(client, "Recorded thing", "2026-08-25T10:00", "2026-08-25T11:00")
        assert _suggest(client)["suggestions"] == []

    def test_due_date_ranks_first(self, client):
        _task(client, name="Someday", estimated_minutes=30, priority=9)
        _task(client, name="Due soon", estimated_minutes=30, due_date="2026-08-26")
        s = _suggest(client)["suggestions"]
        assert s[0]["name"] == "Due soon"
        assert "due tomorrow" in s[0]["reasons"]

    def test_depth_is_advisory_in_ordinary_window(self, client):
        # D2 window active now (Tue = weekday 1): D2 sorts first, D1 still shown.
        client.post("/depth-windows", json={
            "depth": 2, "weekday": 1, "start_minutes": 12 * 60, "end_minutes": 16 * 60})
        _task(client, name="Deep thing", depth=1, estimated_minutes=30)
        _task(client, name="Focused thing", depth=2, estimated_minutes=30)
        s = _suggest(client)["suggestions"]
        assert [x["name"] for x in s][0] == "Focused thing"
        assert "Deep thing" in [x["name"] for x in s]
        row = next(x for x in s if x["name"] == "Focused thing")
        assert any("matches the current window" in r for r in row["reasons"])

    def test_protected_window_hides_mismatch_unless_urgent(self, client):
        client.post("/depth-windows", json={
            "depth": 1, "weekday": 1, "start_minutes": 12 * 60, "end_minutes": 16 * 60,
            "protected": True})
        _task(client, name="Admin batch", depth=3, estimated_minutes=20)
        _task(client, name="Urgent admin", depth=3, estimated_minutes=20, due_date="2026-08-25")
        names = [x["name"] for x in _suggest(client)["suggestions"]]
        assert "Admin batch" not in names
        assert "Urgent admin" in names


class TestScheduleFromGrid:
    def test_scheduling_preserves_count_and_order(self, client):
        a = _task(client, name="A")
        b = _task(client, name="B", estimated_minutes=90)
        c = _task(client, name="C")
        before = [t["name"] for t in client.get("/tasks").json()]
        _session(client, b["id"], "2026-08-26T09:00", "2026-08-26T10:30")
        after = client.get("/tasks").json()
        assert [t["name"] for t in after] == before == ["A", "B", "C"]
        assert len(after) == 3
        target = next(t for t in after if t["id"] == b["id"])
        assert target["section"] == "General"
        assert target["scheduled_pending_minutes"] == 90


class TestDeadlineCoverage:
    def test_exact_arithmetic(self, client):
        # Estimate 240, logged 60, 120 scheduled before due, 90 after due,
        # one skipped session that must not count.
        t = _task(client, name="ISYE Project", estimated_minutes=240, due_date="2026-08-27")
        done = _session(client, t["id"], "2026-08-24T09:00", "2026-08-24T10:00")
        client.patch(f"/sessions/{done['id']}", json={"status": "completed", "actual_minutes": 60})
        _session(client, t["id"], "2026-08-26T09:00", "2026-08-26T11:00")   # 120m before due
        _session(client, t["id"], "2026-08-28T09:00", "2026-08-28T10:30")   # 90m after due
        skipped = _session(client, t["id"], "2026-08-26T14:00", "2026-08-26T15:00")
        client.patch(f"/sessions/{skipped['id']}", json={"status": "skipped"})
        got = client.get(f"/tasks/{t['id']}").json()
        assert got["logged_minutes"] == 60
        assert got["remaining_minutes"] == 180
        assert got["scheduled_before_due_minutes"] == 120
        assert got["remaining_unscheduled_before_due"] == 60

    def test_no_estimate_omits_coverage(self, client):
        t = _task(client, name="No est", due_date="2026-08-27")
        got = client.get(f"/tasks/{t['id']}").json()
        assert got["scheduled_before_due_minutes"] is None
        assert got["remaining_unscheduled_before_due"] is None

    def test_deadline_reminder_fires_only_when_uncovered(self, client):
        t = _task(client, name="Covered project", estimated_minutes=60, due_date="2026-08-26")
        _session(client, t["id"], "2026-08-26T09:00", "2026-08-26T10:00")
        _task(client, name="Uncovered project", estimated_minutes=120, due_date="2026-08-26")
        rems = client.get("/reminders", params={"now": NOW}).json()
        deadline = [r for r in rems if r["type"] == "deadline"]
        assert len(deadline) == 1
        assert "Uncovered project" in deadline[0]["title"]
        assert "2h" in deadline[0]["title"]


CAL_ICS = (
    "BEGIN:VCALENDAR\r\nVERSION:2.0\r\n"
    "BEGIN:VEVENT\r\nUID:lecture@qa\r\nSUMMARY:ISYE Lecture\r\n"
    "DTSTART:20260825T110000\r\nDTEND:20260825T121500\r\n"
    "RRULE:FREQ=WEEKLY;BYDAY=TU,TH;COUNT=10\r\nEND:VEVENT\r\n"
    "BEGIN:VEVENT\r\nUID:meeting@qa\r\nSUMMARY:Research Meeting\r\n"
    "DTSTART:20260828T140000\r\nDTEND:20260828T150000\r\nEND:VEVENT\r\n"
    "END:VCALENDAR\r\n"
)


def _calendar(client, monkeypatch, text=CAL_ICS):
    monkeypatch.setattr(main_module, "_fetch_ics_text", lambda url: text)
    res = client.post("/external-calendars", json={"name": "GT", "url": "https://x.test/secret-abc123/basic.ics"})
    assert res.status_code == 201
    return res.json()


class TestContexts:
    def test_crud_and_association(self, client, monkeypatch):
        cal = _calendar(client, monkeypatch)
        ctx = client.post("/contexts", json={"name": "ISYE 2027"}).json()
        t = _task(client, name="Homework 3", context_id=ctx["id"])
        assert t["context_id"] == ctx["id"]
        assert t["context_name"] == "ISYE 2027"
        # associate the lecture series
        res = client.post("/context-event-links", json={
            "context_id": ctx["id"], "calendar_id": cal["id"], "uid": "lecture@qa"})
        assert res.status_code == 201
        evs = client.get("/external-events", params={"start": "2026-08-25", "end": "2026-08-25"}).json()
        lecture = next(e for e in evs if e["uid"] == "lecture@qa")
        assert lecture["context_name"] == "ISYE 2027"
        # rename keeps identity + associations
        client.patch(f"/contexts/{ctx['id']}", json={"name": "ISYE 2027 — Fall"})
        assert client.get(f"/tasks/{t['id']}").json()["context_name"] == "ISYE 2027 — Fall"
        listed = client.get("/contexts").json()
        assert listed[0]["task_count"] == 1
        assert listed[0]["event_link_count"] == 1

    def test_find_or_create_by_name(self, client):
        a = client.post("/contexts", json={"name": "CS 1332"}).json()
        b = client.post("/contexts", json={"name": "CS 1332"}).json()
        assert a["id"] == b["id"]

    def test_removing_association_keeps_records(self, client, monkeypatch):
        cal = _calendar(client, monkeypatch)
        ctx = client.post("/contexts", json={"name": "X"}).json()
        t = _task(client, name="T", context_id=ctx["id"])
        client.post("/context-event-links", json={
            "context_id": ctx["id"], "calendar_id": cal["id"], "uid": "lecture@qa"})
        client.delete("/context-event-links", params={"calendar_id": cal["id"], "uid": "lecture@qa"})
        client.patch(f"/tasks/{t['id']}", json={"context_id": None})
        assert client.get(f"/tasks/{t['id']}").json()["context_id"] is None
        assert len(client.get("/external-events", params={"start": "2026-08-25", "end": "2026-08-25"}).json()) > 0

    def test_deleting_context_never_deletes_tasks(self, client):
        ctx = client.post("/contexts", json={"name": "Doomed"}).json()
        t = _task(client, name="Survivor", context_id=ctx["id"])
        client.delete(f"/contexts/{ctx['id']}")
        got = client.get(f"/tasks/{t['id']}").json()
        assert got["name"] == "Survivor"
        assert got["context_id"] is None


class TestTaskEventLinks:
    def _setup(self, client, monkeypatch):
        cal = _calendar(client, monkeypatch)
        t = _task(client, name="Prepare plots")
        return cal, t

    def test_relations_and_offset(self, client, monkeypatch):
        cal, t = self._setup(client, monkeypatch)
        link = client.post("/task-event-links", json={
            "task_id": t["id"], "calendar_id": cal["id"], "uid": "meeting@qa",
            "relation": "before", "offset_minutes": 30, "event_start": "2026-08-28T14:00"}).json()
        assert link["relation"] == "before"
        assert link["offset_minutes"] == 30
        assert link["event_status"] == "ok"
        assert link["task_done"] is False
        client.patch(f"/task-event-links/{link['id']}", json={"relation": "after"})
        listed = client.get("/task-event-links", params={"task_id": t["id"], "now": NOW}).json()
        assert listed[0]["relation"] == "after"

    def test_invalid_relation_rejected(self, client, monkeypatch):
        cal, t = self._setup(client, monkeypatch)
        res = client.post("/task-event-links", json={
            "task_id": t["id"], "calendar_id": cal["id"], "uid": "meeting@qa", "relation": "during"})
        assert res.status_code == 422

    def test_moved_event_detected(self, client, monkeypatch):
        cal, t = self._setup(client, monkeypatch)
        client.post("/task-event-links", json={
            "task_id": t["id"], "calendar_id": cal["id"], "uid": "meeting@qa",
            "relation": "before", "event_start": "2026-08-28T14:00"})
        moved = CAL_ICS.replace("20260828T140000", "20260828T150000").replace("20260828T150000\r\nEND", "20260828T160000\r\nEND")
        monkeypatch.setattr(main_module, "_fetch_ics_text", lambda url: moved)
        client.post(f"/external-calendars/{cal['id']}/sync")
        link = client.get("/task-event-links", params={"task_id": t["id"], "now": NOW}).json()[0]
        assert link["event_status"] == "moved"
        assert link["next_start"] == "2026-08-28T15:00"

    def test_cancelled_event_keeps_task(self, client, monkeypatch):
        cal, t = self._setup(client, monkeypatch)
        client.post("/task-event-links", json={
            "task_id": t["id"], "calendar_id": cal["id"], "uid": "meeting@qa",
            "relation": "after", "event_start": "2026-08-28T14:00"})
        no_meeting = CAL_ICS.replace("BEGIN:VEVENT\r\nUID:meeting@qa", "BEGIN:X\r\nUID:meeting@qa")
        monkeypatch.setattr(main_module, "_fetch_ics_text", lambda url: no_meeting)
        client.post(f"/external-calendars/{cal['id']}/sync")
        link = client.get("/task-event-links", params={"task_id": t["id"], "now": NOW}).json()[0]
        assert link["event_status"] == "cancelled"
        assert client.get(f"/tasks/{t['id']}").status_code == 200  # task survives
        # detach works
        client.delete(f"/task-event-links/{link['id']}")
        assert client.get("/task-event-links", params={"task_id": t["id"]}).json() == []


class TestReminders:
    def test_prep_reminder_only_when_incomplete(self, client, monkeypatch):
        cal = _calendar(client, monkeypatch)
        t = _task(client, name="Read paper")
        client.post("/task-event-links", json={
            "task_id": t["id"], "calendar_id": cal["id"], "uid": "meeting@qa", "relation": "before"})
        rems = client.get("/reminders", params={"now": "2026-08-28T10:00"}).json()
        assert any(r["type"] == "prep" and "Read paper" in r["title"] for r in rems)
        # complete the task → reminder silent
        client.post("/completions", params={"task_id": t["id"], "completion_date": "2026-08-25"})
        rems2 = client.get("/reminders", params={"now": "2026-08-28T10:00"}).json()
        assert not any(r["type"] == "prep" for r in rems2)

    def test_followup_after_event(self, client, monkeypatch):
        cal = _calendar(client, monkeypatch)
        t = _task(client, name="Send follow-up")
        client.post("/task-event-links", json={
            "task_id": t["id"], "calendar_id": cal["id"], "uid": "meeting@qa",
            "relation": "after", "offset_minutes": 15})
        # meeting ends 15:00 Fri; at 15:20 the 15m offset has elapsed
        rems = client.get("/reminders", params={"now": "2026-08-28T15:20"}).json()
        assert any(r["type"] == "followup" and "Send follow-up" in r["title"] for r in rems)
        # before the offset elapses → silent
        rems2 = client.get("/reminders", params={"now": "2026-08-28T15:10"}).json()
        assert not any(r["type"] == "followup" for r in rems2)

    def test_session_and_event_soon(self, client, monkeypatch):
        cal = _calendar(client, monkeypatch)
        t = _task(client, name="Warmup")
        _session(client, t["id"], "2026-08-25T13:10", "2026-08-25T14:00")
        rems = client.get("/reminders", params={"now": NOW}).json()
        assert any(r["type"] == "session_soon" and "Warmup" in r["title"] for r in rems)
        rems2 = client.get("/reminders", params={"now": "2026-08-25T10:50"}).json()
        assert any(r["type"] == "event_soon" and "ISYE Lecture" in r["title"] for r in rems2)

    def test_class_review_after_context_linked_event(self, client, monkeypatch):
        cal = _calendar(client, monkeypatch)
        ctx = client.post("/contexts", json={"name": "ISYE 2027"}).json()
        client.post("/context-event-links", json={
            "context_id": ctx["id"], "calendar_id": cal["id"], "uid": "lecture@qa"})
        rems = client.get("/reminders", params={"now": "2026-08-25T12:45"}).json()
        review = [r for r in rems if r["type"] == "class_review"]
        assert len(review) == 1
        assert review[0]["context_name"] == "ISYE 2027"
        # two hours later → outside the window, silent
        rems2 = client.get("/reminders", params={"now": "2026-08-25T14:30"}).json()
        assert not any(r["type"] == "class_review" for r in rems2)

    def test_reminder_keys_are_stable(self, client, monkeypatch):
        cal = _calendar(client, monkeypatch)
        a = client.get("/reminders", params={"now": "2026-08-25T10:50"}).json()
        b = client.get("/reminders", params={"now": "2026-08-25T10:50"}).json()
        assert [r["key"] for r in a] == [r["key"] for r in b]


class TestIcsSecretHandling:
    def test_list_response_never_contains_url(self, client, monkeypatch):
        _calendar(client, monkeypatch)
        cals = client.get("/external-calendars").json()
        text = str(cals)
        assert "secret-abc123" not in text
        assert "url_host" in cals[0]
        assert cals[0]["url_host"] == "x.test"
        assert "url" not in cals[0]

    def test_sync_error_redacts_url(self, client, monkeypatch):
        cal = _calendar(client, monkeypatch)

        def boom(url):
            raise OSError(f"cannot reach {url}")
        monkeypatch.setattr(main_module, "_fetch_ics_text", boom)
        res = client.post(f"/external-calendars/{cal['id']}/sync")
        assert res.status_code == 502
        assert "secret-abc123" not in res.json()["detail"]
        cals = client.get("/external-calendars").json()
        assert "secret-abc123" not in (cals[0]["last_error"] or "")
