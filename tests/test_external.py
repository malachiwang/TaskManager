"""
External calendars (P15.0) — ICS parsing, sync semantics, and templates.

Parser tests are pure (no network). Endpoint tests monkeypatch the fetch so
sync behavior — replace-all no-duplication, failure isolation, cascade — is
exercised without touching the internet.
"""
from datetime import datetime

import pytest

import backend.main as main_module
from backend import ics


def _wrap(body: str) -> str:
    return f"BEGIN:VCALENDAR\r\nVERSION:2.0\r\n{body}END:VCALENDAR\r\n"


SIMPLE = _wrap(
    "BEGIN:VEVENT\r\n"
    "UID:one@test\r\n"
    "SUMMARY:Office hours\r\n"
    "DTSTART:20260825T140000\r\n"
    "DTEND:20260825T150000\r\n"
    "END:VEVENT\r\n"
)

WEEKLY = _wrap(
    "BEGIN:VEVENT\r\n"
    "UID:lecture@test\r\n"
    "SUMMARY:ISYE Lecture\r\n"
    "DTSTART:20260825T110000\r\n"
    "DTEND:20260825T121500\r\n"
    "RRULE:FREQ=WEEKLY;BYDAY=TU,TH;COUNT=6\r\n"
    "EXDATE:20260827T110000\r\n"
    "END:VEVENT\r\n"
)

ALL_DAY = _wrap(
    "BEGIN:VEVENT\r\n"
    "UID:allday@test\r\n"
    "SUMMARY:Career fair\r\n"
    "DTSTART;VALUE=DATE:20260826\r\n"
    "END:VEVENT\r\n"
)

FOLDED = _wrap(
    "BEGIN:VEVENT\r\n"
    "UID:folded@test\r\n"
    "SUMMARY:A very long meeting name that got fol\r\n ded across two lines\r\n"
    "DTSTART:20260825T090000\r\n"
    "DTEND:20260825T093000\r\n"
    "END:VEVENT\r\n"
)

OVERRIDE = _wrap(
    "BEGIN:VEVENT\r\n"
    "UID:series@test\r\n"
    "SUMMARY:Standup\r\n"
    "DTSTART:20260824T100000\r\n"
    "DTEND:20260824T101500\r\n"
    "RRULE:FREQ=DAILY;COUNT=3\r\n"
    "END:VEVENT\r\n"
    "BEGIN:VEVENT\r\n"
    "UID:series@test\r\n"
    "SUMMARY:Standup (moved)\r\n"
    "RECURRENCE-ID:20260825T100000\r\n"
    "DTSTART:20260825T160000\r\n"
    "DTEND:20260825T161500\r\n"
    "END:VEVENT\r\n"
)

WIN_START = datetime(2026, 8, 1)
WIN_END = datetime(2026, 10, 1)


