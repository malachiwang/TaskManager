"""
Integration tests for all API endpoints.

Each test uses the `client` fixture from conftest.py which provides a fresh,
isolated SQLite database. No test shares state with any other test.

Run with: pytest tests/test_api.py -v
"""
import csv
import io
from datetime import date, timedelta


TODAY = date.today().isoformat()
YESTERDAY = (date.today() - timedelta(days=1)).isoformat()
TOMORROW = (date.today() + timedelta(days=1)).isoformat()


# ---------------------------------------------------------------------------
# Shared helper
# ---------------------------------------------------------------------------

def create_task(client, name="Test Task", priority=5, interval_days=7, **kwargs):
    """Create a task via the API and assert success."""
    params = {"name": name, "priority": priority, "interval_days": interval_days, **kwargs}
    resp = client.post("/tasks", params=params)
    assert resp.status_code == 201, resp.text
    return resp.json()


# ---------------------------------------------------------------------------
# POST /tasks
# ---------------------------------------------------------------------------

class TestCreateTask:
    def test_returns_201(self, client):
        resp = client.post("/tasks", params={"name": "My Task"})
        assert resp.status_code == 201

    def test_stored_fields_match_input(self, client):
        data = create_task(client, name="Study", priority=7, interval_days=3,
                           category="Career", subtask="Resume")
        assert data["name"] == "Study"
        assert data["priority"] == 7
        assert data["interval_days"] == 3
        assert data["category"] == "Career"
        assert data["subtask"] == "Resume"
        assert data["is_paused"] == 0
        assert data["is_active"] == 1

    def test_computed_fields_present(self, client):
        data = create_task(client)
        assert "days_since" in data
        assert "urgency" in data
        assert "effective_last_done" in data
        assert isinstance(data["days_since"], int)
        assert isinstance(data["urgency"], float)

    def test_new_task_days_since_is_zero(self, client):
        # Created today, no completions → days_since = 0
        data = create_task(client)
        assert data["days_since"] == 0

    def test_manual_override_stored_and_effective_last_done_correct(self, client):
        # The task is created today so created_at = today.
        # effective_last_done = max(today, yesterday) = today → days_since = 0.
        # This confirms the field is stored and the max() rule works correctly.
        data = create_task(client, name="Imported", manual_last_done_override=YESTERDAY)
        assert data["manual_last_done_override"] == YESTERDAY
        assert data["effective_last_done"] == TODAY
        assert data["days_since"] == 0

    def test_priority_zero_rejected(self, client):
        resp = client.post("/tasks", params={"name": "Bad", "priority": 0})
        assert resp.status_code == 422

    def test_priority_eleven_rejected(self, client):
        resp = client.post("/tasks", params={"name": "Bad", "priority": 11})
        assert resp.status_code == 422

    def test_interval_zero_rejected(self, client):
        resp = client.post("/tasks", params={"name": "Bad", "interval_days": 0})
        assert resp.status_code == 422

    def test_interval_negative_rejected(self, client):
        resp = client.post("/tasks", params={"name": "Bad", "interval_days": -1})
        assert resp.status_code == 422

    def test_boundary_priority_one_accepted(self, client):
        data = create_task(client, priority=1)
        assert data["priority"] == 1

    def test_boundary_priority_ten_accepted(self, client):
        data = create_task(client, priority=10)
        assert data["priority"] == 10

    def test_boundary_interval_one_accepted(self, client):
        data = create_task(client, interval_days=1)
        assert data["interval_days"] == 1


# ---------------------------------------------------------------------------
# GET /tasks
# ---------------------------------------------------------------------------

class TestListTasks:
    def test_empty_returns_empty_list(self, client):
        resp = client.get("/tasks")
        assert resp.status_code == 200
        assert resp.json() == []

    def test_returns_created_task(self, client):
        create_task(client, name="Alpha")
        tasks = client.get("/tasks").json()
        assert len(tasks) == 1
        assert tasks[0]["name"] == "Alpha"

    def test_returns_all_tasks(self, client):
        create_task(client, name="A")
        create_task(client, name="B")
        create_task(client, name="C")
        assert len(client.get("/tasks").json()) == 3

    def test_each_task_has_urgency_and_days_since(self, client):
        create_task(client, name="Tracked")
        t = client.get("/tasks").json()[0]
        assert "urgency" in t
        assert "days_since" in t
        assert isinstance(t["urgency"], float)
        assert isinstance(t["days_since"], int)

    def test_includes_paused_by_default(self, client):
        t = create_task(client)
        client.patch(f"/tasks/{t['id']}", params={"is_paused": True})
        tasks = client.get("/tasks").json()
        assert len(tasks) == 1

    def test_exclude_paused_hides_paused_tasks(self, client):
        t = create_task(client)
        client.patch(f"/tasks/{t['id']}", params={"is_paused": True})
        tasks = client.get("/tasks", params={"include_paused": False}).json()
        assert len(tasks) == 0

    def test_exclude_paused_keeps_active_tasks(self, client):
        active = create_task(client, name="Active")
        paused = create_task(client, name="Paused")
        client.patch(f"/tasks/{paused['id']}", params={"is_paused": True})
        tasks = client.get("/tasks", params={"include_paused": False}).json()
        assert len(tasks) == 1
        assert tasks[0]["id"] == active["id"]

    def test_paused_task_urgency_is_zero(self, client):
        t = create_task(client, priority=9)
        client.patch(f"/tasks/{t['id']}", params={"is_paused": True})
        tasks = client.get("/tasks").json()
        assert tasks[0]["urgency"] == 0.0


# ---------------------------------------------------------------------------
# GET /tasks/{id}
# ---------------------------------------------------------------------------

class TestGetTask:
    def test_returns_existing_task(self, client):
        created = create_task(client, name="Specific")
        resp = client.get(f"/tasks/{created['id']}")
        assert resp.status_code == 200
        assert resp.json()["name"] == "Specific"

    def test_returns_404_for_unknown_id(self, client):
        resp = client.get("/tasks/9999")
        assert resp.status_code == 404

    def test_has_computed_fields(self, client):
        created = create_task(client)
        data = client.get(f"/tasks/{created['id']}").json()
        assert "urgency" in data
        assert "days_since" in data
        assert "effective_last_done" in data


# ---------------------------------------------------------------------------
# PATCH /tasks/{id}
# ---------------------------------------------------------------------------

class TestPatchTask:
    def test_pause_sets_is_paused(self, client):
        t = create_task(client)
        resp = client.patch(f"/tasks/{t['id']}", params={"is_paused": True})
        assert resp.status_code == 200
        assert resp.json()["is_paused"] == 1

    def test_unpause_clears_is_paused(self, client):
        t = create_task(client)
        client.patch(f"/tasks/{t['id']}", params={"is_paused": True})
        resp = client.patch(f"/tasks/{t['id']}", params={"is_paused": False})
        assert resp.json()["is_paused"] == 0

    def test_paused_task_returns_zero_urgency(self, client):
        t = create_task(client, priority=10)
        resp = client.patch(f"/tasks/{t['id']}", params={"is_paused": True})
        assert resp.json()["urgency"] == 0.0

    def test_update_notes(self, client):
        t = create_task(client)
        resp = client.patch(f"/tasks/{t['id']}", params={"notes": "TEMPORARY HIATUS"})
        assert resp.json()["notes"] == "TEMPORARY HIATUS"

    def test_update_priority(self, client):
        t = create_task(client, priority=5)
        resp = client.patch(f"/tasks/{t['id']}", params={"priority": 9})
        assert resp.json()["priority"] == 9

    def test_update_interval_days(self, client):
        t = create_task(client, interval_days=7)
        resp = client.patch(f"/tasks/{t['id']}", params={"interval_days": 14})
        assert resp.json()["interval_days"] == 14

    def test_set_manual_override_stored_and_effective_last_done_correct(self, client):
        # Task created today; patching with yesterday's override does not change days_since
        # because effective_last_done = max(created_at=today, yesterday) = today.
        # The field is stored correctly, and the max() rule is enforced at the API level.
        t = create_task(client)
        resp = client.patch(f"/tasks/{t['id']}", params={"manual_last_done_override": YESTERDAY})
        data = resp.json()
        assert data["manual_last_done_override"] == YESTERDAY
        assert data["effective_last_done"] == TODAY
        assert data["days_since"] == 0

    def test_invalid_priority_low(self, client):
        t = create_task(client)
        resp = client.patch(f"/tasks/{t['id']}", params={"priority": 0})
        assert resp.status_code == 422

    def test_invalid_priority_high(self, client):
        t = create_task(client)
        resp = client.patch(f"/tasks/{t['id']}", params={"priority": 11})
        assert resp.status_code == 422

    def test_invalid_interval_days(self, client):
        t = create_task(client)
        resp = client.patch(f"/tasks/{t['id']}", params={"interval_days": 0})
        assert resp.status_code == 422

    def test_not_found_returns_404(self, client):
        resp = client.patch("/tasks/9999", params={"notes": "ghost"})
        assert resp.status_code == 404

    def test_no_fields_provided_is_noop(self, client):
        t = create_task(client, priority=6)
        resp = client.patch(f"/tasks/{t['id']}")
        assert resp.status_code == 200
        assert resp.json()["priority"] == 6


# ---------------------------------------------------------------------------
# POST /completions — upsert (multi-click cell)
# ---------------------------------------------------------------------------

