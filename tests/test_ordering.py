"""
Ordering (P12.1) — persisted manual section order + task order invariants.

The core UX contract under test: the user's manual arrangement is deliberate.
Sections never reorder themselves; ordinary task mutations never move
sections; task order is explicit persisted state; and every position —
including the true bottom of a section — is representable and durable.
"""
import pytest
from starlette.testclient import TestClient

import backend.database as db_module
from backend.main import app


def _make_task(client, name="Task", section="General", **overrides):
    params = {"name": name, "section": section}
    params.update(overrides)
    res = client.post("/tasks", params=params)
    assert res.status_code == 201, res.text
    return res.json()


def _section_names(client):
    res = client.get("/sections")
    assert res.status_code == 200
    return [s["name"] for s in res.json()]


def _task_names(client):
    res = client.get("/tasks")
    assert res.status_code == 200
    return [t["name"] for t in res.json()]


def _seed_sections(client, names=("School", "Career", "Research", "Admin")):
    """One task per section, in order — GET /sections then lists them in
    encounter order."""
    tasks = {}
    for name in names:
        tasks[name] = _make_task(client, name=f"{name} task", section=name)
    assert _section_names(client) == list(names)
    return tasks


class TestSectionOrder:
    def test_sections_appear_in_encounter_order(self, client):
        _seed_sections(client)

    def test_reorder_upward(self, client):
        _seed_sections(client)
        res = client.post("/sections/reorder", json={"order": ["School", "Research", "Career", "Admin"]})
        assert res.status_code == 200
        assert _section_names(client) == ["School", "Research", "Career", "Admin"]

    def test_reorder_downward(self, client):
        _seed_sections(client)
        client.post("/sections/reorder", json={"order": ["Career", "Research", "School", "Admin"]})
        assert _section_names(client) == ["Career", "Research", "School", "Admin"]

    def test_first_to_last(self, client):
        _seed_sections(client)
        client.post("/sections/reorder", json={"order": ["Career", "Research", "Admin", "School"]})
        assert _section_names(client) == ["Career", "Research", "Admin", "School"]

    def test_last_to_first(self, client):
        _seed_sections(client)
        client.post("/sections/reorder", json={"order": ["Admin", "School", "Career", "Research"]})
        assert _section_names(client) == ["Admin", "School", "Career", "Research"]

    def test_unknown_names_ignored(self, client):
        _seed_sections(client)
        client.post("/sections/reorder", json={"order": ["Ghost", "Admin", "School", "Career", "Research"]})
        assert _section_names(client) == ["Admin", "School", "Career", "Research"]

    def test_partial_order_keeps_unlisted_after(self, client):
        # A reorder sent while some sections were filtered out of view must
        # not lose the hidden sections — they keep relative order at the end.
        _seed_sections(client)
        client.post("/sections/reorder", json={"order": ["Research", "School"]})
        assert _section_names(client) == ["Research", "School", "Career", "Admin"]

    def test_restart_preserves_order(self, tmp_path, monkeypatch):
        # Full app restart (init_db runs again on the same file) must not
        # reseed or rearrange — the migration seeds only on first creation.
        test_db = tmp_path / "restart.db"
        monkeypatch.setattr(db_module, "DB_PATH", test_db)
        with TestClient(app) as c:
            _seed_sections(c)
            c.post("/sections/reorder", json={"order": ["Research", "Admin", "School", "Career"]})
            assert _section_names(c) == ["Research", "Admin", "School", "Career"]
        with TestClient(app) as c2:
            assert _section_names(c2) == ["Research", "Admin", "School", "Career"]

    def test_rename_preserves_position_and_updates_tasks(self, client):
        tasks = _seed_sections(client)
        client.post("/sections/reorder", json={"order": ["Research", "School", "Career", "Admin"]})
        res = client.post("/sections/rename", json={"old": "School", "new": "Uni"})
        assert res.status_code == 200
        assert _section_names(client) == ["Research", "Uni", "Career", "Admin"]
        task = client.get(f"/tasks/{tasks['School']['id']}").json()
        assert task["section"] == "Uni"

    def test_rename_to_existing_conflicts(self, client):
        _seed_sections(client)
        res = client.post("/sections/rename", json={"old": "School", "new": "Career"})
        assert res.status_code == 409

    def test_rename_unknown_404(self, client):
        res = client.post("/sections/rename", json={"old": "Nope", "new": "X"})
        assert res.status_code == 404

    def test_rename_blank_rejected(self, client):
        _seed_sections(client)
        res = client.post("/sections/rename", json={"old": "School", "new": "  "})
        assert res.status_code == 422


