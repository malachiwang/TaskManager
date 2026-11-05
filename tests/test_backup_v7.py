"""tm-clean 04: full-workspace backup v7 and the CSV import Active-from fix.

Backup tests are adapted from the drifted branch's tests/test_simplify.py
(workspace search parts omitted — that is change 11). All writes go to
conftest's disposable database.
"""
import csv
import io
import json
import sqlite3
from pathlib import Path

import pytest

import backend.database as db
from backend.main import _BACKUP_TABLES, _LEGACY_BACKUP_TABLES
from tests.test_api import create_task


def seed_history(client):
    task = create_task(client, name='Original historical task', subtask='Subtask needle')
    tid = task['id']
    client.post('/completions', params={'task_id': tid, 'completion_date': '2025-01-12'})
    client.post('/completions', params={'task_id': tid, 'completion_date': '2025-01-12'})
    client.put(f'/notes/{tid}/2025-01-12', params={'note': 'January note needle'})
    client.put(f'/date-cell-overrides/{tid}/2025-02-04', params={'text': 'February text needle'})
    archive = client.post('/archives', params={'name': 'January loadout', 'start_date': '2025-01-01', 'end_date': '2025-01-31'}).json()
    client.patch(f'/tasks/{tid}', json={'name': 'Current task', 'end_date': '2025-03-31'})
    book = client.post('/reading/books', json={'title': 'Historical reading', 'author': 'Writer', 'notes': 'Book needle', 'status': 'archived'}).json()
    client.post(f"/reading/books/{book['id']}/entries", json={'page': 42, 'entry_date': '2025-01-12', 'note': 'Checkpoint needle'})
    return tid, archive['id'], book['id']


def test_backup_lists_23_tables_matching_the_schema(client):
    assert len(_BACKUP_TABLES) == 23
    with db.get_connection() as conn:
        actual = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")}
    assert set(_BACKUP_TABLES) == actual


def test_snapshot_remains_accessible_after_task_deletion(client):
    tid, sid, _ = seed_history(client)
    client.delete(f'/tasks/{tid}')
    snap = client.get(f'/archives/{sid}').json()['snapshot_data_json']
    assert snap['tasks'][0]['name'] == 'Original historical task'
    assert snap['tasks'][0]['completions']['2025-01-12'] == 2
    assert snap['tasks'][0]['cell_notes']['2025-01-12'] == 'January note needle'


def test_full_backup_round_trip_all_tables_and_safety_copy(client):
    tid, _, _ = seed_history(client)
    ctx = client.post('/contexts', json={'name': 'History course'}).json()
    client.patch(f'/tasks/{tid}', json={'context_id': ctx['id'], 'depth': 2, 'estimated_minutes': 45})
    session = client.post('/sessions', json={'task_id': tid, 'planned_start': '2025-01-12T10:00', 'planned_end': '2025-01-12T11:00'})
    assert session.status_code == 201, session.text
    assert client.post('/sessions', json={'title': 'Reading appointment', 'context_id': ctx['id'], 'planned_start': '2025-02-12T10:00', 'planned_end': '2025-02-12T11:00'}).status_code == 201
    with db.get_connection() as conn:
        def insert(table, **values):
            columns = ', '.join(values)
            slots = ', '.join('?' for _ in values)
            return conn.execute(f'INSERT INTO {table} ({columns}) VALUES ({slots})', list(values.values())).lastrowid
        stamps = {'created_at': '2025-01-01T10:00', 'updated_at': '2025-01-01T10:00'}
        cal = insert('external_calendars', name='Fixture calendar', url='https://example.invalid/test.ics', **stamps)
        insert('external_events', calendar_id=cal, uid='fixture-event', title='Retained event', start='2025-01-01T09:00', end='2025-01-01T10:00')
        insert('context_event_links', calendar_id=cal, context_id=ctx['id'], uid='fixture-event', created_at=stamps['created_at'])
        insert('task_event_links', calendar_id=cal, task_id=tid, uid='fixture-event', **stamps)
        window = insert('depth_windows', depth=2, weekday=1, start_minutes=540, end_minutes=600, **stamps)
        insert('depth_window_skips', window_id=window, date='2025-01-07', created_at=stamps['created_at'])
        insert('depth_window_templates', name='Fixture template', items='[]', **stamps)
        batch = insert('academic_batches', context_id=ctx['id'], source_name='Fixture syllabus', created_at=stamps['created_at'])
        insert('academic_candidates', batch_id=batch, context_id=ctx['id'], kind='task', title='Retained candidate', **stamps)
        series = insert('recurrence_series', task_id=tid, start_date='2025-01-01', start_minutes=600, duration_minutes=60, weekdays='[2]', **stamps)
        insert('recurrence_skips', series_id=series, date='2025-01-08', created_at=stamps['created_at'])
        conn.execute('UPDATE task_sessions SET series_id=?, occurrence_date=? WHERE id=?', (series, '2025-01-12', session.json()['id']))
        insert('task_hiatus_periods', task_id=tid, start_date='2025-02-10', end_date='2025-02-12', **stamps)
        conn.execute("UPDATE section_order SET position=17")
        conn.commit()
    client.get('/dashboard')  # captures the daily-pressure history
    original = client.get('/export/backup.json').json()
    assert original['schema_version'] == 7
    assert all(original[table] for table in _BACKUP_TABLES), [t for t in _BACKUP_TABLES if not original[t]]
    create_task(client, name='Only in safety copy')
    response = client.post('/restore/backup.json', files={'file': ('backup.json', json.dumps(original), 'application/json')})
    assert response.status_code == 200, response.text
    safety = Path(response.json()['safety_backup'])
    assert safety.exists() and safety.parent.parent == db.DB_PATH.parent
    with sqlite3.connect(safety) as conn:
        assert conn.execute("SELECT count(*) FROM tasks WHERE name='Only in safety copy'").fetchone()[0] == 1
    restored = client.get('/export/backup.json').json()
    for table in _BACKUP_TABLES:
        assert restored[table] == original[table], table
    with db.get_connection() as conn:
        assert conn.execute('PRAGMA integrity_check').fetchone()[0] == 'ok'
        assert not conn.execute('PRAGMA foreign_key_check').fetchall()


