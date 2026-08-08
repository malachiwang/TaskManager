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
        assert payload["schema_version"] == 6
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


# ---------------------------------------------------------------------------
# Reading v2 (P11.0) — priority color coding + Books to Buy
# ---------------------------------------------------------------------------

class TestReadingPriority:
    def test_default_priority_is_3(self, client):
        b = _book(client, title="Plain")
        assert b["priority"] == 3
        assert b["to_buy"] == 0
        assert b["purchase_url"] == ""
        assert b["purchase_notes"] == ""
        assert b["purchased_at"] is None

    def test_priority_saved_and_returned(self, client):
        b = _book(client, title="Important", priority=5)
        assert b["priority"] == 5
        upd = client.patch(f"/reading/books/{b['id']}", json={"priority": 1}).json()
        assert upd["priority"] == 1
        listed = {x["id"]: x for x in client.get("/reading/books").json()}
        assert listed[b["id"]]["priority"] == 1

    def test_priority_clamped_to_1_5(self, client):
        assert _book(client, title="Hi", priority=99)["priority"] == 5
        assert _book(client, title="Lo", priority=0)["priority"] == 1


class TestBooksToBuy:
    def test_create_to_buy_book(self, client):
        b = _book(client, title="Wishlist", to_buy=True, priority=4,
                  purchase_url="https://example.com/book", purchase_notes="recommended by A")
        assert b["to_buy"] == 1
        assert b["purchase_url"] == "https://example.com/book"
        assert b["purchase_notes"] == "recommended by A"
        # No fake progress: no checkpoint seeded, no started_at stamped.
        assert b["current_page"] == 0
        assert b["started_at"] is None
        assert client.get(f"/reading/books/{b['id']}/entries").json() == []

    def test_edit_and_delete_to_buy_book(self, client):
        b = _book(client, title="Draft", to_buy=True)
        upd = client.patch(f"/reading/books/{b['id']}", json={
            "title": "Renamed", "author": "New A", "priority": 2,
            "purchase_url": "www.shop.example", "purchase_notes": "paperback",
        }).json()
        assert upd["title"] == "Renamed"
        assert upd["purchase_url"] == "www.shop.example"
        assert client.delete(f"/reading/books/{b['id']}").status_code == 200
        assert client.get("/reading/books").json() == []

    def test_mark_bought_moves_out_of_to_buy(self, client):
        b = _book(client, title="Bought Soon", author="Auth", to_buy=True,
                  priority=5, purchase_notes="gift idea")
        upd = client.patch(f"/reading/books/{b['id']}", json={"to_buy": False}).json()
        assert upd["to_buy"] == 0
        assert upd["purchased_at"] is not None  # stamped today
        # Identity and notes survive; still no fabricated checkpoints.
        assert upd["title"] == "Bought Soon"
        assert upd["author"] == "Auth"
        assert upd["priority"] == 5
        assert upd["purchase_notes"] == "gift idea"
        assert client.get(f"/reading/books/{b['id']}/entries").json() == []

    def test_rewishlist_clears_purchased_at(self, client):
        b = _book(client, title="Back Again", to_buy=True)
        client.patch(f"/reading/books/{b['id']}", json={"to_buy": False})
        upd = client.patch(f"/reading/books/{b['id']}", json={"to_buy": True}).json()
        assert upd["to_buy"] == 1
        assert upd["purchased_at"] is None

    def test_unsafe_purchase_links_rejected(self, client):
        for bad in ("javascript:alert(1)", "data:text/html,x", "file:///etc/passwd", "ftp://x"):
            assert client.post("/reading/books", json={"title": "X", "purchase_url": bad}).status_code == 422
        b = _book(client, title="Safe")
        assert client.patch(f"/reading/books/{b['id']}", json={"purchase_url": "javascript:x"}).status_code == 422
        # Safe forms accepted: http(s), mailto, www.
        for ok in ("https://a.example", "http://a.example", "mailto:a@example.com", "www.example.com"):
            assert client.patch(f"/reading/books/{b['id']}", json={"purchase_url": ok}).status_code == 200


class TestReadingV2Backup:
    def test_round_trip_priority_and_to_buy(self, client):
        _book(client, title="Owned", priority=4)
        _book(client, title="Wish", to_buy=True, priority=5,
              purchase_url="https://example.com/w", purchase_notes="n")
        exported = client.get("/export/backup.json").text
        files = {"file": ("backup.json", io.BytesIO(exported.encode()), "application/json")}
        assert client.post("/restore/backup.json", files=files).status_code == 200
        books = {b["title"]: b for b in client.get("/reading/books").json()}
        assert books["Owned"]["priority"] == 4 and books["Owned"]["to_buy"] == 0
        assert books["Wish"]["to_buy"] == 1
        assert books["Wish"]["purchase_url"] == "https://example.com/w"
        assert books["Wish"]["purchase_notes"] == "n"

    def test_old_backup_without_fields_restores_defaults(self, client):
        _book(client, title="Legacy")
        payload = json.loads(client.get("/export/backup.json").text)
        payload["schema_version"] = 5
        for bk in payload["reading_books"]:
            for field in ("priority", "to_buy", "purchase_url", "purchase_notes", "purchased_at"):
                bk.pop(field, None)
        payload.pop("task_hiatus_periods", None)
        files = {"file": ("backup.json", io.BytesIO(json.dumps(payload).encode()), "application/json")}
        assert client.post("/restore/backup.json", files=files).status_code == 200
        b = client.get("/reading/books").json()[0]
        assert b["priority"] == 3
        assert b["to_buy"] == 0
        assert b["purchase_url"] == ""
        assert b["purchased_at"] is None
