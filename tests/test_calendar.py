"""
Calendar (P12.0) — task depth/estimate fields, sessions, depth windows.

Sessions are scheduled time allocations toward a task; they are separate rows
from the task and from completions. These tests cover the additive schema and
CRUD endpoints plus the invariants the Calendar UI depends on:
  - depth/estimated_minutes are optional, validated, and clearable
  - sessions require an active task and a positive planned interval
  - range listing uses overlap semantics and hides soft-deleted tasks' sessions
  - session status transitions are constrained to the known states
  - depth windows are exactly one-off (date) or recurring (weekday)
"""
import pytest


def _make_task(client, name="Task", **overrides):
    params = {"name": name}
    params.update(overrides)
    res = client.post("/tasks", params=params)
    assert res.status_code == 201, res.text
    return res.json()


def _make_session(client, task_id, start="2026-08-25T09:00", end="2026-08-25T10:30", **extra):
    body = {"task_id": task_id, "planned_start": start, "planned_end": end}
    body.update(extra)
    res = client.post("/sessions", json=body)
    assert res.status_code == 201, res.text
    return res.json()


class TestTaskDepthFields:
    def test_create_with_depth_and_estimate(self, client):
        t = _make_task(client, depth=1, estimated_minutes=90)
        assert t["depth"] == 1
        assert t["estimated_minutes"] == 90

    def test_defaults_are_null(self, client):
        t = _make_task(client)
        assert t["depth"] is None
        assert t["estimated_minutes"] is None

    def test_create_rejects_invalid_depth(self, client):
        res = client.post("/tasks", params={"name": "X", "depth": 5})
        assert res.status_code == 422

    def test_create_rejects_negative_estimate(self, client):
        res = client.post("/tasks", params={"name": "X", "estimated_minutes": -10})
        assert res.status_code == 422

    def test_patch_sets_depth_via_query(self, client):
        t = _make_task(client)
        res = client.patch(f"/tasks/{t['id']}", params={"depth": 2})
        assert res.status_code == 200
        assert res.json()["depth"] == 2

    def test_patch_zero_clears_depth(self, client):
        t = _make_task(client, depth=3)
        res = client.patch(f"/tasks/{t['id']}", params={"depth": 0})
        assert res.status_code == 200
        assert res.json()["depth"] is None

    def test_patch_json_null_clears_depth(self, client):
        t = _make_task(client, depth=2)
        res = client.patch(f"/tasks/{t['id']}", json={"depth": None})
        assert res.status_code == 200
        assert res.json()["depth"] is None

    def test_patch_rejects_invalid_depth(self, client):
        t = _make_task(client)
        res = client.patch(f"/tasks/{t['id']}", params={"depth": 4})
        assert res.status_code == 422

    def test_patch_estimate_json_body(self, client):
        t = _make_task(client)
        res = client.patch(f"/tasks/{t['id']}", json={"estimated_minutes": 45})
        assert res.status_code == 200
        assert res.json()["estimated_minutes"] == 45

    def test_depth_survives_unrelated_patch(self, client):
        t = _make_task(client, depth=1, estimated_minutes=60)
        res = client.patch(f"/tasks/{t['id']}", params={"priority": 8})
        assert res.status_code == 200
        body = res.json()
        assert body["depth"] == 1
        assert body["estimated_minutes"] == 60


