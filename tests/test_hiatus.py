"""
Integration tests for persisted hiatus periods (P11.0).

Interval semantics under test:
  - status active→hiatus opens an interval starting today (end_date NULL).
  - status hiatus→active closes it at resume-date − 1 (inclusive end).
  - Same-day hiatus + resume deletes the interval (would be empty).
  - At most one open interval per task; many closed ones allowed.
  - Entering/leaving hiatus never touches completions or cell overrides.
  - Backup/restore round-trips intervals (schema_version 6).
"""
import io
import json
import sqlite3
from datetime import date, timedelta

import backend.database as db_module

TODAY = date.today().isoformat()
YESTERDAY = (date.today() - timedelta(days=1)).isoformat()


def create_task(client, name="Hiatus Task", **kwargs):
    params = {"name": name, **kwargs}
    resp = client.post("/tasks", params=params)
    assert resp.status_code == 201, resp.text
    return resp.json()


def periods_for(client, task_id):
    r = client.get("/task-hiatus-periods", params={"task_id": task_id})
    assert r.status_code == 200, r.text
    return r.json()


def days_ago(n):
    return (date.today() - timedelta(days=n)).isoformat()


class TestHiatusTransitions:
    def test_status_to_hiatus_opens_interval_today(self, client):
        t = create_task(client)
        client.patch(f"/tasks/{t['id']}", params={"status": "hiatus"})
        ps = periods_for(client, t["id"])
        assert len(ps) == 1
        assert ps[0]["start_date"] == TODAY
        assert ps[0]["end_date"] is None

    def test_create_task_as_hiatus_opens_interval(self, client):
        t = create_task(client, status="hiatus")
        ps = periods_for(client, t["id"])
        assert len(ps) == 1
        assert ps[0]["start_date"] == TODAY
        assert ps[0]["end_date"] is None

    def test_no_duplicate_open_interval(self, client):
        t = create_task(client)
        client.patch(f"/tasks/{t['id']}", params={"status": "hiatus"})
        # Re-sending status=hiatus (no transition) must not open another.
        client.patch(f"/tasks/{t['id']}", params={"status": "hiatus"})
        # Saving unrelated fields while on hiatus must not open another.
        client.patch(f"/tasks/{t['id']}", params={"notes": "still paused", "status": "hiatus"})
        assert len(periods_for(client, t["id"])) == 1

    def test_resume_closes_at_resume_minus_one(self, client):
        t = create_task(client)
        client.patch(f"/tasks/{t['id']}", params={"status": "hiatus"})
        pid = periods_for(client, t["id"])[0]["id"]
        # Backdate the interval start so resuming today yields a real range.
        r = client.patch(f"/task-hiatus-periods/{pid}", json={"start_date": days_ago(8)})
        assert r.status_code == 200, r.text
        client.patch(f"/tasks/{t['id']}", params={"status": "active"})
        ps = periods_for(client, t["id"])
        assert len(ps) == 1
        assert ps[0]["start_date"] == days_ago(8)
        assert ps[0]["end_date"] == YESTERDAY  # resume date itself is normal

    def test_same_day_hiatus_resume_leaves_no_interval(self, client):
        t = create_task(client)
        client.patch(f"/tasks/{t['id']}", params={"status": "hiatus"})
        client.patch(f"/tasks/{t['id']}", params={"status": "active"})
        assert periods_for(client, t["id"]) == []

    def test_multiple_closed_intervals_accumulate(self, client):
        t = create_task(client)
        for start in (days_ago(30), days_ago(10)):
            client.patch(f"/tasks/{t['id']}", params={"status": "hiatus"})
            pid = [p for p in periods_for(client, t["id"]) if p["end_date"] is None][0]["id"]
            client.patch(f"/task-hiatus-periods/{pid}", json={"start_date": start})
            client.patch(f"/tasks/{t['id']}", params={"status": "active"})
        ps = periods_for(client, t["id"])
        assert len(ps) == 2
        assert all(p["end_date"] == YESTERDAY for p in ps)
        assert [p["start_date"] for p in ps] == [days_ago(30), days_ago(10)]

    def test_is_paused_toggle_also_manages_intervals(self, client):
        t = create_task(client)
        client.patch(f"/tasks/{t['id']}", params={"is_paused": True})
        ps = periods_for(client, t["id"])
        assert len(ps) == 1 and ps[0]["end_date"] is None