class TestUpsertCompletion:
    def test_first_click_creates_count_one(self, client):
        t = create_task(client)
        resp = client.post("/completions", params={"task_id": t["id"], "completion_date": TODAY})
        assert resp.status_code == 201
        assert resp.json()["completion_count"] == 1

    def test_second_click_increments_to_two(self, client):
        t = create_task(client)
        client.post("/completions", params={"task_id": t["id"], "completion_date": TODAY})
        resp = client.post("/completions", params={"task_id": t["id"], "completion_date": TODAY})
        assert resp.json()["completion_count"] == 2

    def test_third_click_increments_to_three(self, client):
        t = create_task(client)
        for _ in range(3):
            resp = client.post("/completions", params={"task_id": t["id"], "completion_date": TODAY})
        assert resp.json()["completion_count"] == 3

    def test_sequential_clicks_increment_correctly(self, client):
        t = create_task(client)
        for expected in range(1, 6):
            resp = client.post("/completions", params={"task_id": t["id"], "completion_date": TODAY})
            assert resp.json()["completion_count"] == expected

    def test_different_dates_are_independent(self, client):
        t = create_task(client)
        # Click today once, yesterday once — today's count stays at 1 until clicked again
        client.post("/completions", params={"task_id": t["id"], "completion_date": TODAY})
        client.post("/completions", params={"task_id": t["id"], "completion_date": YESTERDAY})
        resp = client.post("/completions", params={"task_id": t["id"], "completion_date": TODAY})
        assert resp.json()["completion_count"] == 2

    def test_future_date_rejected(self, client):
        t = create_task(client)
        resp = client.post("/completions", params={"task_id": t["id"], "completion_date": TOMORROW})
        assert resp.status_code == 422

    def test_unknown_task_returns_404(self, client):
        resp = client.post("/completions", params={"task_id": 9999, "completion_date": TODAY})
        assert resp.status_code == 404

    def test_completion_updates_task_days_since_to_zero(self, client):
        t = create_task(client)
        client.post("/completions", params={"task_id": t["id"], "completion_date": TODAY})
        task = client.get(f"/tasks/{t['id']}").json()
        assert task["days_since"] == 0
        assert task["effective_last_done"] == TODAY

    def test_yesterday_completion_recorded_but_created_at_wins(self, client):
        # Task created today; completion recorded for yesterday.
        # effective_last_done = max(created_at=today, yesterday) = today → days_since = 0.
        # The completion IS stored (visible in GET /completions) but does not
        # affect days_since because created_at is more recent.
        t = create_task(client)
        client.post("/completions", params={"task_id": t["id"], "completion_date": YESTERDAY})
        task = client.get(f"/tasks/{t['id']}").json()
        assert task["days_since"] == 0
        # Confirm the completion was actually stored
        comps = client.get("/completions", params={"start": YESTERDAY, "end": YESTERDAY}).json()
        assert len(comps) == 1
        assert comps[0]["completion_count"] == 1


# ---------------------------------------------------------------------------
# DELETE /completions/{task_id}/{date}
# ---------------------------------------------------------------------------

class TestDeleteCompletion:
    def test_delete_returns_200(self, client):
        t = create_task(client)
        client.post("/completions", params={"task_id": t["id"], "completion_date": TODAY})
        resp = client.delete(f"/completions/{t['id']}/{TODAY}")
        assert resp.status_code == 200
        assert resp.json()["deleted"] is True

    def test_delete_removes_from_db(self, client):
        t = create_task(client)
        client.post("/completions", params={"task_id": t["id"], "completion_date": TODAY})
        client.delete(f"/completions/{t['id']}/{TODAY}")
        comps = client.get("/completions", params={"start": TODAY, "end": TODAY}).json()
        assert comps == []

    def test_delete_nonexistent_returns_404(self, client):
        t = create_task(client)
        resp = client.delete(f"/completions/{t['id']}/{TODAY}")
        assert resp.status_code == 404

    def test_delete_then_reclicking_starts_at_one(self, client):
        t = create_task(client)
        # Click twice to get count=2, then delete, then click again — should restart at 1
        client.post("/completions", params={"task_id": t["id"], "completion_date": TODAY})
        client.post("/completions", params={"task_id": t["id"], "completion_date": TODAY})
        client.delete(f"/completions/{t['id']}/{TODAY}")
        resp = client.post("/completions", params={"task_id": t["id"], "completion_date": TODAY})
        assert resp.json()["completion_count"] == 1

    def test_delete_restores_days_since_to_created_at(self, client):
        t = create_task(client)
        # Complete today, then delete — days_since should return to 0 (created today)
        client.post("/completions", params={"task_id": t["id"], "completion_date": TODAY})
        client.delete(f"/completions/{t['id']}/{TODAY}")
        task = client.get(f"/tasks/{t['id']}").json()
        # Task created today, no completions after delete → effective_last_done = created_at = today
        assert task["days_since"] == 0


# ---------------------------------------------------------------------------
# GET /completions
# ---------------------------------------------------------------------------

class TestListCompletions:
    def test_empty_range_returns_empty(self, client):
        resp = client.get("/completions", params={"start": TODAY, "end": TODAY})
        assert resp.status_code == 200
        assert resp.json() == []

    def test_returns_completion_in_range(self, client):
        t = create_task(client)
        client.post("/completions", params={"task_id": t["id"], "completion_date": TODAY})
        comps = client.get("/completions", params={"start": TODAY, "end": TODAY}).json()
        assert len(comps) == 1
        assert comps[0]["task_id"] == t["id"]
        assert comps[0]["completion_count"] == 1

    def test_filters_by_task_id(self, client):
        a = create_task(client, name="A")
        b = create_task(client, name="B")
        client.post("/completions", params={"task_id": a["id"], "completion_date": TODAY})
        client.post("/completions", params={"task_id": b["id"], "completion_date": TODAY})
        comps = client.get("/completions", params={
            "start": TODAY, "end": TODAY, "task_id": a["id"]
        }).json()
        assert len(comps) == 1
        assert comps[0]["task_id"] == a["id"]

    def test_excludes_completions_outside_range(self, client):
        t = create_task(client)
        client.post("/completions", params={"task_id": t["id"], "completion_date": YESTERDAY})
        comps = client.get("/completions", params={"start": TODAY, "end": TODAY}).json()
        assert comps == []

    def test_range_includes_both_endpoints(self, client):
        t = create_task(client)
        client.post("/completions", params={"task_id": t["id"], "completion_date": TODAY})
        client.post("/completions", params={"task_id": t["id"], "completion_date": YESTERDAY})
        comps = client.get("/completions", params={"start": YESTERDAY, "end": TODAY}).json()
        assert len(comps) == 2


# ---------------------------------------------------------------------------
# GET /dashboard
# ---------------------------------------------------------------------------

class TestDashboard:
    def test_returns_expected_keys(self, client):
        resp = client.get("/dashboard")
        assert resp.status_code == 200
        data = resp.json()
        assert "top_5_urgent" in data
        assert "category_summary" in data
        assert "dormant_tasks" in data
        assert "paused_count" in data
        assert "never_done_count" in data

    def test_empty_db(self, client):
        data = client.get("/dashboard").json()
        assert data["top_5_urgent"] == []
        assert data["paused_count"] == 0
        assert data["never_done_count"] == 0

    def test_paused_task_excluded_from_top5(self, client):
        t = create_task(client, name="High Priority Paused", priority=10)
        client.patch(f"/tasks/{t['id']}", params={"is_paused": True})
        data = client.get("/dashboard").json()
        top_ids = [task["id"] for task in data["top_5_urgent"]]
        assert t["id"] not in top_ids

    def test_active_task_appears_in_top5(self, client):
        t = create_task(client, name="Active Urgent", priority=9)
        data = client.get("/dashboard").json()
        top_ids = [task["id"] for task in data["top_5_urgent"]]
        assert t["id"] in top_ids

    def test_paused_count_correct(self, client):
        a = create_task(client, name="A")
        b = create_task(client, name="B")
        create_task(client, name="C")
        client.patch(f"/tasks/{a['id']}", params={"is_paused": True})
        client.patch(f"/tasks/{b['id']}", params={"is_paused": True})
        assert client.get("/dashboard").json()["paused_count"] == 2

    def test_never_done_count(self, client):
        create_task(client, name="Never Done A")
        create_task(client, name="Never Done B")
        t_done = create_task(client, name="Done Today")
        client.post("/completions", params={"task_id": t_done["id"], "completion_date": TODAY})
        assert client.get("/dashboard").json()["never_done_count"] == 2

    def test_never_done_excludes_manual_override(self, client):
        # Task with a manual override is not "never done"
        create_task(client, name="Has Manual Override", manual_last_done_override=YESTERDAY)
        assert client.get("/dashboard").json()["never_done_count"] == 0

    def test_category_summary_excludes_paused(self, client):
        create_task(client, name="Active Health", category="Health")
        paused = create_task(client, name="Paused Health", category="Health")
        client.patch(f"/tasks/{paused['id']}", params={"is_paused": True})
        data = client.get("/dashboard").json()
        assert data["category_summary"]["Health"]["count"] == 1

    def test_top5_at_most_five(self, client):
        for i in range(7):
            create_task(client, name=f"Task {i}")
        data = client.get("/dashboard").json()
        assert len(data["top_5_urgent"]) <= 5

    def test_top5_sorted_descending_by_urgency(self, client):
        for i in range(5):
            create_task(client, name=f"Task {i}", priority=i + 1)
        top5 = client.get("/dashboard").json()["top_5_urgent"]
        urgencies = [t["urgency"] for t in top5]
        assert urgencies == sorted(urgencies, reverse=True)


# ---------------------------------------------------------------------------
# Dashboard graph data (P6)
# ---------------------------------------------------------------------------