class TestSessionCreate:
    def test_create_returns_session_with_task_info(self, client):
        t = _make_task(client, name="ISYE HW", depth=1)
        s = _make_session(client, t["id"])
        assert s["task_id"] == t["id"]
        assert s["planned_start"] == "2026-08-25T09:00"
        assert s["planned_end"] == "2026-08-25T10:30"
        assert s["planned_minutes"] == 90
        assert s["status"] == "scheduled"
        assert s["is_fixed"] == 0
        assert s["task_name"] == "ISYE HW"
        assert s["task_depth"] == 1
        assert s["actual_start"] is None
        assert s["actual_end"] is None

    def test_future_sessions_allowed(self, client):
        # Unlike completions, sessions are planning objects — future is normal.
        t = _make_task(client)
        s = _make_session(client, t["id"], start="2099-01-01T09:00", end="2099-01-01T10:00")
        assert s["planned_minutes"] == 60

    def test_rejects_unknown_task(self, client):
        res = client.post("/sessions", json={
            "task_id": 9999,
            "planned_start": "2026-08-25T09:00",
            "planned_end": "2026-08-25T10:00",
        })
        assert res.status_code == 404

    def test_rejects_inverted_interval(self, client):
        t = _make_task(client)
        res = client.post("/sessions", json={
            "task_id": t["id"],
            "planned_start": "2026-08-25T10:00",
            "planned_end": "2026-08-25T09:00",
        })
        assert res.status_code == 422

    def test_rejects_zero_length(self, client):
        t = _make_task(client)
        res = client.post("/sessions", json={
            "task_id": t["id"],
            "planned_start": "2026-08-25T09:00",
            "planned_end": "2026-08-25T09:00",
        })
        assert res.status_code == 422

    def test_rejects_malformed_datetime(self, client):
        t = _make_task(client)
        res = client.post("/sessions", json={
            "task_id": t["id"],
            "planned_start": "not-a-time",
            "planned_end": "2026-08-25T10:00",
        })
        assert res.status_code == 422

    def test_multiple_sessions_per_task(self, client):
        # Multi-session model: one canonical task, many scheduled sessions.
        t = _make_task(client)
        _make_session(client, t["id"], start="2026-08-25T09:00", end="2026-08-25T10:00")
        _make_session(client, t["id"], start="2026-08-26T09:00", end="2026-08-26T11:00")
        res = client.get("/sessions", params={"task_id": t["id"]})
        assert res.status_code == 200
        assert len(res.json()) == 2


class TestSessionList:
    def test_requires_filter(self, client):
        assert client.get("/sessions").status_code == 422

    def test_range_overlap_inclusive(self, client):
        t = _make_task(client)
        _make_session(client, t["id"], start="2026-08-24T09:00", end="2026-08-24T10:00")
        _make_session(client, t["id"], start="2026-08-30T22:00", end="2026-08-30T23:00")
        _make_session(client, t["id"], start="2026-09-01T09:00", end="2026-09-01T10:00")
        res = client.get("/sessions", params={"start": "2026-08-24", "end": "2026-08-30"})
        assert res.status_code == 200
        starts = [s["planned_start"] for s in res.json()]
        assert starts == ["2026-08-24T09:00", "2026-08-30T22:00"]

    def test_rejects_bad_dates(self, client):
        res = client.get("/sessions", params={"start": "24/08/2026", "end": "2026-08-30"})
        assert res.status_code == 422

    def test_soft_deleted_task_hides_sessions(self, client):
        t = _make_task(client)
        _make_session(client, t["id"])
        assert client.delete(f"/tasks/{t['id']}").status_code == 200
        res = client.get("/sessions", params={"start": "2026-08-25", "end": "2026-08-25"})
        assert res.json() == []


class TestSessionPatch:
    def test_reschedule_moves_both_ends(self, client):
        t = _make_task(client)
        s = _make_session(client, t["id"])
        res = client.patch(f"/sessions/{s['id']}", json={
            "planned_start": "2026-08-26T14:00",
            "planned_end": "2026-08-26T15:30",
        })
        assert res.status_code == 200
        body = res.json()
        assert body["planned_start"] == "2026-08-26T14:00"
        assert body["planned_minutes"] == 90

    def test_resize_changes_duration(self, client):
        t = _make_task(client)
        s = _make_session(client, t["id"])
        res = client.patch(f"/sessions/{s['id']}", json={"planned_end": "2026-08-25T11:00"})
        assert res.status_code == 200
        assert res.json()["planned_minutes"] == 120

    def test_rejects_inverted_result(self, client):
        t = _make_task(client)
        s = _make_session(client, t["id"])
        res = client.patch(f"/sessions/{s['id']}", json={"planned_end": "2026-08-25T08:00"})
        assert res.status_code == 422

    def test_status_transitions(self, client):
        t = _make_task(client)
        s = _make_session(client, t["id"])
        for status in ("completed", "partial", "skipped", "scheduled"):
            res = client.patch(f"/sessions/{s['id']}", json={"status": status})
            assert res.status_code == 200
            assert res.json()["status"] == status

    def test_rejects_unknown_status(self, client):
        t = _make_task(client)
        s = _make_session(client, t["id"])
        res = client.patch(f"/sessions/{s['id']}", json={"status": "done"})
        assert res.status_code == 422

    def test_session_completion_does_not_touch_task_completions(self, client):
        # Session completion ≠ task completion — the completions table must
        # stay empty when only the session status changes.
        t = _make_task(client)
        s = _make_session(client, t["id"])
        client.patch(f"/sessions/{s['id']}", json={"status": "completed"})
        res = client.get("/completions", params={"start": "2026-08-25", "end": "2026-08-25"})
        assert res.json() == []

    def test_actual_fields_roundtrip_and_clear(self, client):
        t = _make_task(client)
        s = _make_session(client, t["id"])
        res = client.patch(f"/sessions/{s['id']}", json={
            "actual_start": "2026-08-25T09:07",
            "actual_end": "2026-08-25T10:12",
            "actual_minutes": 65,
        })
        assert res.status_code == 200
        body = res.json()
        assert body["actual_start"] == "2026-08-25T09:07"
        assert body["actual_minutes"] == 65
        # Planned history is preserved alongside the actuals.
        assert body["planned_start"] == "2026-08-25T09:00"
        res = client.patch(f"/sessions/{s['id']}", json={"actual_start": "", "actual_end": ""})
        assert res.status_code == 200
        assert res.json()["actual_start"] is None

    def test_fixed_flag(self, client):
        t = _make_task(client)
        s = _make_session(client, t["id"])
        res = client.patch(f"/sessions/{s['id']}", json={"is_fixed": True})
        assert res.status_code == 200
        assert res.json()["is_fixed"] == 1

    def test_patch_unknown_session_404(self, client):
        assert client.patch("/sessions/9999", json={"status": "completed"}).status_code == 404


