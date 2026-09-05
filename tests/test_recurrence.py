"""
Calendar recurrence (Calendar Recurring Tasks ticket).

A recurrence_series describes recurring SCHEDULED sessions ("every Tuesday
3–4 PM") for one canonical task or one calendar-only entry. These tests pin
the ticket's core invariants:
  - recurrence never duplicates canonical tasks (§1) and calendar-only
    series create zero Grid records (§25/§45)
  - occurrence materialization is lazy, bounded, and duplicate-proof (§31–33)
  - every occurrence stays individually executable/movable (§12, §14, §41)
  - This-and-following / All edits preserve executed history (§42–43)
  - deleting one occurrence records a skip that survives regeneration (§44)
  - Finished tasks stop future generation without touching history (§46)
  - the NL parser understands obvious recurrence phrasing (§36)

Dates are computed relative to date.today() because materialization always
covers series-start→today (missed past occurrences must reach
reconciliation).
"""
from datetime import date, timedelta


def _make_task(client, name="Task", **overrides):
    params = {"name": name}
    params.update(overrides)
    res = client.post("/tasks", params=params)
    assert res.status_code == 201, res.text
    return res.json()


def _make_session(client, task_id=None, start=None, end=None, **extra):
    body = {"planned_start": start, "planned_end": end}
    if task_id is not None:
        body["task_id"] = task_id
    body.update(extra)
    res = client.post("/sessions", json=body)
    assert res.status_code == 201, res.text
    return res.json()


def _next_weekday(wd, base=None, min_ahead=0):
    base = base or date.today()
    ahead = (wd - base.weekday()) % 7
    if ahead < min_ahead:
        ahead += 7
    return base + timedelta(days=ahead)


def _sessions_in(client, start, end):
    res = client.get("/sessions", params={
        "start": start.isoformat(), "end": end.isoformat()})
    assert res.status_code == 200, res.text
    return res.json()


def _task_count(client):
    return len(client.get("/tasks").json())


class TestSeriesCreate:
    def test_quick_weekly_from_anchor_session(self, client):
        # §40 — drag Tuesday 3–4, pick a task, click Weekly, save.
        t = _make_task(client, name="Review ISYE")
        tue = _next_weekday(1)
        s = _make_session(client, t["id"],
                          start=f"{tue}T15:00", end=f"{tue}T16:00")
        before = _task_count(client)
        res = client.post("/recurrence-series", json={"from_session_id": s["id"]})
        assert res.status_code == 201, res.text
        series = res.json()
        assert series["task_id"] == t["id"]
        assert series["weekdays"] == [1]
        assert series["interval_weeks"] == 1
        assert series["start_date"] == tue.isoformat()
        assert series["start_minutes"] == 15 * 60
        assert series["duration_minutes"] == 60
        assert "Tuesday" in series["label"]

        rows = _sessions_in(client, tue, tue + timedelta(days=14))
        assert [r["planned_start"] for r in rows] == [
            f"{tue}T15:00",
            f"{tue + timedelta(days=7)}T15:00",
            f"{tue + timedelta(days=14)}T15:00",
        ]
        # The anchor was adopted, not duplicated, and all rows share the series.
        assert rows[0]["id"] == s["id"]
        assert all(r["series_id"] == series["id"] for r in rows)
        assert all(r["task_id"] == t["id"] for r in rows)
        # §1/§40 — canonical Grid task count unchanged.
        assert _task_count(client) == before

    def test_calendar_only_mwf_series(self, client):
        # §45 — Gym Mon/Wed/Fri 6–7 PM, calendar-only.
        mon = _next_weekday(0)
        s = _make_session(client, title="Gym",
                          start=f"{mon}T18:00", end=f"{mon}T19:00")
        res = client.post("/recurrence-series", json={
            "from_session_id": s["id"], "weekdays": [0, 2, 4]})
        assert res.status_code == 201, res.text
        rows = _sessions_in(client, mon, mon + timedelta(days=6))
        assert len(rows) == 3
        assert all(r["task_id"] is None for r in rows)
        assert all(r["task_name"] == "Gym" for r in rows)
        assert _task_count(client) == 0

        # Completing one occurrence creates no Grid completion anywhere.
        done = rows[1]
        assert client.patch(f"/sessions/{done['id']}",
                            json={"status": "completed"}).status_code == 200
        comps = client.get("/completions", params={
            "start": mon.isoformat(),
            "end": (mon + timedelta(days=6)).isoformat()}).json()
        assert comps == []
        # Future occurrences remain scheduled (§17 — no propagation).
        rows = _sessions_in(client, mon, mon + timedelta(days=6))
        statuses = {r["id"]: r["status"] for r in rows}
        assert statuses[done["id"]] == "completed"
        assert [v for k, v in statuses.items() if k != done["id"]] == ["scheduled", "scheduled"]

    def test_bare_series_without_anchor(self, client):
        wed = _next_weekday(2)
        res = client.post("/recurrence-series", json={
            "title": "Chapter meeting", "weekdays": [2],
            "start_date": wed.isoformat(),
            "start_minutes": 19 * 60, "duration_minutes": 60,
        })
        assert res.status_code == 201, res.text
        rows = _sessions_in(client, wed, wed + timedelta(days=7))
        assert [r["planned_start"] for r in rows] == [
            f"{wed}T19:00", f"{wed + timedelta(days=7)}T19:00"]

    def test_adopting_twice_conflicts(self, client):
        t = _make_task(client)
        tue = _next_weekday(1)
        s = _make_session(client, t["id"], start=f"{tue}T15:00", end=f"{tue}T16:00")
        assert client.post("/recurrence-series",
                           json={"from_session_id": s["id"]}).status_code == 201
        assert client.post("/recurrence-series",
                           json={"from_session_id": s["id"]}).status_code == 409

    def test_validation(self, client):
        assert client.post("/recurrence-series", json={
            "title": "X", "weekdays": [], "start_date": "2026-09-08",
            "start_minutes": 60, "duration_minutes": 60}).status_code == 422
        assert client.post("/recurrence-series", json={
            "title": "X", "weekdays": [7], "start_date": "2026-09-08",
            "start_minutes": 60, "duration_minutes": 60}).status_code == 422
        assert client.post("/recurrence-series", json={
            "weekdays": [1], "start_date": "2026-09-08",
            "start_minutes": 60, "duration_minutes": 60}).status_code == 422
        assert client.post("/recurrence-series", json={
            "task_id": 9999, "weekdays": [1], "start_date": "2026-09-08",
            "start_minutes": 60, "duration_minutes": 60}).status_code == 404
        assert client.post("/recurrence-series",
                           json={"from_session_id": 9999}).status_code == 404