class TestSectionStability:
    """Ordinary task actions must never reorder sections."""

    def test_task_creation_does_not_move_sections(self, client):
        _seed_sections(client)
        client.post("/sections/reorder", json={"order": ["Admin", "Research", "School", "Career"]})
        _make_task(client, name="Late admin task", section="Admin")
        _make_task(client, name="Late career task", section="Career")
        assert _section_names(client) == ["Admin", "Research", "School", "Career"]

    def test_new_section_appends_at_end(self, client):
        _seed_sections(client)
        _make_task(client, name="New area task", section="Health")
        assert _section_names(client) == ["School", "Career", "Research", "Admin", "Health"]

    def test_task_completion_does_not_move_sections(self, client):
        tasks = _seed_sections(client)
        order_before = _section_names(client)
        today = client.get("/tasks").json()[0]["created_at"]
        res = client.post("/completions", params={
            "task_id": tasks["Research"]["id"], "completion_date": today,
        })
        assert res.status_code in (200, 201)
        assert _section_names(client) == order_before

    def test_task_edit_and_delete_do_not_move_sections(self, client):
        tasks = _seed_sections(client)
        order_before = _section_names(client)
        client.patch(f"/tasks/{tasks['Career']['id']}", params={"priority": 9})
        extra = _make_task(client, name="Doomed", section="School")
        client.delete(f"/tasks/{extra['id']}")
        assert _section_names(client) == order_before

    def test_task_reorder_does_not_move_sections(self, client):
        _seed_sections(client)
        order_before = _section_names(client)
        ids = [t["id"] for t in client.get("/tasks").json()]
        client.post("/tasks/reorder", json={"order": list(reversed(ids))})
        # Section ORDER is persisted state — reversing every task's global
        # position must not rearrange the section list.
        assert _section_names(client) == order_before

    def test_cross_section_move_does_not_move_unrelated_sections(self, client):
        tasks = _seed_sections(client)
        order_before = _section_names(client)
        ids = [t["id"] for t in client.get("/tasks").json()]
        client.post("/tasks/reorder", json={
            "order": ids,
            "section_updates": [{"id": tasks["Admin"]["id"], "section": "School"}],
        })
        assert _section_names(client) == order_before

    def test_emptied_section_stays_listed(self, client):
        tasks = _seed_sections(client)
        client.delete(f"/tasks/{tasks['Research']['id']}")
        # Research now has zero active tasks but keeps its place — empty
        # sections remain valid drop destinations across reloads.
        assert _section_names(client) == ["School", "Career", "Research", "Admin"]


class TestSectionDelete:
    def test_delete_empty_section(self, client):
        tasks = _seed_sections(client)
        client.delete(f"/tasks/{tasks['Admin']['id']}")
        res = client.delete("/sections", params={"name": "Admin"})
        assert res.status_code == 200
        assert _section_names(client) == ["School", "Career", "Research"]

    def test_delete_populated_section_refused(self, client):
        _seed_sections(client)
        res = client.delete("/sections", params={"name": "School"})
        assert res.status_code == 409

    def test_delete_unknown_404(self, client):
        assert client.delete("/sections", params={"name": "Nope"}).status_code == 404