class TestIcsParser:
    def test_simple_event(self):
        occ = ics.expand_events(ics.parse_ics(SIMPLE), WIN_START, WIN_END)
        assert occ == [{"uid": "one@test", "title": "Office hours",
                        "start": "2026-08-25T14:00", "end": "2026-08-25T15:00",
                        "all_day": False}]

    def test_weekly_rrule_with_exdate(self):
        occ = ics.expand_events(ics.parse_ics(WEEKLY), WIN_START, WIN_END)
        starts = [o["start"] for o in occ]
        # TU/TH from Tue 8/25, COUNT=6, minus the 8/27 EXDATE
        assert "2026-08-25T11:00" in starts
        assert "2026-08-27T11:00" not in starts
        assert "2026-09-01T11:00" in starts
        assert len(starts) == 5
        assert all(o["end"].endswith("12:15") for o in occ)

    def test_all_day(self):
        occ = ics.expand_events(ics.parse_ics(ALL_DAY), WIN_START, WIN_END)
        assert occ[0]["all_day"] is True
        assert occ[0]["start"] == "2026-08-26T00:00"
        assert occ[0]["end"] == "2026-08-27T00:00"

    def test_line_unfolding(self):
        events = ics.parse_ics(FOLDED)
        assert events[0]["summary"].endswith("folded across two lines")

    def test_recurrence_override_replaces_occurrence(self):
        occ = ics.expand_events(ics.parse_ics(OVERRIDE), WIN_START, WIN_END)
        starts = {o["start"]: o["title"] for o in occ}
        assert len(occ) == 3
        assert "2026-08-25T10:00" not in starts          # moved away
        assert starts.get("2026-08-25T16:00") == "Standup (moved)"

    def test_utc_conversion_is_local(self):
        text = _wrap(
            "BEGIN:VEVENT\r\nUID:u@t\r\nSUMMARY:UTC event\r\n"
            "DTSTART:20260825T170000Z\r\nDTEND:20260825T180000Z\r\nEND:VEVENT\r\n")
        occ = ics.expand_events(ics.parse_ics(text), WIN_START, WIN_END)
        assert len(occ) == 1
        start = datetime.strptime(occ[0]["start"], "%Y-%m-%dT%H:%M")
        end = datetime.strptime(occ[0]["end"], "%Y-%m-%dT%H:%M")
        assert (end - start).total_seconds() == 3600  # duration survives conversion

    def test_cancelled_events_dropped(self):
        text = _wrap(
            "BEGIN:VEVENT\r\nUID:c@t\r\nSUMMARY:Gone\r\nSTATUS:CANCELLED\r\n"
            "DTSTART:20260825T090000\r\nDTEND:20260825T100000\r\nEND:VEVENT\r\n")
        assert ics.expand_events(ics.parse_ics(text), WIN_START, WIN_END) == []

    def test_garbage_is_safe(self):
        assert ics.parse_ics("not an ics file at all") == []
        assert ics.parse_ics("") == []