class TestGeneration:
    def test_reload_never_duplicates(self, client):
        # §33 — repeated fetches of the same window yield identical rows.
        tue = _next_weekday(1)
        s = _make_session(client, title="Rec", start=f"{tue}T15:00", end=f"{tue}T16:00")
        client.post("/recurrence-series", json={"from_session_id": s["id"]})
        first = _sessions_in(client, tue, tue + timedelta(days=28))
        second = _sessions_in(client, tue, tue + timedelta(days=28))
        assert [r["id"] for r in first] == [r["id"] for r in second]
        assert len(first) == 5

    def test_generation_bounded_by_window(self, client):
        # §31/§32 — a 'Never' series only materializes what a fetch covers.
        tue = _next_weekday(1)
        s = _make_session(client, title="Rec", start=f"{tue}T15:00", end=f"{tue}T16:00")
        client.post("/recurrence-series", json={"from_session_id": s["id"]})
        _sessions_in(client, tue, tue + timedelta(days=7))
        all_rows = _sessions_in(client, tue, tue + timedelta(days=365))
        # After the wide fetch the horizon fills; the narrow fetch alone
        # had created only what it needed (2), never years ahead.
        assert len(all_rows) == 53

    def test_until_date_ends_series(self, client):
        # §8 — Every Tuesday until three weeks out.
        tue = _next_weekday(1)
        until = tue + timedelta(days=14)
        s = _make_session(client, title="Rec", start=f"{tue}T15:00", end=f"{tue}T16:00")
        client.post("/recurrence-series", json={
            "from_session_id": s["id"], "until_date": until.isoformat()})
        rows = _sessions_in(client, tue, tue + timedelta(days=60))
        assert len(rows) == 3

    def test_count_ends_series(self, client):
        tue = _next_weekday(1)
        s = _make_session(client, title="Rec", start=f"{tue}T15:00", end=f"{tue}T16:00")
        client.post("/recurrence-series", json={"from_session_id": s["id"], "count": 4})
        rows = _sessions_in(client, tue, tue + timedelta(days=120))
        assert len(rows) == 4

    def test_every_two_weeks(self, client):
        # §7 — interval 2 skips the in-between weeks.
        wed = _next_weekday(2)
        s = _make_session(client, title="Rec", start=f"{wed}T10:00", end=f"{wed}T11:00")
        client.post("/recurrence-series", json={
            "from_session_id": s["id"], "interval_weeks": 2})
        rows = _sessions_in(client, wed, wed + timedelta(days=28))
        assert [r["planned_start"][:10] for r in rows] == [
            wed.isoformat(),
            (wed + timedelta(days=14)).isoformat(),
            (wed + timedelta(days=28)).isoformat(),
        ]

    def test_past_occurrences_materialize_for_reconciliation(self, client):
        # §34 — a series anchored in the past fills in missed occurrences up
        # to today even when only a current window is fetched.
        anchor = _next_weekday(1) - timedelta(days=21)
        res = client.post("/recurrence-series", json={
            "title": "Old series", "weekdays": [1],
            "start_date": anchor.isoformat(),
            "start_minutes": 9 * 60, "duration_minutes": 30})
        assert res.status_code == 201
        today = date.today()
        _sessions_in(client, today, today + timedelta(days=1))
        rows = _sessions_in(client, anchor, today)
        assert len(rows) >= 3