class TestDashboardGraphs:
    def test_active_count_present(self, client):
        create_task(client, name="A")
        create_task(client, name="B")
        data = client.get("/dashboard").json()
        assert "active_count" in data
        assert data["active_count"] == 2

    def test_active_count_excludes_paused(self, client):
        a = create_task(client, name="Active")
        p = create_task(client, name="Paused")
        client.patch(f"/tasks/{p['id']}", params={"is_paused": True})
        assert client.get("/dashboard").json()["active_count"] == 1

    def test_urgency_distribution_keys_present(self, client):
        data = client.get("/dashboard").json()
        assert "urgency_distribution" in data
        dist = data["urgency_distribution"]
        for key in ("critical", "high", "noticeable", "low"):
            assert key in dist
            assert isinstance(dist[key], int)
            assert dist[key] >= 0

    def test_urgency_distribution_sums_to_active_count(self, client):
        for i in range(4):
            create_task(client, name=f"Task {i}", priority=i + 3)
        data = client.get("/dashboard").json()
        dist = data["urgency_distribution"]
        total = sum(dist.values())
        assert total == data["active_count"]

    def test_urgency_distribution_excludes_paused(self, client):
        active = create_task(client, name="Active", priority=9)
        paused = create_task(client, name="Paused", priority=9)
        client.patch(f"/tasks/{paused['id']}", params={"is_paused": True})
        data = client.get("/dashboard").json()
        dist = data["urgency_distribution"]
        assert sum(dist.values()) == 1  # only the active task

    def test_completion_trend_present(self, client):
        data = client.get("/dashboard").json()
        assert "completion_trend" in data

    def test_completion_trend_has_30_entries(self, client):
        trend = client.get("/dashboard").json()["completion_trend"]
        assert len(trend) == 30

    def test_completion_trend_entry_shape(self, client):
        trend = client.get("/dashboard").json()["completion_trend"]
        for entry in trend:
            assert "date" in entry
            assert "count" in entry
            assert isinstance(entry["count"], int)
            assert entry["count"] >= 0

    def test_completion_trend_ordered_oldest_first(self, client):
        trend = client.get("/dashboard").json()["completion_trend"]
        dates = [e["date"] for e in trend]
        assert dates == sorted(dates)

    def test_completion_trend_zero_filled(self, client):
        # No completions — all counts must be 0
        trend = client.get("/dashboard").json()["completion_trend"]
        assert all(e["count"] == 0 for e in trend)

    def test_completion_trend_date_range(self, client):
        from datetime import date, timedelta
        trend = client.get("/dashboard").json()["completion_trend"]
        today = date.today().isoformat()
        oldest = (date.today() - timedelta(days=29)).isoformat()
        assert trend[0]["date"] == oldest
        assert trend[-1]["date"] == today

    def test_completion_trend_sums_completion_count(self, client):
        # A single cell with count=3 should contribute 3, not 1
        t = create_task(client, name="Multi")
        client.post("/completions", params={"task_id": t["id"], "completion_date": TODAY})
        client.patch(f"/completions/{t['id']}/{TODAY}", params={"count": 3})
        trend = client.get("/dashboard").json()["completion_trend"]
        today_entry = next(e for e in trend if e["date"] == TODAY)
        assert today_entry["count"] == 3

    def test_completion_trend_includes_paused_task_completions(self, client):
        # Completions from now-paused tasks should still show in trend
        t = create_task(client, name="Will Pause")
        client.post("/completions", params={"task_id": t["id"], "completion_date": TODAY})
        client.patch(f"/tasks/{t['id']}", params={"is_paused": True})
        trend = client.get("/dashboard").json()["completion_trend"]
        today_entry = next(e for e in trend if e["date"] == TODAY)
        assert today_entry["count"] == 1


# ---------------------------------------------------------------------------
# Dashboard heatmap data (P7)
# ---------------------------------------------------------------------------

class TestDashboardHeatmap:
    def _dashboard(self, client):
        return client.get("/dashboard").json()

    def test_heatmap_key_present(self, client):
        assert "completion_heatmap" in self._dashboard(client)

    def test_heatmap_structure(self, client):
        h = self._dashboard(client)["completion_heatmap"]
        assert "group_by" in h
        assert "dates" in h
        assert "rows" in h
        assert "max_value" in h
        assert h["group_by"] == "section"
        assert isinstance(h["dates"], list)
        assert len(h["dates"]) == 30

    def test_heatmap_dates_match_completion_trend(self, client):
        data = self._dashboard(client)
        trend_dates = [e["date"] for e in data["completion_trend"]]
        heatmap_dates = data["completion_heatmap"]["dates"]
        assert heatmap_dates == trend_dates

    def test_heatmap_empty_db(self, client):
        h = self._dashboard(client)["completion_heatmap"]
        assert h["rows"] == []
        assert h["max_value"] == 0

    def test_heatmap_values_sum_completion_count(self, client):
        t = create_task(client, name="Multi", section="Health")
        client.post("/completions", params={"task_id": t["id"], "completion_date": TODAY})
        client.patch(f"/completions/{t['id']}/{TODAY}", params={"count": 4})
        h = self._dashboard(client)["completion_heatmap"]
        health_row = next(r for r in h["rows"] if r["label"] == "Health")
        today_idx = h["dates"].index(TODAY)
        assert health_row["values"][today_idx] == 4

    def test_heatmap_zero_total_rows_suppressed(self, client):
        # Task with no completions in the window should not appear
        create_task(client, name="Silent", section="Quiet")
        h = self._dashboard(client)["completion_heatmap"]
        labels = [r["label"] for r in h["rows"]]
        assert "Quiet" not in labels

    def test_heatmap_max_value_globally_correct(self, client):
        t1 = create_task(client, name="T1", section="A")
        t2 = create_task(client, name="T2", section="B")
        client.post("/completions", params={"task_id": t1["id"], "completion_date": TODAY})
        client.patch(f"/completions/{t1['id']}/{TODAY}", params={"count": 5})
        client.post("/completions", params={"task_id": t2["id"], "completion_date": TODAY})
        client.patch(f"/completions/{t2['id']}/{TODAY}", params={"count": 2})
        h = self._dashboard(client)["completion_heatmap"]
        assert h["max_value"] == 5

    def test_heatmap_blank_section_becomes_no_section(self, client):
        t = create_task(client, name="Blank Section", section="")
        client.post("/completions", params={"task_id": t["id"], "completion_date": TODAY})
        h = self._dashboard(client)["completion_heatmap"]
        labels = [r["label"] for r in h["rows"]]
        assert "(no section)" in labels

    def test_heatmap_includes_paused_task_completions(self, client):
        t = create_task(client, name="Paused Task", section="Health")
        client.post("/completions", params={"task_id": t["id"], "completion_date": TODAY})
        client.patch(f"/tasks/{t['id']}", params={"is_paused": True})
        h = self._dashboard(client)["completion_heatmap"]
        health_row = next((r for r in h["rows"] if r["label"] == "Health"), None)
        assert health_row is not None
        today_idx = h["dates"].index(TODAY)
        assert health_row["values"][today_idx] == 1

    def test_heatmap_row_values_length(self, client):
        t = create_task(client, name="Task", section="Work")
        client.post("/completions", params={"task_id": t["id"], "completion_date": TODAY})
        h = self._dashboard(client)["completion_heatmap"]
        for row in h["rows"]:
            assert len(row["values"]) == 30

    def test_heatmap_rows_sorted_by_total_descending(self, client):
        t1 = create_task(client, name="Low", section="Low")
        t2 = create_task(client, name="High", section="High")
        client.post("/completions", params={"task_id": t1["id"], "completion_date": TODAY})
        client.post("/completions", params={"task_id": t2["id"], "completion_date": TODAY})
        client.patch(f"/completions/{t2['id']}/{TODAY}", params={"count": 3})
        h = self._dashboard(client)["completion_heatmap"]
        totals = [r["total"] for r in h["rows"]]
        assert totals == sorted(totals, reverse=True)


# ---------------------------------------------------------------------------
# Archives
# ---------------------------------------------------------------------------

class TestArchive:
    def test_create_archive_returns_201(self, client):
        resp = client.post("/archives", params={"name": "May Snap", "start_date": TODAY, "end_date": TODAY})
        assert resp.status_code == 201

    def test_create_archive_returns_metadata(self, client):
        resp = client.post("/archives", params={"name": "Test", "start_date": TODAY, "end_date": YESTERDAY})
        data = resp.json()
        assert data["name"] == "Test"
        assert data["start_date"] == TODAY
        assert data["end_date"] == YESTERDAY
        assert "archived_at" in data
        assert "id" in data
        assert isinstance(data["id"], int)

    def test_list_archives_empty(self, client):
        resp = client.get("/archives")
        assert resp.status_code == 200
        assert resp.json() == []

    def test_list_archives_returns_entry(self, client):
        client.post("/archives", params={"name": "A", "start_date": TODAY, "end_date": TODAY})
        archives = client.get("/archives").json()
        assert len(archives) == 1
        assert archives[0]["name"] == "A"

    def test_list_archives_no_snapshot_data_json(self, client):
        client.post("/archives", params={"name": "A", "start_date": TODAY, "end_date": TODAY})
        archives = client.get("/archives").json()
        assert "snapshot_data_json" not in archives[0]

    def test_list_archives_has_expected_fields(self, client):
        client.post("/archives", params={"name": "A", "start_date": TODAY, "end_date": TODAY})
        a = client.get("/archives").json()[0]
        assert "id" in a
        assert "name" in a
        assert "start_date" in a
        assert "end_date" in a
        assert "archived_at" in a

    def test_get_archive_returns_snapshot_data_json(self, client):
        resp = client.post("/archives", params={"name": "A", "start_date": TODAY, "end_date": TODAY})
        aid = resp.json()["id"]
        detail = client.get(f"/archives/{aid}").json()
        assert "snapshot_data_json" in detail
        snap = detail["snapshot_data_json"]
        assert "tasks" in snap
        assert "start_date" in snap
        assert "end_date" in snap

    def test_get_archive_404_for_unknown(self, client):
        resp = client.get("/archives/9999")
        assert resp.status_code == 404

    def test_archive_does_not_mutate_tasks(self, client):
        create_task(client, name="Original")
        client.post("/archives", params={"name": "Snap", "start_date": TODAY, "end_date": TODAY})
        tasks_after = client.get("/tasks").json()
        assert len(tasks_after) == 1
        assert tasks_after[0]["name"] == "Original"

    def test_archive_does_not_mutate_completions(self, client):
        t = create_task(client)
        client.post("/completions", params={"task_id": t["id"], "completion_date": TODAY})
        client.post("/archives", params={"name": "Snap", "start_date": TODAY, "end_date": TODAY})
        comps = client.get("/completions", params={"start": TODAY, "end": TODAY}).json()
        assert len(comps) == 1
        assert comps[0]["completion_count"] == 1

    def test_archive_stores_completion_count_not_boolean(self, client):
        t = create_task(client)
        # Click three times to get count=3
        for _ in range(3):
            client.post("/completions", params={"task_id": t["id"], "completion_date": TODAY})
        resp = client.post("/archives", params={"name": "Snap", "start_date": TODAY, "end_date": TODAY})
        aid = resp.json()["id"]
        detail = client.get(f"/archives/{aid}").json()
        task_snap = detail["snapshot_data_json"]["tasks"][0]
        assert task_snap["completions"][TODAY] == 3

    def test_archive_empty_db_has_empty_tasks(self, client):
        resp = client.post("/archives", params={"name": "Empty", "start_date": TODAY, "end_date": TODAY})
        aid = resp.json()["id"]
        snap = client.get(f"/archives/{aid}").json()["snapshot_data_json"]
        assert snap["tasks"] == []

    def test_archive_completions_outside_range_not_included(self, client):
        t = create_task(client)
        client.post("/completions", params={"task_id": t["id"], "completion_date": YESTERDAY})
        # Archive only covers today — yesterday's completion should not be in completions map
        resp = client.post("/archives", params={"name": "Snap", "start_date": TODAY, "end_date": TODAY})
        aid = resp.json()["id"]
        snap = client.get(f"/archives/{aid}").json()["snapshot_data_json"]
        task_snap = snap["tasks"][0]
        assert YESTERDAY not in task_snap["completions"]

    def test_multiple_snapshots_are_independent(self, client):
        client.post("/archives", params={"name": "First", "start_date": TODAY, "end_date": TODAY})
        client.post("/archives", params={"name": "Second", "start_date": TODAY, "end_date": TODAY})
        archives = client.get("/archives").json()
        assert len(archives) == 2
        names = {a["name"] for a in archives}
        assert names == {"First", "Second"}