class TestHiatusEndpoints:
    def test_range_query_returns_overlapping_intervals(self, client):
        t = create_task(client)
        closed = client.post("/task-hiatus-periods", json={
            "task_id": t["id"], "start_date": "2026-03-05", "end_date": "2026-03-12",
        })
        assert closed.status_code == 201, closed.text
        # Overlapping window hits; disjoint window misses.
        hit = client.get("/task-hiatus-periods", params={"start": "2026-03-01", "end": "2026-03-31"}).json()
        assert len(hit) == 1
        partial = client.get("/task-hiatus-periods", params={"start": "2026-03-10", "end": "2026-04-01"}).json()
        assert len(partial) == 1
        miss = client.get("/task-hiatus-periods", params={"start": "2026-04-01", "end": "2026-04-30"}).json()
        assert miss == []

    def test_open_interval_overlaps_all_later_ranges(self, client):
        t = create_task(client)
        client.post("/task-hiatus-periods", json={"task_id": t["id"], "start_date": "2026-05-01"})
        hit = client.get("/task-hiatus-periods", params={"start": "2027-01-01", "end": "2027-01-31"}).json()
        assert len(hit) == 1
        miss = client.get("/task-hiatus-periods", params={"start": "2026-04-01", "end": "2026-04-30"}).json()
        assert miss == []

    def test_post_rejects_second_open_interval(self, client):
        t = create_task(client)
        client.post("/task-hiatus-periods", json={"task_id": t["id"], "start_date": "2026-01-01"})
        r = client.post("/task-hiatus-periods", json={"task_id": t["id"], "start_date": "2026-02-01"})
        assert r.status_code == 409

    def test_post_invalid_dates_rejected(self, client):
        t = create_task(client)
        assert client.post("/task-hiatus-periods", json={
            "task_id": t["id"], "start_date": "not-a-date",
        }).status_code == 422
        assert client.post("/task-hiatus-periods", json={
            "task_id": t["id"], "start_date": "2026-03-10", "end_date": "2026-03-01",
        }).status_code == 422
        assert client.post("/task-hiatus-periods", json={
            "task_id": 99999, "start_date": "2026-03-01",
        }).status_code == 404

    def test_patch_rejects_inverted_range(self, client):
        t = create_task(client)
        p = client.post("/task-hiatus-periods", json={
            "task_id": t["id"], "start_date": "2026-03-05", "end_date": "2026-03-12",
        }).json()
        r = client.patch(f"/task-hiatus-periods/{p['id']}", json={"start_date": "2026-03-20"})
        assert r.status_code == 422

    def test_delete_interval(self, client):
        t = create_task(client)
        p = client.post("/task-hiatus-periods", json={
            "task_id": t["id"], "start_date": "2026-03-05", "end_date": "2026-03-12",
        }).json()
        assert client.delete(f"/task-hiatus-periods/{p['id']}").status_code == 200
        assert periods_for(client, t["id"]) == []
        assert client.delete(f"/task-hiatus-periods/{p['id']}").status_code == 404

    def test_list_requires_task_or_range(self, client):
        assert client.get("/task-hiatus-periods").status_code == 422