class TestOccurrenceIndependence:
    def _weekly(self, client, title="Rec", minute="15:00", end_minute="16:00"):
        tue = _next_weekday(1)
        s = _make_session(client, title=title,
                          start=f"{tue}T{minute}", end=f"{tue}T{end_minute}")
        series = client.post("/recurrence-series",
                             json={"from_session_id": s["id"]}).json()
        rows = _sessions_in(client, tue, tue + timedelta(days=14))
        return tue, series, rows

    def test_move_one_occurrence_only(self, client):
        # §14/§41 — dragging next week's occurrence moves that one only,
        # persists across regeneration, and detaches it.
        tue, series, rows = self._weekly(client)
        target = rows[1]
        res = client.patch(f"/sessions/{target['id']}", json={
            "planned_start": f"{tue + timedelta(days=7)}T17:00",
            "planned_end": f"{tue + timedelta(days=7)}T18:00",
        })
        assert res.status_code == 200
        assert res.json()["series_detached"] == 1

        rows = _sessions_in(client, tue, tue + timedelta(days=14))
        assert [r["planned_start"] for r in rows] == [
            f"{tue}T15:00",
            f"{tue + timedelta(days=7)}T17:00",
            f"{tue + timedelta(days=14)}T15:00",
        ]
        # The moved slot is not regenerated at its old time (§33).
        assert len(rows) == 3

    def test_completion_does_not_propagate(self, client):
        # §17 — completing one occurrence leaves the rest scheduled.
        tue, series, rows = self._weekly(client)
        assert client.patch(f"/sessions/{rows[0]['id']}", json={
            "status": "completed", "actual_minutes": 55}).status_code == 200
        rows = _sessions_in(client, tue, tue + timedelta(days=14))
        assert [r["status"] for r in rows] == ["completed", "scheduled", "scheduled"]
        # Reconciling did not detach the occurrence — it is execution, not a
        # schedule exception.
        assert rows[0]["series_detached"] == 0

    def test_delete_one_occurrence_skips_forever(self, client):
        # §15/§44 — deleting one occurrence records a skip; the series
        # continues and reload does not resurrect the deleted slot.
        tue, series, rows = self._weekly(client)
        gone = rows[1]
        res = client.delete(f"/sessions/{gone['id']}")
        assert res.status_code == 200
        assert res.json()["scope"] == "occurrence"
        rows = _sessions_in(client, tue, tue + timedelta(days=14))
        assert [r["planned_start"][:10] for r in rows] == [
            tue.isoformat(), (tue + timedelta(days=14)).isoformat()]

    def test_delete_following(self, client):
        tue, series, rows = self._weekly(client)
        res = client.delete(f"/sessions/{rows[1]['id']}", params={"scope": "following"})
        assert res.status_code == 200
        rows = _sessions_in(client, tue, tue + timedelta(days=60))
        assert [r["planned_start"][:10] for r in rows] == [tue.isoformat()]
        s = [x for x in client.get("/recurrence-series").json() if x["id"] == series["id"]][0]
        assert s["until_date"] == (tue + timedelta(days=6)).isoformat()

    def test_delete_all_preserves_executed_history(self, client):
        # §39 — destroying the series never destroys executed truth.
        tue, series, rows = self._weekly(client)
        client.patch(f"/sessions/{rows[0]['id']}", json={
            "status": "completed", "actual_minutes": 60})
        res = client.delete(f"/sessions/{rows[1]['id']}", params={"scope": "all"})
        assert res.status_code == 200
        rows = _sessions_in(client, tue, tue + timedelta(days=60))
        assert len(rows) == 1
        assert rows[0]["status"] == "completed"
        assert rows[0]["series_id"] is None  # history row survives the series
        assert client.get("/recurrence-series").json() == []

    def test_remove_detached_occurrence_stays_gone(self, client):
        # §15 (bugfix) — a moved/detached occurrence removes cleanly: the
        # skip is recorded under its original slot, so neither the moved
        # position nor the original slot ever regenerates.
        tue, series, rows = self._weekly(client)
        moved = rows[1]
        client.patch(f"/sessions/{moved['id']}", json={
            "planned_start": f"{tue + timedelta(days=8)}T10:00",
            "planned_end": f"{tue + timedelta(days=8)}T11:00"})
        assert client.delete(f"/sessions/{moved['id']}").status_code == 200
        rows = _sessions_in(client, tue, tue + timedelta(days=14))
        assert [r["planned_start"][:10] for r in rows] == [
            tue.isoformat(), (tue + timedelta(days=14)).isoformat()]
        # Second reload: still no orphan and no resurrection.
        rows = _sessions_in(client, tue, tue + timedelta(days=14))
        assert len(rows) == 2

    def test_remove_following_from_detached_occurrence(self, client):
        # Broader scope from a detached occurrence operates on the series
        # from its logical slot date, not its moved position.
        tue, series, rows = self._weekly(client)
        moved = rows[1]
        client.patch(f"/sessions/{moved['id']}", json={
            "planned_start": f"{tue + timedelta(days=8)}T10:00",
            "planned_end": f"{tue + timedelta(days=8)}T11:00"})
        res = client.delete(f"/sessions/{moved['id']}", params={"scope": "following"})
        assert res.status_code == 200
        rows = _sessions_in(client, tue, tue + timedelta(days=60))
        assert [r["planned_start"][:10] for r in rows] == [tue.isoformat()]
        s = [x for x in client.get("/recurrence-series").json() if x["id"] == series["id"]][0]
        assert s["until_date"] == (tue + timedelta(days=6)).isoformat()

    def test_remove_all_keeps_linked_task(self, client):
        # §8 (bugfix) — removing a linked series never touches the canonical
        # Grid task; the count stays exactly as it was.
        t = _make_task(client, name="EAS 1601 Lab")
        wed = _next_weekday(2)
        s = _make_session(client, t["id"], start=f"{wed}T15:15", end=f"{wed}T18:15")
        client.post("/recurrence-series", json={"from_session_id": s["id"]})
        rows = _sessions_in(client, wed, wed + timedelta(days=14))
        assert client.delete(f"/sessions/{rows[0]['id']}",
                             params={"scope": "all"}).status_code == 200
        assert _sessions_in(client, wed, wed + timedelta(days=60)) == []
        assert _task_count(client) == 1
        assert client.get(f"/tasks/{t['id']}").status_code == 200

    def test_remove_one_off_never_restored(self, client):
        # Non-recurring baseline (bugfix §18): removing a one-off linked
        # session deletes exactly that row, reload restores nothing, and the
        # canonical task survives.
        t = _make_task(client)
        tue = _next_weekday(1)
        s = _make_session(client, t["id"], start=f"{tue}T09:00", end=f"{tue}T10:00")
        assert client.delete(f"/sessions/{s['id']}").status_code == 200
        assert _sessions_in(client, tue, tue + timedelta(days=7)) == []
        assert _sessions_in(client, tue, tue + timedelta(days=7)) == []
        assert client.get(f"/tasks/{t['id']}").status_code == 200

    def test_scope_validation(self, client):
        t = _make_task(client)
        tue = _next_weekday(1)
        s = _make_session(client, t["id"], start=f"{tue}T15:00", end=f"{tue}T16:00")
        assert client.delete(f"/sessions/{s['id']}",
                             params={"scope": "bogus"}).status_code == 422
        # Scoped delete of a non-recurring session is meaningless.
        assert client.delete(f"/sessions/{s['id']}",
                             params={"scope": "following"}).status_code == 422