class TestTaskOrder:
    def _seed_tasks(self, client, names=("A", "B", "C", "D"), section="General"):
        return {n: _make_task(client, name=n, section=section) for n in names}

    def test_new_tasks_append_at_end(self, client):
        self._seed_tasks(client)
        assert _task_names(client) == ["A", "B", "C", "D"]
        orders = [t["display_order"] for t in client.get("/tasks").json()]
        assert orders == sorted(orders)
        assert len(set(orders)) == 4  # strictly increasing, not all zero

    def test_move_upward_and_downward(self, client):
        t = self._seed_tasks(client)
        client.post("/tasks/reorder", json={"order": [t["A"]["id"], t["C"]["id"], t["B"]["id"], t["D"]["id"]]})
        assert _task_names(client) == ["A", "C", "B", "D"]
        client.post("/tasks/reorder", json={"order": [t["A"]["id"], t["B"]["id"], t["C"]["id"], t["D"]["id"]]})
        assert _task_names(client) == ["A", "B", "C", "D"]

    def test_first_to_last(self, client):
        t = self._seed_tasks(client)
        client.post("/tasks/reorder", json={"order": [t["B"]["id"], t["C"]["id"], t["D"]["id"], t["A"]["id"]]})
        assert _task_names(client) == ["B", "C", "D", "A"]

    def test_last_to_first(self, client):
        t = self._seed_tasks(client)
        client.post("/tasks/reorder", json={"order": [t["D"]["id"], t["A"]["id"], t["B"]["id"], t["C"]["id"]]})
        assert _task_names(client) == ["D", "A", "B", "C"]

    def test_restart_preserves_task_order(self, tmp_path, monkeypatch):
        test_db = tmp_path / "restart-tasks.db"
        monkeypatch.setattr(db_module, "DB_PATH", test_db)
        with TestClient(app) as c:
            t = {n: _make_task(c, name=n) for n in ("A", "B", "C", "D")}
            c.post("/tasks/reorder", json={"order": [t["A"]["id"], t["D"]["id"], t["B"]["id"], t["C"]["id"]]})
            assert _task_names(c) == ["A", "D", "B", "C"]
        with TestClient(app) as c2:
            assert _task_names(c2) == ["A", "D", "B", "C"]

    def test_completion_does_not_change_task_order(self, client):
        t = self._seed_tasks(client)
        today = t["A"]["created_at"]
        client.post("/completions", params={"task_id": t["B"]["id"], "completion_date": today})
        assert _task_names(client) == ["A", "B", "C", "D"]


class TestCrossSectionMoves:
    def test_move_to_bottom_of_other_section(self, client):
        school = {n: _make_task(client, name=n, section="School") for n in ("A", "B", "C")}
        research = {n: _make_task(client, name=n, section="Research") for n in ("X", "Y")}
        # Drag B below Y: new global order with B after Y, B's section → Research.
        new_order = [school["A"]["id"], school["C"]["id"],
                     research["X"]["id"], research["Y"]["id"], school["B"]["id"]]
        res = client.post("/tasks/reorder", json={
            "order": new_order,
            "section_updates": [{"id": school["B"]["id"], "section": "Research"}],
        })
        assert res.status_code == 200
        tasks = client.get("/tasks").json()
        by_section = {}
        for task in tasks:
            by_section.setdefault(task["section"], []).append(task["name"])
        assert by_section["School"] == ["A", "C"]
        assert by_section["Research"] == ["X", "Y", "B"]

    def test_move_into_empty_section(self, client):
        seeder = _make_task(client, name="Seeder", section="Empty")
        task = _make_task(client, name="Mover", section="School")
        client.delete(f"/tasks/{seeder['id']}")
        assert "Empty" in _section_names(client)  # still listed, zero tasks
        res = client.post("/tasks/reorder", json={
            "order": [task["id"]],
            "section_updates": [{"id": task["id"], "section": "Empty"}],
        })
        assert res.status_code == 200
        moved = client.get(f"/tasks/{task['id']}").json()
        assert moved["section"] == "Empty"

    def test_section_update_and_order_are_atomic(self, client):
        # Both effects of one drag arrive in one request/transaction — verify
        # the combined result matches exactly what was sent.
        a = _make_task(client, name="A", section="One")
        b = _make_task(client, name="B", section="Two")
        res = client.post("/tasks/reorder", json={
            "order": [b["id"], a["id"]],
            "section_updates": [{"id": a["id"], "section": "Two"}],
        })
        assert res.status_code == 200
        tasks = client.get("/tasks").json()
        assert [t["name"] for t in tasks] == ["B", "A"]
        assert all(t["section"] == "Two" for t in tasks)

    def test_plain_reorder_never_changes_sections(self, client):
        a = _make_task(client, name="A", section="One")
        b = _make_task(client, name="B", section="Two")
        client.post("/tasks/reorder", json={"order": [b["id"], a["id"]]})
        tasks = {t["name"]: t for t in client.get("/tasks").json()}
        assert tasks["A"]["section"] == "One"
        assert tasks["B"]["section"] == "Two"
