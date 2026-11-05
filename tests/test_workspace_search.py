"""tm-clean 11: GET /search/workspace. Adapted from drift-ref's
tests/test_simplify.py; snapshot results are no longer returned."""
from tests.test_api import create_task


def seed(client):
    task = create_task(client, name='Original historical task', subtask='Subtask needle')
    tid = task['id']
    client.post('/completions', params={'task_id': tid, 'completion_date': '2025-01-12'})
    client.put(f'/notes/{tid}/2025-01-12', params={'note': 'January note needle'})
    client.put(f'/date-cell-overrides/{tid}/2025-02-04', params={'text': 'February text needle'})
    client.post('/archives', params={'name': 'January loadout', 'start_date': '2025-01-01', 'end_date': '2025-01-31'})
    client.patch(f'/tasks/{tid}', json={'name': 'Current task', 'end_date': '2025-03-31'})
    book = client.post('/reading/books', json={'title': 'Historical reading', 'author': 'Writer', 'notes': 'Book needle', 'status': 'archived'}).json()
    client.post(f"/reading/books/{book['id']}/entries", json={'page': 42, 'entry_date': '2025-01-12', 'note': 'Checkpoint needle'})
    return tid, book['id']


def test_dated_matches_reveal_their_own_month(client):
    tid, _ = seed(client)
    for query, when in [('January note needle', '2025-01-12'), ('February text needle', '2025-02-04'), ('Current task', '2025-03-31')]:
        rows = client.get('/search/workspace', params={'q': query}).json()
        assert any(r['kind'] == 'task' and r['id'] == tid and r['date'] == when for r in rows), (query, rows)


def test_reading_matches_and_case_folding(client):
    _, bid = seed(client)
    rows = client.get('/search/workspace', params={'q': 'checkpoint NEEDLE'}).json()
    assert rows[0]['kind'] == 'reading' and rows[0]['id'] == bid and rows[0]['entryId']
    assert client.get('/search/workspace', params={'q': 'Book needle'}).json()[0]['id'] == bid


def test_snapshot_only_names_are_not_returned(client):
    seed(client)
    # 'Original historical task' now exists only inside the archive snapshot.
    assert client.get('/search/workspace', params={'q': 'Original historical'}).json() == []


def test_blank_and_missing_queries(client):
    seed(client)
    assert client.get('/search/workspace', params={'q': 'missing phrase'}).json() == []
    assert client.get('/search/workspace', params={'q': '   '}).json() == []


def test_deleted_tasks_are_not_returned(client):
    tid, _ = seed(client)
    client.delete(f'/tasks/{tid}')
    assert client.get('/search/workspace', params={'q': 'Current task'}).json() == []