class TestSeriesEdit:
    def _history_series(self, client):
        """Weekly Tuesday series anchored 2 weeks back; first occurrence
        executed at its original 3 PM hour."""
        anchor = _next_weekday(1) - timedelta(days=14)
        res = client.post("/recurrence-series", json={
            "title": "Rec", "weekdays": [1], "start_date": anchor.isoformat(),
            "start_minutes": 15 * 60, "duration_minutes": 60})
        series = res.json()
        rows = _sessions_in(client, anchor, anchor + timedelta(days=28))
        client.patch(f"/sessions/{rows[0]['id']}", json={
            "status": "completed", "actual_minutes": 60})
        return anchor, series

    def test_this_and_following_split(self, client):
        # §16/§42 — history keeps 3 PM; the split point onward moves to 4 PM.
        anchor, series = self._history_series(client)
        split = anchor + timedelta(days=14)
        res = client.patch(f"/recurrence-series/{series['id']}", json={
            "scope": "following", "from_date": split.isoformat(),
            "start_minutes": 16 * 60})
        assert res.status_code == 200, res.text
        body = res.json()
        assert body["series"]["until_date"] == (split - timedelta(days=1)).isoformat()
        assert body["new_series"]["start_minutes"] == 16 * 60
        assert body["new_series"]["start_date"] == split.isoformat()

        rows = _sessions_in(client, anchor, anchor + timedelta(days=28))
        assert [r["planned_start"] for r in rows] == [
            f"{anchor}T15:00",
            f"{anchor + timedelta(days=7)}T15:00",
            f"{split}T16:00",
            f"{split + timedelta(days=7)}T16:00",
            f"{split + timedelta(days=14)}T16:00",
        ]
        assert rows[0]["status"] == "completed"  # actual history untouched

    def test_all_scope_replans_future_only(self, client):
        # §43 — 60m → 45m for all occurrences: executed/past keep 60m truth,
        # future planned occurrences re-plan at 45m.
        anchor, series = self._history_series(client)
        res = client.patch(f"/recurrence-series/{series['id']}", json={
            "scope": "all", "duration_minutes": 45})
        assert res.status_code == 200, res.text
        rows = _sessions_in(client, anchor, anchor + timedelta(days=28))
        future = [r for r in rows if r["planned_start"][:10] >= date.today().isoformat()]
        past = [r for r in rows if r["planned_start"][:10] < date.today().isoformat()]
        assert all(r["planned_minutes"] == 45 for r in future)
        assert all(r["planned_minutes"] == 60 for r in past)
        assert rows[0]["status"] == "completed"

    def test_all_scope_leaves_detached_exception_alone(self, client):
        tue = _next_weekday(1)
        s = _make_session(client, title="Rec", start=f"{tue}T15:00", end=f"{tue}T16:00")
        series = client.post("/recurrence-series",
                             json={"from_session_id": s["id"]}).json()
        rows = _sessions_in(client, tue, tue + timedelta(days=14))
        moved = rows[1]
        client.patch(f"/sessions/{moved['id']}", json={
            "planned_start": f"{tue + timedelta(days=7)}T18:00",
            "planned_end": f"{tue + timedelta(days=7)}T19:00"})
        client.patch(f"/recurrence-series/{series['id']}", json={
            "scope": "all", "start_minutes": 16 * 60})
        rows = _sessions_in(client, tue, tue + timedelta(days=14))
        by_date = {r["planned_start"][:10]: r["planned_start"][11:] for r in rows}
        assert by_date[(tue + timedelta(days=7)).isoformat()] == "18:00"
        assert by_date[(tue + timedelta(days=14)).isoformat()] == "16:00"

    def test_stop_recurrence_from_date(self, client):
        # §38 — stop starting a chosen day; history intact, nothing after.
        anchor, series = self._history_series(client)
        stop_from = anchor + timedelta(days=14)
        res = client.delete(f"/recurrence-series/{series['id']}",
                            params={"from_date": stop_from.isoformat()})
        assert res.status_code == 200
        assert res.json()["until_date"] == (stop_from - timedelta(days=1)).isoformat()
        rows = _sessions_in(client, anchor, anchor + timedelta(days=90))
        assert [r["planned_start"][:10] for r in rows] == [
            anchor.isoformat(), (anchor + timedelta(days=7)).isoformat()]
        assert rows[0]["status"] == "completed"

    def test_skip_survives_split(self, client):
        # A deleted occurrence stays deleted across a this-and-following edit.
        tue = _next_weekday(1)
        s = _make_session(client, title="Rec", start=f"{tue}T15:00", end=f"{tue}T16:00")
        series = client.post("/recurrence-series",
                             json={"from_session_id": s["id"]}).json()
        rows = _sessions_in(client, tue, tue + timedelta(days=21))
        client.delete(f"/sessions/{rows[2]['id']}")  # skip tue+14
        client.patch(f"/recurrence-series/{series['id']}", json={
            "scope": "following", "from_date": (tue + timedelta(days=7)).isoformat(),
            "start_minutes": 16 * 60})
        rows = _sessions_in(client, tue, tue + timedelta(days=21))
        assert [r["planned_start"] for r in rows] == [
            f"{tue}T15:00",
            f"{tue + timedelta(days=7)}T16:00",
            f"{tue + timedelta(days=21)}T16:00",
        ]


