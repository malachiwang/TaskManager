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
        assert "archive_snapshots" in data

    def test_backup_empty_db_returns_valid_empty_arrays(self, client):
        data = client.get("/export/backup.json").json()
        assert data["tasks"] == []
        assert data["completions"] == []
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
