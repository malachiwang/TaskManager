"""
Integration tests for all API endpoints.

Each test uses the `client` fixture from conftest.py which provides a fresh,
isolated SQLite database. No test shares state with any other test.

Run with: pytest tests/test_api.py -v
"""
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