class TestFinishedTask:
    def test_finished_task_stops_future_generation(self, client):
        # §46 — historical occurrences remain; future ones are suppressed.
        t = _make_task(client, name="Course review")
        tue = _next_weekday(1)
        s = _make_session(client, t["id"], start=f"{tue}T15:00", end=f"{tue}T16:00")
        client.post("/recurrence-series", json={"from_session_id": s["id"]})
        rows = _sessions_in(client, tue, tue + timedelta(days=28))
        assert len(rows) == 5
        client.patch(f"/sessions/{rows[0]['id']}", json={
            "status": "completed", "actual_minutes": 50})

        end = (tue + timedelta(days=7)).isoformat()
        assert client.patch(f"/tasks/{t['id']}",
                            json={"end_date": end}).status_code == 200
        rows = _sessions_in(client, tue, tue + timedelta(days=56))
        assert [r["planned_start"][:10] for r in rows] == [
            tue.isoformat(), (tue + timedelta(days=7)).isoformat()]
        assert rows[0]["status"] == "completed"  # history untouched


class TestRemainingEffort:
    def test_finite_estimate_not_inflated_by_recurrence(self, client):
        # §18 — recurring sessions consume remaining effort normally; the
        # total estimate never grows because sessions recur.
        t = _make_task(client, name="Research project", estimated_minutes=360)
        tue = _next_weekday(1)
        s = _make_session(client, t["id"], start=f"{tue}T15:00", end=f"{tue}T16:00")
        client.post("/recurrence-series", json={"from_session_id": s["id"], "count": 3})
        _sessions_in(client, tue, tue + timedelta(days=28))
        task = client.get(f"/tasks/{t['id']}").json()
        assert task["estimated_minutes"] == 360
        assert task["scheduled_pending_minutes"] == 180
        assert task["remaining_minutes"] == 360
        assert task["remaining_unscheduled_minutes"] == 180


