"""TM-SIMPLIFY-01: all writes target conftest's disposable SQLite database."""
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


def test_workspace_search_historical_dates_and_reading(client):
    tid, sid, bid = seed_history(client)
    for query, date in [('January note needle', '2025-01-12'), ('February text needle', '2025-02-04'), ('Current task', '2025-03-31')]:
        rows = client.get('/search/workspace', params={'q': query}).json()
        assert any(r['id'] == tid and r['date'] == date and 'snapshotId' not in r for r in rows)
    rows = client.get('/search/workspace', params={'q': 'Original historical'}).json()
    assert rows[0]['snapshotId'] == sid
    assert rows[0]['date'] == '2025-01-01'
    rows = client.get('/search/workspace', params={'q': 'checkpoint NEEDLE'}).json()
    assert rows[0]['kind'] == 'reading' and rows[0]['id'] == bid and rows[0]['entryId']
    assert client.get('/search/workspace', params={'q': 'Book needle'}).json()[0]['id'] == bid
    assert client.get('/search/workspace', params={'q': 'missing phrase'}).json() == []
    assert client.get('/search/workspace', params={'q': '   '}).json() == []


def test_snapshot_remains_accessible_after_task_deletion(client):
    tid, sid, _ = seed_history(client)
    client.delete(f'/tasks/{tid}')
    snap = client.get(f'/archives/{sid}').json()['snapshot_data_json']
    assert snap['tasks'][0]['name'] == 'Original historical task'
    assert snap['tasks'][0]['completions']['2025-01-12'] == 2
    assert snap['tasks'][0]['cell_notes']['2025-01-12'] == 'January note needle'
    assert client.get('/search/workspace', params={'q': 'Original historical'}).json()[0]['snapshotId'] == sid


def test_full_backup_round_trip_all_tables_and_safety_copy(client):
    tid, _, _ = seed_history(client)
    ctx = client.post('/contexts', json={'name': 'History course'}).json()
    client.patch(f'/tasks/{tid}', json={'context_id': ctx['id'], 'depth': 2, 'estimated_minutes': 45})
    session = client.post('/sessions', json={'task_id': tid, 'planned_start': '2025-01-12T10:00', 'planned_end': '2025-01-12T11:00'})
    assert session.status_code == 201, session.text
    # Calendar-only entry has independent persistence too.
    assert client.post('/sessions', json={'title': 'Reading appointment', 'context_id': ctx['id'], 'planned_start': '2025-02-12T10:00', 'planned_end': '2025-02-12T11:00'}).status_code == 201
    # Populate every newer persistence family without network access.
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
    client.get('/dashboard')  # captures the existing daily-pressure history
    original = client.get('/export/backup.json').json()
    assert all(original[table] for table in _BACKUP_TABLES), [table for table in _BACKUP_TABLES if not original[table]]
    with db.get_connection() as conn:
        actual_tables = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")}
    assert set(_BACKUP_TABLES) == actual_tables
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