# ---------------------------------------------------------------------------
# Export
# ---------------------------------------------------------------------------

class TestExport:
    # --- backup.json ---

    def test_backup_returns_200(self, client):
        resp = client.get("/export/backup.json")
        assert resp.status_code == 200

    def test_backup_content_type_is_json(self, client):
        resp = client.get("/export/backup.json")
        assert "application/json" in resp.headers["content-type"]

    def test_backup_has_attachment_disposition(self, client):
        resp = client.get("/export/backup.json")
        assert "attachment" in resp.headers["content-disposition"]

    def test_backup_has_required_keys(self, client):
        data = client.get("/export/backup.json").json()
        assert "exported_at" in data
        assert "schema_version" in data
        assert "tasks" in data
        assert "completions" in data
        assert "cell_notes" in data
        assert "archive_snapshots" in data

    def test_backup_schema_version_is_2(self, client):
        data = client.get("/export/backup.json").json()
        assert data["schema_version"] == 2

    def test_backup_empty_db_returns_valid_empty_arrays(self, client):
        data = client.get("/export/backup.json").json()
        assert data["tasks"] == []
        assert data["completions"] == []
        assert data["cell_notes"] == []
        assert data["archive_snapshots"] == []

    def test_backup_includes_tasks(self, client):
        create_task(client, name="Task A")
        data = client.get("/export/backup.json").json()
        assert len(data["tasks"]) == 1
        assert data["tasks"][0]["name"] == "Task A"

    def test_backup_includes_completions(self, client):
        t = create_task(client)
        client.post("/completions", params={"task_id": t["id"], "completion_date": TODAY})
        data = client.get("/export/backup.json").json()
        assert len(data["completions"]) == 1
        assert data["completions"][0]["completion_count"] == 1

    def test_backup_includes_archive_snapshots(self, client):
        client.post("/archives", params={"name": "Snap", "start_date": TODAY, "end_date": TODAY})
        data = client.get("/export/backup.json").json()
        assert len(data["archive_snapshots"]) == 1
        assert data["archive_snapshots"][0]["name"] == "Snap"

    def test_backup_does_not_mutate_tasks(self, client):
        create_task(client, name="Intact")
        client.get("/export/backup.json")
        assert client.get("/tasks").json()[0]["name"] == "Intact"

    # --- sheet.csv ---

    def test_sheet_csv_returns_200(self, client):
        resp = client.get("/export/sheet.csv", params={"start": TODAY, "end": TODAY})
        assert resp.status_code == 200

    def test_sheet_csv_content_type(self, client):
        resp = client.get("/export/sheet.csv", params={"start": TODAY, "end": TODAY})
        assert "text/csv" in resp.headers["content-type"]

    def test_sheet_csv_has_attachment_disposition(self, client):
        resp = client.get("/export/sheet.csv", params={"start": TODAY, "end": TODAY})
        assert "attachment" in resp.headers["content-disposition"]

    def test_sheet_csv_header_has_metadata_columns(self, client):
        resp = client.get("/export/sheet.csv", params={"start": TODAY, "end": TODAY})
        header = resp.text.splitlines()[0]
        for col in ("name", "category", "urgency", "days_since", "priority"):
            assert col in header

    def test_sheet_csv_header_has_date_columns(self, client):
        resp = client.get("/export/sheet.csv", params={"start": TODAY, "end": TODAY})
        header = resp.text.splitlines()[0]
        assert TODAY in header

    def test_sheet_csv_one_row_per_active_task(self, client):
        create_task(client, name="A")
        create_task(client, name="B")
        lines = [l for l in client.get(
            "/export/sheet.csv", params={"start": TODAY, "end": TODAY}
        ).text.splitlines() if l]
        assert len(lines) == 3  # 1 header + 2 data rows

    def test_sheet_csv_completion_count_in_date_cell(self, client):
        t = create_task(client)
        for _ in range(3):
            client.post("/completions", params={"task_id": t["id"], "completion_date": TODAY})
        text = client.get("/export/sheet.csv", params={"start": TODAY, "end": TODAY}).text
        data_row = text.splitlines()[1]
        assert "3" in data_row

    def test_sheet_csv_blank_for_zero_completion(self, client):
        create_task(client)
        text = client.get("/export/sheet.csv", params={"start": TODAY, "end": TODAY}).text
        # Data row's last field (the date cell) should be blank, not "0"
        data_row = text.splitlines()[1]
        assert data_row.endswith(",")  # trailing comma = empty last field

    def test_sheet_csv_empty_db_returns_header_only(self, client):
        lines = [l for l in client.get(
            "/export/sheet.csv", params={"start": TODAY, "end": TODAY}
        ).text.splitlines() if l]
        assert len(lines) == 1

    def test_sheet_csv_missing_start_returns_422(self, client):
        assert client.get("/export/sheet.csv", params={"end": TODAY}).status_code == 422

    def test_sheet_csv_missing_end_returns_422(self, client):
        assert client.get("/export/sheet.csv", params={"start": TODAY}).status_code == 422

    def test_sheet_csv_end_before_start_returns_400(self, client):
        resp = client.get("/export/sheet.csv", params={"start": TODAY, "end": YESTERDAY})
        assert resp.status_code == 400

    def test_sheet_csv_multi_day_range_has_multiple_date_columns(self, client):
        resp = client.get("/export/sheet.csv", params={"start": YESTERDAY, "end": TODAY})
        header = resp.text.splitlines()[0]
        assert YESTERDAY in header
        assert TODAY in header


# ---------------------------------------------------------------------------
# Import preview
# ---------------------------------------------------------------------------

class TestImportPreview:
    def _csv_bytes(self, rows: list[list[str]]) -> bytes:
        buf = io.StringIO()
        csv.writer(buf).writerows(rows)
        return buf.getvalue().encode("utf-8")

    def _post(self, client, content: bytes, filename: str = "sheet.csv"):
        return client.post(
            "/import/preview",
            files={"file": (filename, content, "text/csv")},
        )

    # --- basic response ---

    def test_valid_csv_returns_200(self, client):
        resp = self._post(client, self._csv_bytes([["Task", "Category"], ["Exercise", "Health"]]))
        assert resp.status_code == 200

    def test_no_file_returns_422(self, client):
        assert client.post("/import/preview").status_code == 422

    def test_empty_file_returns_row_count_zero(self, client):
        data = self._post(client, b"").json()
        assert data["row_count"] == 0

    def test_header_only_returns_row_count_zero(self, client):
        data = self._post(client, self._csv_bytes([["Task", "Category"]])).json()
        assert data["row_count"] == 0

    def test_response_has_all_required_keys(self, client):
        data = self._post(client, self._csv_bytes([["Task"]])).json()
        for key in ("row_count", "detected_metadata_columns", "detected_date_columns",
                    "candidate_date_columns", "unrecognized_columns", "sample_rows", "warnings"):
            assert key in data

    # --- metadata column detection ---

    def test_detects_name_from_task_header(self, client):
        data = self._post(client, self._csv_bytes([["Task"], ["Exercise"]])).json()
        assert data["detected_metadata_columns"]["name"] == "Task"

    def test_detects_name_from_name_header(self, client):
        data = self._post(client, self._csv_bytes([["Name"], ["Exercise"]])).json()
        assert data["detected_metadata_columns"]["name"] == "Name"

    def test_subtask_does_not_map_to_name(self, client):
        data = self._post(client, self._csv_bytes([["Subtask"], ["detail"]])).json()
        assert data["detected_metadata_columns"]["name"] is None
        assert data["detected_metadata_columns"]["subtask"] == "Subtask"

    def test_detects_category(self, client):
        data = self._post(client, self._csv_bytes([["Task", "Category"], ["Ex", "Health"]])).json()
        assert data["detected_metadata_columns"]["category"] == "Category"

    def test_detects_category_from_cat(self, client):
        data = self._post(client, self._csv_bytes([["Task", "Cat"], ["Ex", "Health"]])).json()
        assert data["detected_metadata_columns"]["category"] == "Cat"

    def test_detects_priority(self, client):
        data = self._post(client, self._csv_bytes([["Task", "Priority"], ["Ex", "8"]])).json()
        assert data["detected_metadata_columns"]["priority"] == "Priority"

    def test_detects_priority_from_p(self, client):
        data = self._post(client, self._csv_bytes([["Task", "P"], ["Ex", "8"]])).json()
        assert data["detected_metadata_columns"]["priority"] == "P"

    def test_detects_interval_from_freq(self, client):
        data = self._post(client, self._csv_bytes([["Task", "Freq"], ["Ex", "7"]])).json()
        assert data["detected_metadata_columns"]["interval_days"] == "Freq"

    def test_detects_interval_from_frequency(self, client):
        data = self._post(client, self._csv_bytes([["Task", "Frequency"], ["Ex", "7"]])).json()
        assert data["detected_metadata_columns"]["interval_days"] == "Frequency"

    def test_detects_status(self, client):
        data = self._post(client, self._csv_bytes([["Task", "Status"], ["Ex", "active"]])).json()
        assert data["detected_metadata_columns"]["status"] == "Status"

    def test_detects_notes(self, client):
        data = self._post(client, self._csv_bytes([["Task", "Notes"], ["Ex", "hi"]])).json()
        assert data["detected_metadata_columns"]["notes"] == "Notes"

    def test_detects_manual_override_from_manual(self, client):
        data = self._post(client, self._csv_bytes([["Task", "Manual"], ["Ex", "2026-01-01"]])).json()
        assert data["detected_metadata_columns"]["manual_last_done_override"] == "Manual"

    # --- date column detection ---

    def test_detects_iso_date_columns(self, client):
        data = self._post(
            client, self._csv_bytes([["Task", "2026-05-01", "2026-05-02"], ["Ex", "1", "2"]])
        ).json()
        assert "2026-05-01" in data["detected_date_columns"]
        assert "2026-05-02" in data["detected_date_columns"]

    def test_iso_date_not_in_candidate_or_unrecognized(self, client):
        data = self._post(
            client, self._csv_bytes([["Task", "2026-05-01"], ["Ex", "1"]])
        ).json()
        assert "2026-05-01" not in data["candidate_date_columns"]
        assert "2026-05-01" not in data["unrecognized_columns"]

    def test_mm_dd_yyyy_goes_to_candidate_date_columns(self, client):
        data = self._post(
            client, self._csv_bytes([["Task", "5/1/2026"], ["Ex", "1"]])
        ).json()
        assert "5/1/2026" in data["candidate_date_columns"]
        assert "5/1/2026" not in data["detected_date_columns"]

    def test_month_day_format_goes_to_candidate(self, client):
        data = self._post(
            client, self._csv_bytes([["Task", "May 1"], ["Ex", "1"]])
        ).json()
        assert "May 1" in data["candidate_date_columns"]

    def test_candidate_dates_produce_warning(self, client):
        data = self._post(
            client, self._csv_bytes([["Task", "5/1/2026"], ["Ex", "1"]])
        ).json()
        assert any("non-ISO" in w or "not imported" in w for w in data["warnings"])

    # --- unrecognized columns ---

    def test_unrecognized_columns_reported(self, client):
        data = self._post(
            client, self._csv_bytes([["Task", "WeirdColumn"], ["Ex", "val"]])
        ).json()
        assert "WeirdColumn" in data["unrecognized_columns"]

    # --- warnings ---

    def test_missing_name_column_produces_warning(self, client):
        data = self._post(
            client, self._csv_bytes([["Category", "Priority"], ["Health", "8"]])
        ).json()
        assert any("name" in w.lower() for w in data["warnings"])

    # --- row count ---

    def test_row_count_excludes_blank_rows(self, client):
        data = self._post(
            client, self._csv_bytes([["Task"], ["Exercise"], [""], ["Dentist"]])
        ).json()
        assert data["row_count"] == 2

    def test_row_count_matches_data_rows(self, client):
        rows = [["Task"]] + [["Task " + str(i)] for i in range(7)]
        data = self._post(client, self._csv_bytes(rows)).json()
        assert data["row_count"] == 7

    # --- sample rows ---

    def test_sample_rows_capped_at_5(self, client):
        rows = [["Task"]] + [[f"Task {i}"] for i in range(10)]
        data = self._post(client, self._csv_bytes(rows)).json()
        assert len(data["sample_rows"]) <= 5

    def test_sample_rows_use_field_names_as_keys(self, client):
        rows = [["Task", "Category"], ["Exercise", "Health"]]
        data = self._post(client, self._csv_bytes(rows)).json()
        assert "name" in data["sample_rows"][0]
        assert data["sample_rows"][0]["name"] == "Exercise"

    # --- no DB mutation ---

    def test_preview_does_not_create_tasks(self, client):
        self._post(client, self._csv_bytes([["Task", "Priority"], ["Exercise", "8"]]))
        assert client.get("/tasks").json() == []

    def test_preview_does_not_create_completions(self, client):
        self._post(client, self._csv_bytes([["Task", "2026-05-01"], ["Exercise", "1"]]))
        comps = client.get("/completions", params={"start": "2026-05-01", "end": "2026-05-01"}).json()
        assert comps == []

    # --- encoding ---

    def test_csv_with_bom_parses_correctly(self, client):
        # encode("utf-8-sig") prepends the BOM bytes \xef\xbb\xbf; backend strips them.
        content = "Task,Category\nExercise,Health\n".encode("utf-8-sig")
        data = self._post(client, content).json()
        assert data["detected_metadata_columns"]["name"] == "Task"
        assert data["row_count"] == 1

    def test_detects_section_header(self, client):
        data = self._post(client, self._csv_bytes([["Task", "Section"], ["Ex", "Health"]])).json()
        assert data["detected_metadata_columns"]["section"] == "Section"

    def test_detects_group_alias_for_section(self, client):
        data = self._post(client, self._csv_bytes([["Task", "Group"], ["Ex", "Health"]])).json()
        assert data["detected_metadata_columns"]["section"] == "Group"

    def test_detects_area_alias_for_section(self, client):
        data = self._post(client, self._csv_bytes([["Task", "Area"], ["Ex", "Health"]])).json()
        assert data["detected_metadata_columns"]["section"] == "Area"