class TestNaturalLanguageRecurrence:
    NOW = "2026-09-05T12:00"  # a Saturday

    def _parse(self, client, q):
        res = client.get("/nl/parse", params={"q": q, "now": self.NOW})
        assert res.status_code == 200, res.text
        return res.json()

    def test_every_weekday_at_time(self, client):
        p = self._parse(client, "review ISYE every tuesday at 3 for 45m")
        assert p["recurrence"] == {
            "weekdays": [1], "interval_weeks": 1, "until_date": None}
        assert p["date"] == "2026-09-08"  # next Tuesday anchors the series
        assert p["start_minutes"] == 15 * 60
        assert p["duration_minutes"] == 45
        assert p["title"] == "review ISYE"
        assert any("repeats every Tue" in n for n in p["notes"])

    def test_mwf_shorthand(self, client):
        p = self._parse(client, "gym MWF 6pm for an hour")
        assert p["recurrence"]["weekdays"] == [0, 2, 4]
        assert p["date"] == "2026-09-07"  # nearest of Mon/Wed/Fri
        assert p["start_minutes"] == 18 * 60
        assert p["title"] == "gym"

    def test_every_other(self, client):
        p = self._parse(client, "meeting every other thursday 7pm")
        assert p["recurrence"]["weekdays"] == [3]
        assert p["recurrence"]["interval_weeks"] == 2
        assert p["date"] == "2026-09-10"

    def test_until_date(self, client):
        p = self._parse(client, "review every tuesday 3pm until dec 8")
        assert p["recurrence"]["until_date"] == "2026-12-08"

    def test_multi_day_and(self, client):
        p = self._parse(client, "practice every tue and thu 5pm")
        assert p["recurrence"]["weekdays"] == [1, 3]

    def test_weekly_uses_target_weekday(self, client):
        p = self._parse(client, "standup weekly monday 9am")
        assert p["recurrence"] == {
            "weekdays": [0], "interval_weeks": 1, "until_date": None}
        assert p["date"] == "2026-09-07"

    def test_one_off_has_no_recurrence(self, client):
        p = self._parse(client, "dentist tuesday 2pm")
        assert p["recurrence"] is None