class TestSessionDelete:
    def test_delete_leaves_task_intact(self, client):
        t = _make_task(client)
        s = _make_session(client, t["id"])
        res = client.delete(f"/sessions/{s['id']}")
        assert res.status_code == 200
        assert client.get("/sessions", params={"task_id": t["id"]}).json() == []
        assert client.get(f"/tasks/{t['id']}").status_code == 200

    def test_delete_unknown_404(self, client):
        assert client.delete("/sessions/9999").status_code == 404


class TestDepthWindows:
    def test_create_one_off(self, client):
        res = client.post("/depth-windows", json={
            "depth": 1, "date": "2026-08-25",
            "start_minutes": 540, "end_minutes": 720,
        })
        assert res.status_code == 201
        w = res.json()
        assert w["depth"] == 1
        assert w["date"] == "2026-08-25"
        assert w["weekday"] is None
        assert w["protected"] == 0

    def test_create_recurring(self, client):
        res = client.post("/depth-windows", json={
            "depth": 2, "weekday": 0,
            "start_minutes": 840, "end_minutes": 960,
        })
        assert res.status_code == 201
        w = res.json()
        assert w["weekday"] == 0
        assert w["date"] is None

    def test_rejects_both_date_and_weekday(self, client):
        res = client.post("/depth-windows", json={
            "depth": 1, "date": "2026-08-25", "weekday": 1,
            "start_minutes": 540, "end_minutes": 720,
        })
        assert res.status_code == 422

    def test_rejects_neither_date_nor_weekday(self, client):
        res = client.post("/depth-windows", json={
            "depth": 1, "start_minutes": 540, "end_minutes": 720,
        })
        assert res.status_code == 422

    def test_rejects_bad_depth(self, client):
        res = client.post("/depth-windows", json={
            "depth": 4, "date": "2026-08-25",
            "start_minutes": 540, "end_minutes": 720,
        })
        assert res.status_code == 422

    def test_rejects_inverted_minutes(self, client):
        res = client.post("/depth-windows", json={
            "depth": 1, "date": "2026-08-25",
            "start_minutes": 720, "end_minutes": 540,
        })
        assert res.status_code == 422

    def test_rejects_out_of_range_minutes(self, client):
        res = client.post("/depth-windows", json={
            "depth": 1, "date": "2026-08-25",
            "start_minutes": 0, "end_minutes": 1441,
        })
        assert res.status_code == 422

    def test_rejects_bad_weekday(self, client):
        res = client.post("/depth-windows", json={
            "depth": 1, "weekday": 7,
            "start_minutes": 540, "end_minutes": 720,
        })
        assert res.status_code == 422

    def test_list_returns_all(self, client):
        client.post("/depth-windows", json={
            "depth": 1, "date": "2026-08-25", "start_minutes": 540, "end_minutes": 720,
        })
        client.post("/depth-windows", json={
            "depth": 3, "weekday": 4, "start_minutes": 960, "end_minutes": 1020,
        })
        res = client.get("/depth-windows")
        assert res.status_code == 200
        assert len(res.json()) == 2

    def test_patch_times_and_protected(self, client):
        w = client.post("/depth-windows", json={
            "depth": 1, "date": "2026-08-25", "start_minutes": 540, "end_minutes": 720,
        }).json()
        res = client.patch(f"/depth-windows/{w['id']}", json={
            "start_minutes": 600, "protected": True,
        })
        assert res.status_code == 200
        body = res.json()
        assert body["start_minutes"] == 600
        assert body["protected"] == 1

    def test_patch_switch_to_recurring(self, client):
        w = client.post("/depth-windows", json={
            "depth": 2, "date": "2026-08-25", "start_minutes": 540, "end_minutes": 720,
        }).json()
        res = client.patch(f"/depth-windows/{w['id']}", json={"weekday": 2})
        assert res.status_code == 200
        body = res.json()
        assert body["weekday"] == 2
        assert body["date"] is None

    def test_patch_rejects_invalid_result(self, client):
        w = client.post("/depth-windows", json={
            "depth": 2, "date": "2026-08-25", "start_minutes": 540, "end_minutes": 720,
        }).json()
        res = client.patch(f"/depth-windows/{w['id']}", json={"end_minutes": 500})
        assert res.status_code == 422

    def test_delete(self, client):
        w = client.post("/depth-windows", json={
            "depth": 1, "date": "2026-08-25", "start_minutes": 540, "end_minutes": 720,
        }).json()
        assert client.delete(f"/depth-windows/{w['id']}").status_code == 200
        assert client.get("/depth-windows").json() == []

    def test_delete_unknown_404(self, client):
        assert client.delete("/depth-windows/9999").status_code == 404