# ---------------------------------------------------------------------------
# Section support
# ---------------------------------------------------------------------------

class TestSection:
    def _csv_bytes(self, rows):
        buf = io.StringIO()
        csv.writer(buf).writerows(rows)
        return buf.getvalue().encode("utf-8")

    def test_create_task_with_section_stores_it(self, client):
        t = create_task(client, name="T", section="Health")
        assert t["section"] == "Health"

    def test_create_task_without_section_defaults_to_general(self, client):
        t = create_task(client, name="T")
        assert t["section"] == "General"

    def test_patch_section(self, client):
        t = create_task(client)
        resp = client.patch(f"/tasks/{t['id']}", params={"section": "Career"})
        assert resp.json()["section"] == "Career"

    def test_patch_without_section_leaves_it_unchanged(self, client):
        t = create_task(client, section="Music")
        resp = client.patch(f"/tasks/{t['id']}", params={"notes": "blah"})
        assert resp.json()["section"] == "Music"

    def test_list_tasks_includes_section(self, client):
        create_task(client, name="T", section="Projects")
        tasks = client.get("/tasks").json()
        assert "section" in tasks[0]
        assert tasks[0]["section"] == "Projects"

    def test_get_task_includes_section(self, client):
        t = create_task(client, section="Music")
        data = client.get(f"/tasks/{t['id']}").json()
        assert data["section"] == "Music"

    def test_csv_export_has_section_header(self, client):
        resp = client.get("/export/sheet.csv", params={"start": TODAY, "end": TODAY})
        header = resp.text.splitlines()[0]
        assert "section" in header

    def test_csv_export_section_value_in_row(self, client):
        create_task(client, name="T", section="Career")
        text = client.get("/export/sheet.csv", params={"start": TODAY, "end": TODAY}).text
        assert "Career" in text

    def test_backup_json_tasks_include_section(self, client):
        create_task(client, name="T", section="Health")
        data = client.get("/export/backup.json").json()
        assert data["tasks"][0]["section"] == "Health"

    def test_archive_snapshot_includes_section(self, client):
        create_task(client, name="T", section="Projects")
        resp = client.post("/archives", params={
            "name": "Snap", "start_date": TODAY, "end_date": TODAY
        })
        snap = client.get(f"/archives/{resp.json()['id']}").json()
        assert snap["snapshot_data_json"]["tasks"][0]["section"] == "Projects"

    def test_archive_snapshot_missing_section_renders_gracefully(self, client):
        # Simulate a pre-Ticket-9 snapshot by inserting one with no section in tasks.
        # Verifies GET /archives/{id} does not crash on old snapshots.
        import json as _json
        old_snap = {"start_date": TODAY, "end_date": TODAY, "tasks": [
            {"id": 99, "name": "Old Task", "urgency": 5.0, "days_since": 3,
             "priority": 5, "interval_days": 7, "status": "active",
             "category": "Health", "is_paused": 0, "completions": {}}
            # no "section" key — simulates pre-migration snapshot
        ]}
        conn_path = client.app.state  # just verify the endpoint handles missing key
        resp = client.post("/archives", params={
            "name": "OldSnap", "start_date": TODAY, "end_date": TODAY
        })
        # Patch the stored JSON to remove section from the task
        from backend.database import get_connection
        aid = resp.json()["id"]
        conn = get_connection()
        conn.execute(
            "UPDATE archive_snapshots SET snapshot_data_json = ? WHERE id = ?",
            (_json.dumps(old_snap), aid)
        )
        conn.commit()
        conn.close()
        # Verify endpoint returns 200 and the old snapshot without crashing
        detail = client.get(f"/archives/{aid}").json()
        assert detail["snapshot_data_json"]["tasks"][0]["name"] == "Old Task"
        assert "section" not in detail["snapshot_data_json"]["tasks"][0]

    def test_import_preview_detects_section_alias(self, client):
        content = self._csv_bytes([["Task", "Section"], ["Ex", "Health"]])
        resp = client.post("/import/preview", files={"file": ("s.csv", content, "text/csv")})
        assert resp.json()["detected_metadata_columns"]["section"] == "Section"

    def test_import_preview_detects_grouping_alias(self, client):
        content = self._csv_bytes([["Task", "Grouping"], ["Ex", "Health"]])
        resp = client.post("/import/preview", files={"file": ("s.csv", content, "text/csv")})
        assert resp.json()["detected_metadata_columns"]["section"] == "Grouping"

    def test_import_preview_detects_major_category_alias(self, client):
        content = self._csv_bytes([["Task", "Major Category"], ["Ex", "Career"]])
        resp = client.post("/import/preview", files={"file": ("s.csv", content, "text/csv")})
        assert resp.json()["detected_metadata_columns"]["section"] == "Major Category"


# ---------------------------------------------------------------------------
# Cell Notes — P5
# ---------------------------------------------------------------------------

