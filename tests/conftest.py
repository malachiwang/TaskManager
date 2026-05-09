"""
Pytest fixtures for API integration tests.

Each test that uses the `client` fixture gets:
- A fresh temp-file SQLite database (never the real taskos.db)
- DB_PATH patched before the app starts
- A clean TestClient wired to the patched app
- Automatic teardown when the test ends

No real data, no .env, no shared state between tests.
"""
import pytest
import backend.database as db_module
from starlette.testclient import TestClient

from backend.main import app


@pytest.fixture
def client(tmp_path, monkeypatch):
    test_db = tmp_path / "test_taskos.db"
    monkeypatch.setattr(db_module, "DB_PATH", test_db)
    with TestClient(app) as c:
        yield c
