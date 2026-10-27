import sqlite3

from app.storage.database import init_db
from app.storage.documents import init_storage

EXPECTED_TABLES = {"documents", "jobs", "roadmaps", "episodes"}


def table_names(db_path):
    conn = sqlite3.connect(db_path)
    try:
        rows = conn.execute("SELECT name FROM sqlite_master WHERE type = 'table'").fetchall()
    finally:
        conn.close()
    return {r[0] for r in rows}


def test_init_db_creates_schema(tmp_path):
    db_path = init_db(tmp_path)
    assert db_path.exists()
    assert EXPECTED_TABLES <= table_names(db_path)


def test_init_db_is_idempotent(tmp_path):
    db_path = init_db(tmp_path)
    conn = sqlite3.connect(db_path)
    conn.execute(
        "INSERT INTO documents (document_id, filename, status, created_at) "
        "VALUES ('doc-1', 'a.pdf', 'uploaded', '2026-01-01T00:00:00Z')"
    )
    conn.commit()
    conn.close()

    init_db(tmp_path)

    conn = sqlite3.connect(db_path)
    rows = conn.execute("SELECT document_id FROM documents").fetchall()
    conn.close()
    assert rows == [("doc-1",)]


def test_status_constraints(tmp_path):
    db_path = init_db(tmp_path)
    conn = sqlite3.connect(db_path)
    try:
        conn.execute(
            "INSERT INTO documents (document_id, filename, status, created_at) "
            "VALUES ('d', 'x.pdf', 'bogus', 't')"
        )
        conn.commit()
        assert False, "expected CHECK constraint failure"
    except sqlite3.IntegrityError:
        pass
    finally:
        conn.close()


def test_init_storage_private(tmp_path):
    storage_dir = init_storage(tmp_path)
    assert storage_dir.is_dir()
    probe = storage_dir / "probe.txt"
    probe.write_text("x")
    assert probe.read_text() == "x"
    assert "public" not in [p.lower() for p in storage_dir.parts]