class TestHiatusDataSafety:
    def test_completions_untouched_by_hiatus_cycle(self, client):
        t = create_task(client)
        client.post("/completions", params={"task_id": t["id"], "completion_date": days_ago(3)})
        client.post("/completions", params={"task_id": t["id"], "completion_date": days_ago(3)})
        client.post("/completions", params={"task_id": t["id"], "completion_date": YESTERDAY})
        client.patch(f"/tasks/{t['id']}", params={"status": "hiatus"})
        client.patch(f"/tasks/{t['id']}", params={"status": "active"})
        comps = client.get(f"/completions?start={days_ago(10)}&end={TODAY}").json()
        by_date = {c["completion_date"]: c["completion_count"] for c in comps}
        assert by_date == {days_ago(3): 2, YESTERDAY: 1}

    def test_overrides_untouched_by_hiatus_cycle(self, client):
        t = create_task(client)
        client.put(f"/date-cell-overrides/{t['id']}/{YESTERDAY}", params={"text": "note"})
        client.patch(f"/tasks/{t['id']}", params={"status": "hiatus"})
        client.patch(f"/tasks/{t['id']}", params={"status": "active"})
        ovs = client.get(f"/date-cell-overrides?start={YESTERDAY}&end={YESTERDAY}").json()
        assert len(ovs) == 1 and ovs[0]["text"] == "note"

    def test_hard_delete_task_cascades_intervals(self, client):
        t = create_task(client)
        client.patch(f"/tasks/{t['id']}", params={"status": "hiatus"})
        assert len(periods_for(client, t["id"])) == 1
        # API deletes are soft (is_active=0) — intervals survive those. A hard
        # SQL delete (restore-style) must cascade so no rows orphan.
        conn = db_module.get_connection()
        with conn:
            conn.execute("DELETE FROM tasks WHERE id = ?", (t["id"],))
        left = conn.execute(
            "SELECT COUNT(*) FROM task_hiatus_periods WHERE task_id = ?", (t["id"],)
        ).fetchone()[0]
        conn.close()
        assert left == 0

    def test_soft_delete_preserves_interval_history(self, client):
        t = create_task(client)
        client.patch(f"/tasks/{t['id']}", params={"status": "hiatus"})
        client.delete(f"/tasks/{t['id']}")
        assert len(periods_for(client, t["id"])) == 1


class TestHiatusBackup:
    def test_backup_includes_hiatus_periods(self, client):
        t = create_task(client)
        client.patch(f"/tasks/{t['id']}", params={"status": "hiatus"})
        data = client.get("/export/backup.json").json()
        assert data["schema_version"] == 6
        assert len(data["task_hiatus_periods"]) == 1
        assert data["task_hiatus_periods"][0]["task_id"] == t["id"]

    def test_restore_round_trips_hiatus_periods(self, client):
        t = create_task(client)
        client.post("/task-hiatus-periods", json={
            "task_id": t["id"], "start_date": "2026-03-05", "end_date": "2026-03-12",
        })
        client.post("/task-hiatus-periods", json={"task_id": t["id"], "start_date": "2026-06-01"})
        exported = client.get("/export/backup.json").text

        files = {"file": ("backup.json", io.BytesIO(exported.encode()), "application/json")}
        r = client.post("/restore/backup.json", files=files)
        assert r.status_code == 200, r.text
        assert r.json()["task_hiatus_periods"] == 2

        ps = periods_for(client, t["id"])
        assert [(p["start_date"], p["end_date"]) for p in ps] == [
            ("2026-03-05", "2026-03-12"),
            ("2026-06-01", None),
        ]

    def test_v5_backup_without_periods_restores_empty(self, client):
        t = create_task(client)
        client.patch(f"/tasks/{t['id']}", params={"status": "hiatus"})
        payload = json.loads(client.get("/export/backup.json").text)
        payload["schema_version"] = 5
        del payload["task_hiatus_periods"]
        files = {"file": ("backup.json", io.BytesIO(json.dumps(payload).encode()), "application/json")}
        r = client.post("/restore/backup.json", files=files)
        assert r.status_code == 200, r.text
        assert r.json()["task_hiatus_periods"] == 0
        assert periods_for(client, t["id"]) == []