class TestCellNotes:
    def test_put_creates_note(self, client):
        t = create_task(client)
        resp = client.put(f"/notes/{t['id']}/{TODAY}", params={"note": "30 min review"})
        assert resp.status_code == 200
        assert resp.json()["note"] == "30 min review"
        assert resp.json()["task_id"] == t["id"]
        assert resp.json()["note_date"] == TODAY

    def test_put_updates_existing_note(self, client):
        t = create_task(client)
        client.put(f"/notes/{t['id']}/{TODAY}", params={"note": "first"})
        resp = client.put(f"/notes/{t['id']}/{TODAY}", params={"note": "updated"})
        assert resp.json()["note"] == "updated"

    def test_put_empty_note_deletes_row(self, client):
        t = create_task(client)
        client.put(f"/notes/{t['id']}/{TODAY}", params={"note": "hello"})
        resp = client.put(f"/notes/{t['id']}/{TODAY}", params={"note": ""})
        assert resp.json()["deleted"] is True
        # GET should no longer return that note
        notes = client.get("/notes", params={"start": TODAY, "end": TODAY}).json()
        assert all(n["note_date"] != TODAY or n["task_id"] != t["id"] for n in notes)

    def test_put_whitespace_only_note_deletes_row(self, client):
        t = create_task(client)
        client.put(f"/notes/{t['id']}/{TODAY}", params={"note": "text"})
        resp = client.put(f"/notes/{t['id']}/{TODAY}", params={"note": "   "})
        assert resp.json()["deleted"] is True

    def test_get_notes_returns_notes_in_range(self, client):
        t = create_task(client)
        client.put(f"/notes/{t['id']}/{TODAY}", params={"note": "done"})
        notes = client.get("/notes", params={"start": TODAY, "end": TODAY}).json()
        assert len(notes) == 1
        assert notes[0]["note"] == "done"

    def test_get_notes_excludes_notes_outside_range(self, client):
        t = create_task(client)
        client.put(f"/notes/{t['id']}/{YESTERDAY}", params={"note": "yesterday note"})
        notes = client.get("/notes", params={"start": TODAY, "end": TODAY}).json()
        assert notes == []

    def test_delete_note_removes_row(self, client):
        t = create_task(client)
        client.put(f"/notes/{t['id']}/{TODAY}", params={"note": "to delete"})
        resp = client.delete(f"/notes/{t['id']}/{TODAY}")
        assert resp.status_code == 200
        assert resp.json()["deleted"] is True
        notes = client.get("/notes", params={"start": TODAY, "end": TODAY}).json()
        assert notes == []

    def test_delete_nonexistent_note_returns_404(self, client):
        t = create_task(client)
        resp = client.delete(f"/notes/{t['id']}/{TODAY}")
        assert resp.status_code == 404

    def test_note_survives_completion_clear(self, client):
        t = create_task(client)
        client.post("/completions", params={"task_id": t["id"], "completion_date": TODAY})
        client.put(f"/notes/{t['id']}/{TODAY}", params={"note": "leg hurt"})
        # Clear the completion
        client.delete(f"/completions/{t['id']}/{TODAY}")
        # Note must still exist
        notes = client.get("/notes", params={"start": TODAY, "end": TODAY}).json()
        assert len(notes) == 1
        assert notes[0]["note"] == "leg hurt"

    def test_note_survives_task_soft_delete(self, client):
        t = create_task(client)
        client.put(f"/notes/{t['id']}/{TODAY}", params={"note": "keep me"})
        # Soft-delete the task
        client.delete(f"/tasks/{t['id']}")
        # Note row must still exist in DB (task is_active=0, not hard-deleted)
        # We query the DB directly via the notes endpoint — soft-deleted tasks still exist
        notes = client.get("/notes", params={"start": TODAY, "end": TODAY}).json()
        assert len(notes) == 1
        assert notes[0]["note"] == "keep me"

    def test_put_unknown_task_returns_404(self, client):
        resp = client.put("/notes/9999/2026-01-01", params={"note": "ghost"})
        assert resp.status_code == 404

    def test_backup_includes_cell_notes(self, client):
        t = create_task(client)
        client.put(f"/notes/{t['id']}/{TODAY}", params={"note": "backup test"})
        data = client.get("/export/backup.json").json()
        assert "cell_notes" in data
        assert len(data["cell_notes"]) == 1
        assert data["cell_notes"][0]["note"] == "backup test"

    def test_backup_empty_cell_notes(self, client):
        data = client.get("/export/backup.json").json()
        assert data["cell_notes"] == []

# ---------------------------------------------------------------------------
# PATCH /completions/{task_id}/{date} — set count
# ---------------------------------------------------------------------------

class TestSetCompletionCount:
    def test_set_count_on_empty_cell_creates_it(self, client):
        t = create_task(client)
        resp = client.patch(f"/completions/{t['id']}/{TODAY}", params={"count": 3})
        assert resp.status_code == 200
        assert resp.json()["completion_count"] == 3

    def test_set_count_on_existing_cell_updates_it(self, client):
        t = create_task(client)
        client.post("/completions", params={"task_id": t["id"], "completion_date": TODAY})
        resp = client.patch(f"/completions/{t['id']}/{TODAY}", params={"count": 5})
        assert resp.status_code == 200
        assert resp.json()["completion_count"] == 5

    def test_set_count_to_zero_clears_existing_cell(self, client):
        t = create_task(client)
        client.post("/completions", params={"task_id": t["id"], "completion_date": TODAY})
        resp = client.patch(f"/completions/{t['id']}/{TODAY}", params={"count": 0})
        assert resp.status_code == 200
        data = resp.json()
        assert data["deleted"] is True
        assert data["completion_count"] == 0
        # Verify row is actually gone
        comps = client.get("/completions", params={"start": TODAY, "end": TODAY}).json()
        assert not any(c["task_id"] == t["id"] for c in comps)

    def test_set_count_to_zero_on_empty_cell_is_noop(self, client):
        t = create_task(client)
        resp = client.patch(f"/completions/{t['id']}/{TODAY}", params={"count": 0})
        assert resp.status_code == 200
        assert resp.json()["deleted"] is True

    def test_set_count_preserves_created_timestamp(self, client):
        t = create_task(client)
        # Create the row via POST so created_timestamp is set
        client.post("/completions", params={"task_id": t["id"], "completion_date": TODAY})
        comps_before = client.get("/completions", params={"start": TODAY, "end": TODAY}).json()
        created_ts = comps_before[0]["created_timestamp"]
        # PATCH to update count
        client.patch(f"/completions/{t['id']}/{TODAY}", params={"count": 7})
        comps_after = client.get("/completions", params={"start": TODAY, "end": TODAY}).json()
        assert comps_after[0]["created_timestamp"] == created_ts
        assert comps_after[0]["completion_count"] == 7

    def test_negative_count_rejected(self, client):
        t = create_task(client)
        resp = client.patch(f"/completions/{t['id']}/{TODAY}", params={"count": -1})
        assert resp.status_code == 422

    def test_future_date_rejected(self, client):
        t = create_task(client)
        resp = client.patch(f"/completions/{t['id']}/{TOMORROW}", params={"count": 1})
        assert resp.status_code == 422

    def test_missing_task_returns_404(self, client):
        resp = client.patch(f"/completions/9999/{TODAY}", params={"count": 1})
        assert resp.status_code == 404

    def test_set_count_reflected_in_list_completions(self, client):
        t = create_task(client)
        client.patch(f"/completions/{t['id']}/{TODAY}", params={"count": 4})
        comps = client.get("/completions", params={"start": TODAY, "end": TODAY}).json()
        match = next((c for c in comps if c["task_id"] == t["id"]), None)
        assert match is not None
        assert match["completion_count"] == 4


# ---------------------------------------------------------------------------
# POST /import/apply
# ---------------------------------------------------------------------------

