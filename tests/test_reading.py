"""
Integration tests for the Reading Sheet API (P5.0).

Covers book create/update, page checkpoints + current_page updates, page
clamping/validation, finish/archive persistence with preserved history, and
inclusion of reading data in the JSON export/restore flow.
"""
import io
import json


def _book(client, **fields):
    fields.setdefault("title", "Test Book")
    r = client.post("/reading/books", json=fields)
    assert r.status_code == 201, r.text
    return r.json()


class TestReadingBooks:
    def test_create_book_with_progress_fields(self, client):
        b = _book(client, title="Dune", author="Herbert", total_pages=412, current_page=50)
        assert b["title"] == "Dune"
        assert b["current_page"] == 50
        assert b["percent_complete"] == 12.1
        assert b["pages_remaining"] == 362
        # current_page > 0 seeds a checkpoint entry
        assert b["last_entry_date"] is not None

    def test_create_title_only_allows_unknown_length(self, client):
        b = _book(client, title="Mystery")
        assert b["total_pages"] is None
        assert b["percent_complete"] is None
        assert b["pages_remaining"] is None

    def test_title_required(self, client):
        assert client.post("/reading/books", json={"author": "x"}).status_code == 400
        assert client.post("/reading/books", json={"title": "   "}).status_code == 400

    def test_update_book_metadata(self, client):
        b = _book(client, title="Old", total_pages=100)
        r = client.patch(f"/reading/books/{b['id']}", json={"title": "New", "author": "A", "total_pages": 200})
        assert r.status_code == 200
        upd = r.json()
        assert upd["title"] == "New"
        assert upd["author"] == "A"
        assert upd["total_pages"] == 200

    def test_blank_title_update_rejected(self, client):
        b = _book(client, title="Keep")
        assert client.patch(f"/reading/books/{b['id']}", json={"title": "  "}).status_code == 400


class TestReadingCheckpoints:
    def test_entry_updates_current_page_and_progress(self, client):
        b = _book(client, title="P", total_pages=300, current_page=10)
        r = client.post(f"/reading/books/{b['id']}/entries", json={"page": 150})
        assert r.status_code == 201
        upd = r.json()
        assert upd["current_page"] == 150
        assert upd["percent_complete"] == 50.0

    def test_page_clamped_to_total(self, client):
        b = _book(client, title="P", total_pages=200)
        upd = client.post(f"/reading/books/{b['id']}/entries", json={"page": 99999}).json()
        assert upd["current_page"] == 200

    def test_negative_page_clamped_to_zero(self, client):
        b = _book(client, title="P", total_pages=200, current_page=50)
        upd = client.post(f"/reading/books/{b['id']}/entries", json={"page": -10}).json()
        assert upd["current_page"] == 0

    def test_history_preserved_one_per_day(self, client):
        b = _book(client, title="P", total_pages=500)
        client.post(f"/reading/books/{b['id']}/entries", json={"page": 100, "entry_date": "2026-01-01"})
        client.post(f"/reading/books/{b['id']}/entries", json={"page": 200, "entry_date": "2026-01-02"})
        # Same-day re-log upserts (does not duplicate)
        client.post(f"/reading/books/{b['id']}/entries", json={"page": 250, "entry_date": "2026-01-02"})
        entries = client.get(f"/reading/books/{b['id']}/entries").json()
        assert len(entries) == 2
        assert entries[-1]["page"] == 250


class TestReadingLifecycle:
    def test_finish_sets_date_and_persists(self, client):
        b = _book(client, title="Fin", total_pages=100, current_page=100)
        upd = client.patch(f"/reading/books/{b['id']}", json={"status": "finished"}).json()
        assert upd["status"] == "finished"
        assert upd["finished_at"] is not None
        assert upd["current_page"] == 100
        # persists across a fresh list read
        listed = {x["id"]: x for x in client.get("/reading/books").json()}
        assert listed[b["id"]]["status"] == "finished"

    def test_archive_preserves_history(self, client):
        b = _book(client, title="Arch", total_pages=100, current_page=40)
        client.post(f"/reading/books/{b['id']}/entries", json={"page": 60})
        client.patch(f"/reading/books/{b['id']}", json={"status": "archived"})
        assert client.get("/reading/books").json()[0]["status"] == "archived"
        # entries survive archiving
        assert len(client.get(f"/reading/books/{b['id']}/entries").json()) >= 1


class TestReadingBackup:
    def test_export_includes_reading(self, client):
        _book(client, title="Exported", total_pages=100, current_page=25)
        payload = client.get("/export/backup.json").json()
        assert payload["schema_version"] == 5
        assert any(bk["title"] == "Exported" for bk in payload["reading_books"])
        assert len(payload["reading_entries"]) >= 1

    def test_restore_round_trip_reading(self, client):
        _book(client, title="RoundTrip", author="RT", total_pages=200, current_page=80)
        exported = client.get("/export/backup.json").text

        # Wipe reading books
        for bk in client.get("/reading/books").json():
            client.delete(f"/reading/books/{bk['id']}")
        assert client.get("/reading/books").json() == []

        # Restore from the exported backup
        files = {"file": ("backup.json", io.BytesIO(exported.encode()), "application/json")}
        r = client.post("/restore/backup.json", files=files)
        assert r.status_code == 200, r.text
        assert r.json()["reading_books"] >= 1

        restored = client.get("/reading/books").json()
        assert any(b["title"] == "RoundTrip" and b["current_page"] == 80 for b in restored)