class TestSessionRollups:
    """P13.0 — factual execution rollups attached to task endpoints."""

    def test_no_sessions_yields_zeroes(self, client):
        t = _make_task(client, estimated_minutes=120)
        got = client.get(f"/tasks/{t['id']}").json()
        assert got["logged_minutes"] == 0
        assert got["scheduled_pending_minutes"] == 0
        assert got["remaining_minutes"] == 120
        assert got["remaining_unscheduled_minutes"] == 120

    def test_no_estimate_yields_null_remaining(self, client):
        t = _make_task(client)
        got = client.get(f"/tasks/{t['id']}").json()
        assert got["remaining_minutes"] is None
        assert got["remaining_unscheduled_minutes"] is None

    def test_scheduled_session_counts_as_pending(self, client):
        t = _make_task(client, estimated_minutes=180)
        _make_session(client, t["id"])  # 90m scheduled
        got = client.get(f"/tasks/{t['id']}").json()
        assert got["logged_minutes"] == 0
        assert got["scheduled_pending_minutes"] == 90
        assert got["remaining_minutes"] == 180
        assert got["remaining_unscheduled_minutes"] == 90

    def test_completed_session_logs_planned_when_no_actuals(self, client):
        t = _make_task(client, estimated_minutes=180)
        s = _make_session(client, t["id"])  # 90m
        client.patch(f"/sessions/{s['id']}", json={"status": "completed"})
        got = client.get(f"/tasks/{t['id']}").json()
        assert got["logged_minutes"] == 90
        assert got["scheduled_pending_minutes"] == 0
        assert got["remaining_minutes"] == 90

    def test_completed_session_prefers_actual_minutes(self, client):
        t = _make_task(client, estimated_minutes=180)
        s = _make_session(client, t["id"])  # planned 90m
        client.patch(f"/sessions/{s['id']}", json={"status": "completed", "actual_minutes": 60})
        got = client.get(f"/tasks/{t['id']}").json()
        assert got["logged_minutes"] == 60
        assert got["remaining_minutes"] == 120

    def test_partial_session_logs_only_actual(self, client):
        # Partial completion (§37): a 90m plan reconciled as 45m of work
        # reduces remaining effort by 45m, never the full plan.
        t = _make_task(client, estimated_minutes=180)
        s = _make_session(client, t["id"])
        client.patch(f"/sessions/{s['id']}", json={"status": "partial", "actual_minutes": 45})
        got = client.get(f"/tasks/{t['id']}").json()
        assert got["logged_minutes"] == 45
        assert got["scheduled_pending_minutes"] == 0
        assert got["remaining_minutes"] == 135
        assert got["remaining_unscheduled_minutes"] == 135

    def test_skipped_session_frees_effort(self, client):
        t = _make_task(client, estimated_minutes=120)
        s = _make_session(client, t["id"])  # 90m scheduled
        client.patch(f"/sessions/{s['id']}", json={"status": "skipped"})
        got = client.get(f"/tasks/{t['id']}").json()
        assert got["logged_minutes"] == 0
        assert got["scheduled_pending_minutes"] == 0
        assert got["remaining_unscheduled_minutes"] == 120

    def test_remaining_never_negative(self, client):
        t = _make_task(client, estimated_minutes=60)
        s = _make_session(client, t["id"], start="2026-08-25T09:00", end="2026-08-25T11:00")
        client.patch(f"/sessions/{s['id']}", json={"status": "completed"})  # 120m logged
        got = client.get(f"/tasks/{t['id']}").json()
        assert got["remaining_minutes"] == 0
        assert got["remaining_unscheduled_minutes"] == 0

    def test_rollups_present_in_list_endpoint(self, client):
        t = _make_task(client, estimated_minutes=90)
        _make_session(client, t["id"])
        listed = client.get("/tasks").json()
        row = next(x for x in listed if x["id"] == t["id"])
        assert row["scheduled_pending_minutes"] == 90