@pytest.mark.parametrize('version', range(1, 7))
def test_legacy_backups_restore_history(client, version):
    _, sid, _ = seed_history(client)
    payload = client.get('/export/backup.json').json()
    payload = {k: v for k, v in payload.items() if k in _LEGACY_BACKUP_TABLES}
    payload['schema_version'] = version
    client.post('/contexts', json={'name': 'Will be replaced'})
    response = client.post('/restore/backup.json', files={'file': ('legacy.json', json.dumps(payload), 'application/json')})
    assert response.status_code == 200, response.text
    assert client.get(f'/archives/{sid}').json()['snapshot_data_json']['tasks'][0]['completions']['2025-01-12'] == 2
    assert client.get('/reading/books').json()[0]['current_page'] == 42
    assert client.get('/contexts').json() == []


def test_failed_restore_is_atomic(client):
    seed_history(client)
    before = client.get('/export/backup.json').json()
    invalid = json.loads(json.dumps(before))
    invalid['completions'][0]['task_id'] = 99999
    response = client.post('/restore/backup.json', files={'file': ('bad.json', json.dumps(invalid), 'application/json')})
    assert response.status_code == 400
    after = client.get('/export/backup.json').json()
    for table in _BACKUP_TABLES:
        assert before[table] == after[table], table


def test_v7_missing_table_rejected(client):
    payload = client.get('/export/backup.json').json()
    del payload['contexts']
    response = client.post('/restore/backup.json', files={'file': ('bad.json', json.dumps(payload), 'application/json')})
    assert response.status_code == 400


def _csv(rows):
    buf = io.StringIO()
    csv.writer(buf).writerows(rows)
    return buf.getvalue().encode('utf-8')


def test_csv_import_blank_active_from_starts_on_first_date_column(client):
    data = _csv([['Task', 'Priority', 'Active from', '2026-06-03', '2026-06-04'],
                 ['Water plants', '3', '', '1', ''],
                 ['Stretch', '3', '2026-05-01', '', '1']])
    resp = client.post('/import/apply', files={'file': ('sheet.csv', data, 'text/csv')})
    assert resp.status_code == 200 and resp.json()['tasks_created'] == 2
    by_name = {t['name']: t for t in client.get('/tasks').json()}
    assert by_name['Water plants']['active_from'] == '2026-06-03'
    assert by_name['Stretch']['active_from'] == '2026-05-01'  # explicit value wins


def test_csv_import_without_dates_or_active_from_leaves_it_empty(client):
    resp = client.post('/import/apply', files={'file': ('import.csv', _csv([['Task', 'Priority'], ['Exercise', '6']]), 'text/csv')})
    assert resp.status_code == 200
    assert client.get('/tasks').json()[0].get('active_from') is None