class TestExternalCalendarEndpoints:
    def _add(self, client, monkeypatch, text=SIMPLE, name="GT Classes"):
        monkeypatch.setattr(main_module, "_fetch_ics_text", lambda url: text)
        res = client.post("/external-calendars", json={"name": name, "url": "https://x.test/cal.ics"})
        assert res.status_code == 201, res.text
        return res.json()

    def test_create_syncs_events(self, client, monkeypatch):
        cal = self._add(client, monkeypatch)
        assert cal["event_count"] == 1
        assert cal["last_error"] is None
        events = client.get("/external-events", params={"start": "2026-08-25", "end": "2026-08-25"}).json()
        assert events[0]["title"] == "Office hours"
        assert events[0]["calendar_name"] == "GT Classes"

    def test_resync_never_duplicates(self, client, monkeypatch):
        cal = self._add(client, monkeypatch, text=WEEKLY)
        first = client.get("/external-events", params={"start": "2026-08-01", "end": "2026-10-01"}).json()
        client.post(f"/external-calendars/{cal['id']}/sync")
        client.post(f"/external-calendars/{cal['id']}/sync")
        again = client.get("/external-events", params={"start": "2026-08-01", "end": "2026-10-01"}).json()
        assert len(again) == len(first) == 5

    def test_changed_feed_updates_events(self, client, monkeypatch):
        cal = self._add(client, monkeypatch)
        moved = SIMPLE.replace("T140000", "T160000").replace("T150000", "T170000")
        monkeypatch.setattr(main_module, "_fetch_ics_text", lambda url: moved)
        client.post(f"/external-calendars/{cal['id']}/sync")
        events = client.get("/external-events", params={"start": "2026-08-25", "end": "2026-08-25"}).json()
        assert len(events) == 1
        assert events[0]["start"] == "2026-08-25T16:00"

    def test_failed_sync_keeps_old_events_and_records_error(self, client, monkeypatch):
        cal = self._add(client, monkeypatch)

        def boom(url):
            raise OSError("network down")
        monkeypatch.setattr(main_module, "_fetch_ics_text", boom)
        res = client.post(f"/external-calendars/{cal['id']}/sync")
        assert res.status_code == 502
        # previous events survive; error is recorded on the calendar
        events = client.get("/external-events", params={"start": "2026-08-25", "end": "2026-08-25"}).json()
        assert len(events) == 1
        cals = client.get("/external-calendars").json()
        assert "network down" in cals[0]["last_error"]

    def test_failure_isolated_from_core_surfaces(self, client, monkeypatch):
        def boom(url):
            raise OSError("nope")
        monkeypatch.setattr(main_module, "_fetch_ics_text", boom)
        res = client.post("/external-calendars", json={"name": "Broken", "url": "https://x.test/b.ics"})
        assert res.status_code == 201          # calendar exists, error recorded
        assert res.json()["last_error"]
        # Core surfaces unaffected:
        assert client.get("/tasks").status_code == 200
        assert client.get("/sessions", params={"start": "2026-08-25", "end": "2026-08-25"}).status_code == 200
        assert client.get("/external-events", params={"start": "2026-08-25", "end": "2026-08-25"}).json() == []

    def test_hidden_calendar_events_filtered(self, client, monkeypatch):
        cal = self._add(client, monkeypatch)
        client.patch(f"/external-calendars/{cal['id']}", json={"visible": False})
        assert client.get("/external-events", params={"start": "2026-08-25", "end": "2026-08-25"}).json() == []
        client.patch(f"/external-calendars/{cal['id']}", json={"visible": True})
        assert len(client.get("/external-events", params={"start": "2026-08-25", "end": "2026-08-25"}).json()) == 1

    def test_delete_cascades_events(self, client, monkeypatch):
        cal = self._add(client, monkeypatch)
        client.delete(f"/external-calendars/{cal['id']}")
        assert client.get("/external-calendars").json() == []
        assert client.get("/external-events", params={"start": "2026-08-25", "end": "2026-08-25"}).json() == []

    def test_rejects_non_http_url(self, client, monkeypatch):
        monkeypatch.setattr(main_module, "_fetch_ics_text",
                            main_module._fetch_ics_text)  # real guard
        res = client.post("/external-calendars", json={"name": "X", "url": "file:///etc/passwd"})
        assert res.status_code == 201
        assert "http" in res.json()["last_error"]


class TestDepthWindowTemplates:
    ITEMS = [
        {"depth": 1, "start_minutes": 540, "end_minutes": 720, "protected": True},
        {"depth": 2, "start_minutes": 840, "end_minutes": 960, "protected": False},
        {"depth": 3, "start_minutes": 960, "end_minutes": 1020, "protected": False},
    ]

    def test_crud_roundtrip(self, client):
        res = client.post("/depth-window-templates", json={"name": "Standard Weekday", "items": self.ITEMS})
        assert res.status_code == 201
        tpl = res.json()
        assert len(tpl["items"]) == 3
        assert tpl["items"][0]["protected"] is True
        res = client.patch(f"/depth-window-templates/{tpl['id']}", json={"name": "Weekday"})
        assert res.json()["name"] == "Weekday"
        assert [t["name"] for t in client.get("/depth-window-templates").json()] == ["Weekday"]
        assert client.delete(f"/depth-window-templates/{tpl['id']}").status_code == 200
        assert client.get("/depth-window-templates").json() == []

    def test_items_validated(self, client):
        bad = [{"depth": 4, "start_minutes": 0, "end_minutes": 60}]
        assert client.post("/depth-window-templates", json={"name": "X", "items": bad}).status_code == 422
        bad2 = [{"depth": 1, "start_minutes": 120, "end_minutes": 60}]
        assert client.post("/depth-window-templates", json={"name": "X", "items": bad2}).status_code == 422

    def test_blank_name_rejected(self, client):
        assert client.post("/depth-window-templates", json={"name": " ", "items": []}).status_code == 422