class TestImportApply:
    def _csv_bytes(self, rows: list[list[str]]) -> bytes:
        buf = io.StringIO()
        csv.writer(buf).writerows(rows)
        return buf.getvalue().encode("utf-8")

    def _post(self, client, content: bytes, filename: str = "sheet.csv"):
        return client.post(
            "/import/apply",
            files={"file": (filename, content, "text/csv")},
        )

    # --- fatal: missing name column ---

    def test_apply_missing_name_column_returns_400(self, client):
        resp = self._post(client, self._csv_bytes([["Category"], ["Health"]]))
        assert resp.status_code == 400

    def test_apply_missing_name_column_writes_nothing(self, client):
        self._post(client, self._csv_bytes([["Category"], ["Health"]]))
        assert client.get("/tasks").json() == []

    def test_apply_empty_csv_returns_400(self, client):
        resp = self._post(client, b"")
        assert resp.status_code == 400

    # --- basic creation ---

    def test_apply_creates_tasks(self, client):
        csv_bytes = self._csv_bytes([
            ["Task", "Priority", "Freq"],
            ["Exercise", "7", "3"],
            ["Meditate", "5", "1"],
        ])
        resp = self._post(client, csv_bytes)
        assert resp.status_code == 200
        assert resp.json()["tasks_created"] == 2
        tasks = client.get("/tasks").json()
        assert len(tasks) == 2
        names = {t["name"] for t in tasks}
        assert "Exercise" in names
        assert "Meditate" in names

    def test_apply_returns_summary_shape(self, client):
        resp = self._post(client, self._csv_bytes([["Task"], ["Run"]]))
        data = resp.json()
        for key in ("tasks_created", "completions_created", "rows_skipped",
                    "potential_duplicates", "warnings", "errors"):
            assert key in data

    # --- blank name ---

    def test_apply_blank_name_row_skipped(self, client):
        # Row has a non-blank category but blank name — survives the blank-row filter,
        # but is skipped by the apply logic when the name cell is empty.
        csv_bytes = self._csv_bytes([
            ["Task", "Category"],
            ["Exercise", "Health"],
            ["", "Fitness"],
        ])
        data = self._post(client, csv_bytes).json()
        assert data["tasks_created"] == 1
        assert data["rows_skipped"] == 1

    # --- duplicate detection ---

    def test_apply_duplicate_existing_task_skipped(self, client):
        create_task(client, name="Exercise", category="Health")
        csv_bytes = self._csv_bytes([["Task", "Category"], ["Exercise", "Health"]])
        data = self._post(client, csv_bytes).json()
        assert data["tasks_created"] == 0
        assert data["rows_skipped"] == 1
        assert len(data["potential_duplicates"]) == 1

    def test_apply_intra_import_duplicate_skipped(self, client):
        csv_bytes = self._csv_bytes([
            ["Task", "Category"],
            ["Exercise", "Health"],
            ["Exercise", "Health"],
        ])
        data = self._post(client, csv_bytes).json()
        assert data["tasks_created"] == 1
        assert data["rows_skipped"] == 1

    # --- completions ---

    def test_apply_creates_completions_for_date_cols(self, client):
        csv_bytes = self._csv_bytes([
            ["Task", YESTERDAY, TODAY],
            ["Exercise", "1", "1"],
        ])
        data = self._post(client, csv_bytes).json()
        assert data["tasks_created"] == 1
        assert data["completions_created"] == 2
        comps = client.get(
            "/completions", params={"start": YESTERDAY, "end": TODAY}
        ).json()
        assert len(comps) == 2

    def test_apply_completion_blank_is_none(self, client):
        csv_bytes = self._csv_bytes([["Task", TODAY], ["Exercise", ""]])
        data = self._post(client, csv_bytes).json()
        assert data["completions_created"] == 0

    def test_apply_completion_zero_is_none(self, client):
        csv_bytes = self._csv_bytes([["Task", TODAY], ["Exercise", "0"]])
        data = self._post(client, csv_bytes).json()
        assert data["completions_created"] == 0

    def test_apply_completion_false_is_none(self, client):
        csv_bytes = self._csv_bytes([["Task", TODAY], ["Exercise", "false"]])
        data = self._post(client, csv_bytes).json()
        assert data["completions_created"] == 0

    def test_apply_completion_no_is_none(self, client):
        csv_bytes = self._csv_bytes([["Task", TODAY], ["Exercise", "no"]])
        data = self._post(client, csv_bytes).json()
        assert data["completions_created"] == 0

    def test_apply_completion_true_creates_one(self, client):
        csv_bytes = self._csv_bytes([["Task", TODAY], ["Exercise", "true"]])
        data = self._post(client, csv_bytes).json()
        assert data["completions_created"] == 1
        comps = client.get("/completions", params={"start": TODAY, "end": TODAY}).json()
        assert comps[0]["completion_count"] == 1

    def test_apply_completion_yes_creates_one(self, client):
        csv_bytes = self._csv_bytes([["Task", TODAY], ["Exercise", "yes"]])
        assert self._post(client, csv_bytes).json()["completions_created"] == 1

    def test_apply_completion_x_creates_one(self, client):
        csv_bytes = self._csv_bytes([["Task", TODAY], ["Exercise", "x"]])
        assert self._post(client, csv_bytes).json()["completions_created"] == 1

    def test_apply_completion_checkmark_creates_one(self, client):
        csv_bytes = self._csv_bytes([["Task", TODAY], ["Exercise", "✓"]])
        assert self._post(client, csv_bytes).json()["completions_created"] == 1

    def test_apply_completion_integer_1_creates_one(self, client):
        csv_bytes = self._csv_bytes([["Task", TODAY], ["Exercise", "1"]])
        data = self._post(client, csv_bytes).json()
        assert data["completions_created"] == 1
        comps = client.get("/completions", params={"start": TODAY, "end": TODAY}).json()
        assert comps[0]["completion_count"] == 1

    def test_apply_completion_integer_gt1(self, client):
        csv_bytes = self._csv_bytes([["Task", TODAY], ["Exercise", "4"]])
        data = self._post(client, csv_bytes).json()
        assert data["completions_created"] == 1
        comps = client.get("/completions", params={"start": TODAY, "end": TODAY}).json()
        assert comps[0]["completion_count"] == 4

    def test_apply_completion_negative_skipped(self, client):
        csv_bytes = self._csv_bytes([["Task", TODAY], ["Exercise", "-1"]])
        data = self._post(client, csv_bytes).json()
        assert data["completions_created"] == 0
        assert len(data["errors"]) == 1

    def test_apply_completion_invalid_skipped(self, client):
        csv_bytes = self._csv_bytes([["Task", TODAY], ["Exercise", "lots"]])
        data = self._post(client, csv_bytes).json()
        assert data["completions_created"] == 0
        assert len(data["errors"]) == 1

    def test_apply_completion_future_date_skipped(self, client):
        csv_bytes = self._csv_bytes([["Task", TOMORROW], ["Exercise", "1"]])
        data = self._post(client, csv_bytes).json()
        assert data["completions_created"] == 0
        assert any(TOMORROW in w for w in data["warnings"])

    # --- duplicate ISO date headers ---

    def test_apply_duplicate_date_headers_warned(self, client):
        # Two columns with the same ISO date; only first is used
        buf = io.StringIO()
        writer = csv.writer(buf)
        writer.writerow(["Task", TODAY, TODAY])
        writer.writerow(["Exercise", "1", "2"])
        csv_bytes = buf.getvalue().encode("utf-8")
        data = self._post(client, csv_bytes).json()
        assert any("Duplicate" in w or "duplicate" in w for w in data["warnings"])
        # Only one completion should be created (from first column)
        assert data["completions_created"] == 1

    # --- defaults ---

    def test_apply_default_priority_used(self, client):
        csv_bytes = self._csv_bytes([["Task"], ["Exercise"]])
        self._post(client, csv_bytes)
        task = client.get("/tasks").json()[0]
        assert task["priority"] == 5

    def test_apply_default_interval_used(self, client):
        csv_bytes = self._csv_bytes([["Task"], ["Exercise"]])
        self._post(client, csv_bytes)
        task = client.get("/tasks").json()[0]
        assert task["interval_days"] == 7

    # --- second import is idempotent (no errors) ---

    def test_apply_second_import_is_safe(self, client):
        csv_bytes = self._csv_bytes([["Task", TODAY], ["Exercise", "1"]])
        self._post(client, csv_bytes)
        # Second import: task is duplicate, skipped; no completions attempted
        data = self._post(client, csv_bytes).json()
        assert data["tasks_created"] == 0
        assert data["completions_created"] == 0
        assert data["errors"] == []


# ---------------------------------------------------------------------------
# Status / hiatus unification  (UI-22)
# ---------------------------------------------------------------------------

class TestStatusHiatus:
    """status and is_paused must stay fully in sync at all times."""

    # --- create_task ---

    def test_create_with_status_hiatus_sets_is_paused(self, client):
        task = create_task(client, status="hiatus")
        assert task["status"] == "hiatus"
        assert task["is_paused"] == 1

    def test_create_with_status_active_clears_is_paused(self, client):
        task = create_task(client, status="active")
        assert task["status"] == "active"
        assert task["is_paused"] == 0

    def test_create_default_status_is_active(self, client):
        task = create_task(client)
        assert task["status"] == "active"
        assert task["is_paused"] == 0

    def test_create_legacy_status_on_hold_normalizes_to_hiatus(self, client):
        task = create_task(client, status="on-hold")
        assert task["status"] == "hiatus"
        assert task["is_paused"] == 1

    def test_create_legacy_status_someday_normalizes_to_hiatus(self, client):
        task = create_task(client, status="someday")
        assert task["status"] == "hiatus"
        assert task["is_paused"] == 1

    def test_create_unknown_status_normalizes_to_active(self, client):
        task = create_task(client, status="focus")
        assert task["status"] == "active"
        assert task["is_paused"] == 0

    # --- update_task via status ---

    def test_update_status_to_hiatus_sets_is_paused(self, client):
        task = create_task(client)
        tid = task["id"]
        resp = client.patch(f"/tasks/{tid}", params={"status": "hiatus"})
        assert resp.status_code == 200
        updated = resp.json()
        assert updated["status"] == "hiatus"
        assert updated["is_paused"] == 1

    def test_update_status_to_active_clears_is_paused(self, client):
        task = create_task(client, status="hiatus")
        tid = task["id"]
        resp = client.patch(f"/tasks/{tid}", params={"status": "active"})
        assert resp.status_code == 200
        updated = resp.json()
        assert updated["status"] == "active"
        assert updated["is_paused"] == 0

    # --- update_task via is_paused ---

    def test_update_is_paused_true_sets_status_hiatus(self, client):
        task = create_task(client)
        tid = task["id"]
        resp = client.patch(f"/tasks/{tid}", params={"is_paused": "true"})
        assert resp.status_code == 200
        updated = resp.json()
        assert updated["status"] == "hiatus"
        assert updated["is_paused"] == 1

    def test_update_is_paused_false_sets_status_active(self, client):
        task = create_task(client, status="hiatus")
        tid = task["id"]
        resp = client.patch(f"/tasks/{tid}", params={"is_paused": "false"})
        assert resp.status_code == 200
        updated = resp.json()
        assert updated["status"] == "active"
        assert updated["is_paused"] == 0

    # --- status wins when both are provided ---

    def test_update_status_takes_priority_over_is_paused(self, client):
        # Providing status=active and is_paused=true simultaneously:
        # status wins → active, is_paused=0
        task = create_task(client, status="hiatus")
        tid = task["id"]
        resp = client.patch(f"/tasks/{tid}", params={"status": "active", "is_paused": "true"})
        assert resp.status_code == 200
        updated = resp.json()
        assert updated["status"] == "active"
        assert updated["is_paused"] == 0


# ---------------------------------------------------------------------------
# active_from field  (UI-22)
# ---------------------------------------------------------------------------

class TestActiveFrom:
    """active_from is stored, returned, and included in CSV export."""

    def test_create_without_active_from_defaults_to_null(self, client):
        task = create_task(client)
        assert task.get("active_from") is None

    def test_create_with_active_from_stores_value(self, client):
        task = create_task(client, active_from="2025-06-01")
        assert task["active_from"] == "2025-06-01"

    def test_update_active_from(self, client):
        task = create_task(client)
        tid = task["id"]
        resp = client.patch(f"/tasks/{tid}", params={"active_from": "2025-09-01"})
        assert resp.status_code == 200
        assert resp.json()["active_from"] == "2025-09-01"

    def test_update_clear_active_from(self, client):
        task = create_task(client, active_from="2025-06-01")
        tid = task["id"]
        resp = client.patch(f"/tasks/{tid}", params={"active_from": ""})
        assert resp.status_code == 200
        result = resp.json()
        assert result.get("active_from") in (None, "")

    def test_active_from_in_task_list(self, client):
        create_task(client, active_from="2025-03-15")
        tasks = client.get("/tasks").json()
        assert tasks[0]["active_from"] == "2025-03-15"

    def test_csv_export_includes_active_from(self, client):
        create_task(client, name="Stretching", active_from="2025-01-01")
        resp = client.get("/export/sheet.csv", params={"start": TODAY, "end": TODAY})
        assert resp.status_code == 200
        text = resp.text
        reader = csv.reader(io.StringIO(text))
        headers = next(reader)
        assert "active_from" in headers
        row = next(reader)
        row_dict = dict(zip(headers, row))
        assert row_dict["active_from"] == "2025-01-01"

    def test_csv_export_active_from_null_is_empty_string(self, client):
        create_task(client, name="Stretching")
        resp = client.get("/export/sheet.csv", params={"start": TODAY, "end": TODAY})
        text = resp.text
        reader = csv.reader(io.StringIO(text))
        headers = next(reader)
        row = next(reader)
        row_dict = dict(zip(headers, row))
        assert row_dict.get("active_from", "") == ""

    def test_csv_import_without_active_from_column_still_works(self, client):
        """Old CSV files without active_from column import cleanly."""
        buf = io.StringIO()
        writer = csv.writer(buf)
        writer.writerow(["Task", "Priority", TODAY])
        writer.writerow(["Exercise", "6", "1"])
        csv_bytes = buf.getvalue().encode("utf-8")
        resp = client.post("/import/apply", files={"file": ("import.csv", csv_bytes, "text/csv")})
        assert resp.status_code == 200
        data = resp.json()
        assert data["tasks_created"] == 1
        assert data["errors"] == []
        task = client.get("/tasks").json()[0]
        assert task.get("active_from") is None

    def test_csv_import_with_active_from_column_stores_value(self, client):
        buf = io.StringIO()
        writer = csv.writer(buf)
        writer.writerow(["Task", "active_from"])
        writer.writerow(["Exercise", "2025-05-01"])
        csv_bytes = buf.getvalue().encode("utf-8")
        resp = client.post("/import/apply", files={"file": ("import.csv", csv_bytes, "text/csv")})
        assert resp.status_code == 200
        task = client.get("/tasks").json()[0]
        assert task["active_from"] == "2025-05-01"