class TestDepthWindowSkips:
    """P13.0 — per-day exceptions on recurring windows (§38)."""

    def _weekly(self, client, weekday=1):
        return client.post("/depth-windows", json={
            "depth": 1, "weekday": weekday, "start_minutes": 540, "end_minutes": 720,
        }).json()

    def test_skip_day_on_recurring_window(self, client):
        w = self._weekly(client)
        res = client.post(f"/depth-windows/{w['id']}/skips", json={"date": "2026-08-25"})
        assert res.status_code == 201
        assert res.json()["skips"] == ["2026-08-25"]
        listed = client.get("/depth-windows").json()
        assert listed[0]["skips"] == ["2026-08-25"]

    def test_skip_is_idempotent(self, client):
        w = self._weekly(client)
        client.post(f"/depth-windows/{w['id']}/skips", json={"date": "2026-08-25"})
        res = client.post(f"/depth-windows/{w['id']}/skips", json={"date": "2026-08-25"})
        assert res.status_code == 201
        assert res.json()["skips"] == ["2026-08-25"]

    def test_one_off_window_rejects_skip(self, client):
        w = client.post("/depth-windows", json={
            "depth": 2, "date": "2026-08-25", "start_minutes": 540, "end_minutes": 720,
        }).json()
        res = client.post(f"/depth-windows/{w['id']}/skips", json={"date": "2026-08-25"})
        assert res.status_code == 422

    def test_skip_unknown_window_404(self, client):
        assert client.post("/depth-windows/999/skips", json={"date": "2026-08-25"}).status_code == 404

    def test_skip_bad_date_422(self, client):
        w = self._weekly(client)
        res = client.post(f"/depth-windows/{w['id']}/skips", json={"date": "25/08/2026"})
        assert res.status_code == 422

    def test_deleting_window_removes_skips(self, client):
        w = self._weekly(client)
        client.post(f"/depth-windows/{w['id']}/skips", json={"date": "2026-08-25"})
        client.delete(f"/depth-windows/{w['id']}")
        # Recreate and confirm no orphaned skips bleed into the new window.
        w2 = self._weekly(client)
        listed = client.get("/depth-windows").json()
        assert next(x for x in listed if x["id"] == w2["id"])["skips"] == []


class TestExistingBehaviorPreserved:
    def test_task_endpoints_unchanged_without_calendar_fields(self, client):
        # A task created the pre-calendar way still round-trips identically.
        t = _make_task(client, name="Plain", priority=7, interval_days=3)
        assert t["priority"] == 7
        assert t["depth"] is None
        got = client.get(f"/tasks/{t['id']}").json()
        assert got["name"] == "Plain"
        assert got["urgency"] is not None

    def test_completions_still_reject_future_dates(self, client):
        # Sessions may live in the future; completions must still refuse it.
        t = _make_task(client)
        res = client.post("/completions", params={
            "task_id": t["id"], "completion_date": "2099-01-01",
        })
        assert res.status_code == 422