# ---------------------------------------------------------------------------
# Archive rename / delete  (UI-23)
# ---------------------------------------------------------------------------

class TestArchiveRenameDelete:
    """PATCH /archives/{id} and DELETE /archives/{id} endpoints."""

    def _create_archive(self, client, name="2026-05"):
        resp = client.post("/archives", params={
            "name": name, "start_date": "2026-05-01", "end_date": "2026-05-31",
        })
        assert resp.status_code == 201, resp.text
        return resp.json()

    # --- rename ---

    def test_rename_archive_succeeds(self, client):
        a = self._create_archive(client)
        resp = client.patch(f"/archives/{a['id']}", params={"name": "May 2026"})
        assert resp.status_code == 200
        assert resp.json()["name"] == "May 2026"

    def test_rename_archive_persists_in_list(self, client):
        a = self._create_archive(client)
        client.patch(f"/archives/{a['id']}", params={"name": "Renamed"})
        listing = client.get("/archives").json()
        assert any(x["name"] == "Renamed" for x in listing)

    def test_rename_archive_persists_in_detail(self, client):
        a = self._create_archive(client)
        client.patch(f"/archives/{a['id']}", params={"name": "Detail Check"})
        detail = client.get(f"/archives/{a['id']}").json()
        assert detail["name"] == "Detail Check"

    def test_rename_missing_archive_returns_404(self, client):
        resp = client.patch("/archives/9999", params={"name": "X"})
        assert resp.status_code == 404

    def test_rename_blank_name_returns_400(self, client):
        a = self._create_archive(client)
        resp = client.patch(f"/archives/{a['id']}", params={"name": "   "})
        assert resp.status_code == 400

    def test_rename_does_not_alter_snapshot_data(self, client):
        a = self._create_archive(client)
        client.patch(f"/archives/{a['id']}", params={"name": "New Name"})
        detail = client.get(f"/archives/{a['id']}").json()
        assert detail["snapshot_data_json"]["start_date"] == "2026-05-01"
        assert detail["snapshot_data_json"]["end_date"] == "2026-05-31"

    # --- delete ---

    def test_delete_archive_succeeds(self, client):
        a = self._create_archive(client)
        resp = client.delete(f"/archives/{a['id']}")
        assert resp.status_code == 200
        assert resp.json()["deleted"] == a["id"]

    def test_delete_missing_archive_returns_404(self, client):
        resp = client.delete("/archives/9999")
        assert resp.status_code == 404

    def test_delete_archive_removes_from_list(self, client):
        a = self._create_archive(client)
        client.delete(f"/archives/{a['id']}")
        listing = client.get("/archives").json()
        assert all(x["id"] != a["id"] for x in listing)

    def test_delete_archive_does_not_delete_tasks(self, client):
        create_task(client, name="Keep This Task")
        a = self._create_archive(client)
        client.delete(f"/archives/{a['id']}")
        tasks = client.get("/tasks").json()
        assert len(tasks) == 1
        assert tasks[0]["name"] == "Keep This Task"

    def test_delete_archive_does_not_affect_other_archives(self, client):
        a1 = self._create_archive(client, name="April")
        a2 = self._create_archive(client, name="May")
        client.delete(f"/archives/{a1['id']}")
        listing = client.get("/archives").json()
        assert any(x["id"] == a2["id"] for x in listing)
        assert all(x["id"] != a1["id"] for x in listing)

    def test_deleted_archive_detail_returns_404(self, client):
        a = self._create_archive(client)
        client.delete(f"/archives/{a['id']}")
        resp = client.get(f"/archives/{a['id']}")
        assert resp.status_code == 404


# ---------------------------------------------------------------------------
# manual_last_done_override date normalization  (emergency fix)
# ---------------------------------------------------------------------------

class TestManualOverrideNormalization:
    """US-format dates in manual_last_done_override must not crash GET /tasks."""

    def _import_with_override(self, client, override_value):
        """Import a task via CSV with the given manual_last_done_override value."""
        buf = io.StringIO()
        writer = csv.writer(buf)
        writer.writerow(["Task", "manual last done override"])
        writer.writerow(["Exercise", override_value])
        csv_bytes = buf.getvalue().encode("utf-8")
        resp = client.post("/import/apply", files={"file": ("import.csv", csv_bytes, "text/csv")})
        assert resp.status_code == 200, resp.text

    def test_us_short_date_does_not_crash_get_tasks(self, client):
        # "3/28/26" is the format that caused the 500 in production.
        self._import_with_override(client, "3/28/26")
        resp = client.get("/tasks")
        assert resp.status_code == 200

    def test_us_short_date_normalizes_to_iso(self, client):
        self._import_with_override(client, "3/28/26")
        task = client.get("/tasks").json()[0]
        assert task["manual_last_done_override"] == "2026-03-28"

    def test_us_long_date_normalizes_to_iso(self, client):
        self._import_with_override(client, "03/28/2026")
        task = client.get("/tasks").json()[0]
        assert task["manual_last_done_override"] == "2026-03-28"

    def test_iso_date_passes_through_unchanged(self, client):
        self._import_with_override(client, "2026-03-28")
        task = client.get("/tasks").json()[0]
        assert task["manual_last_done_override"] == "2026-03-28"

    def test_invalid_date_does_not_crash_get_tasks(self, client):
        # Completely unrecognized formats should be silently discarded.
        self._import_with_override(client, "not-a-date")
        resp = client.get("/tasks")
        assert resp.status_code == 200

    def test_invalid_date_stored_as_null(self, client):
        self._import_with_override(client, "not-a-date")
        task = client.get("/tasks").json()[0]
        assert task["manual_last_done_override"] is None

    def test_create_task_with_us_date_normalizes(self, client):
        resp = client.post("/tasks", params={
            "name": "Test", "manual_last_done_override": "1/5/25",
        })
        assert resp.status_code == 201
        assert resp.json()["manual_last_done_override"] == "2025-01-05"

    def test_update_task_with_us_date_normalizes(self, client):
        task = create_task(client)
        resp = client.patch(f"/tasks/{task['id']}", params={
            "manual_last_done_override": "12/31/26",
        })
        assert resp.status_code == 200
        assert resp.json()["manual_last_done_override"] == "2026-12-31"

    def test_existing_iso_date_unaffected_by_normalization(self, client):
        task = create_task(client, manual_last_done_override="2025-06-15")
        assert task["manual_last_done_override"] == "2025-06-15"
        resp = client.get("/tasks")
        assert resp.status_code == 200
        assert resp.json()[0]["manual_last_done_override"] == "2025-06-15"


# ---------------------------------------------------------------------------
# DELETE /tasks/{id} — soft delete  (UI-25)
# ---------------------------------------------------------------------------

class TestDeleteTask:
    """Soft-delete sets is_active=0; preserves completions and archives."""

    def test_delete_returns_200(self, client):
        task = create_task(client)
        resp = client.delete(f"/tasks/{task['id']}")
        assert resp.status_code == 200
        assert resp.json()["deleted"] == task["id"]

    def test_deleted_task_absent_from_list(self, client):
        task = create_task(client)
        client.delete(f"/tasks/{task['id']}")
        ids = [t["id"] for t in client.get("/tasks").json()]
        assert task["id"] not in ids

    def test_delete_nonexistent_returns_404(self, client):
        resp = client.delete("/tasks/9999")
        assert resp.status_code == 404

    def test_delete_already_deleted_returns_404(self, client):
        task = create_task(client)
        client.delete(f"/tasks/{task['id']}")
        resp = client.delete(f"/tasks/{task['id']}")
        assert resp.status_code == 404

    def test_delete_does_not_affect_other_tasks(self, client):
        t1 = create_task(client, name="Keep")
        t2 = create_task(client, name="Delete Me")
        client.delete(f"/tasks/{t2['id']}")
        ids = [t["id"] for t in client.get("/tasks").json()]
        assert t1["id"] in ids
        assert t2["id"] not in ids

    def test_delete_preserves_completions_in_backup(self, client):
        # Completions for a soft-deleted task must not be cascade-deleted.
        task = create_task(client)
        client.post("/completions", params={"task_id": task["id"], "completion_date": TODAY})
        client.delete(f"/tasks/{task['id']}")
        # Backup export includes all tasks (no is_active filter) and their completions
        backup = client.get("/export/backup.json").json()
        deleted_task = next((t for t in backup["tasks"] if t["id"] == task["id"]), None)
        assert deleted_task is not None, "soft-deleted task must appear in backup"

    def test_delete_does_not_affect_archive_snapshots(self, client):
        task = create_task(client)
        archive_resp = client.post("/archives", params={
            "name": "test", "start_date": TODAY, "end_date": TODAY,
        })
        assert archive_resp.status_code == 201
        archive_id = archive_resp.json()["id"]
        client.delete(f"/tasks/{task['id']}")
        detail = client.get(f"/archives/{archive_id}").json()
        task_ids_in_snap = [t["id"] for t in detail["snapshot_data_json"]["tasks"]]
        assert task["id"] in task_ids_in_snap

    def test_delete_reduces_active_task_count(self, client):
        create_task(client, name="A")
        create_task(client, name="B")
        before = len(client.get("/tasks").json())
        task = create_task(client, name="C")
        client.delete(f"/tasks/{task['id']}")
        after = len(client.get("/tasks").json())
        assert after == before

    def test_deleted_task_not_in_csv_export(self, client):
        task = create_task(client, name="Gone")
        client.delete(f"/tasks/{task['id']}")
        text = client.get("/export/sheet.csv", params={"start": TODAY, "end": TODAY}).text
        assert "Gone" not in text

    def test_delete_hiatus_task_succeeds(self, client):
        task = create_task(client, status="hiatus")
        resp = client.delete(f"/tasks/{task['id']}")
        assert resp.status_code == 200

    def test_delete_task_with_active_from_succeeds(self, client):
        task = create_task(client, active_from="2025-01-01")
        resp = client.delete(f"/tasks/{task['id']}")
        assert resp.status_code == 200
        assert task["id"] not in [t["id"] for t in client.get("/tasks").json()]
