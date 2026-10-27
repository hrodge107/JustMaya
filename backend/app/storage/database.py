import sqlite3
from pathlib import Path

from app.config import DEFAULT_DATA_DIR

SCHEMA = """
CREATE TABLE IF NOT EXISTS documents (
    document_id TEXT PRIMARY KEY,
    filename TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('uploaded', 'processing', 'ready', 'failed')),
    page_count INTEGER,
    error_code TEXT,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS jobs (
    job_id TEXT PRIMARY KEY,
    document_id TEXT NOT NULL REFERENCES documents(document_id),
    status TEXT NOT NULL CHECK (status IN (
        'queued', 'extracting', 'indexing', 'analyzing', 'planning',
        'generating', 'validating', 'ready', 'failed'
    )),
    stage TEXT,
    error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS roadmaps (
    curriculum_id TEXT PRIMARY KEY,
    document_id TEXT NOT NULL REFERENCES documents(document_id),
    payload TEXT NOT NULL,
    schema_version INTEGER NOT NULL,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS episodes (
    episode_id TEXT PRIMARY KEY,
    document_id TEXT NOT NULL REFERENCES documents(document_id),
    curriculum_id TEXT REFERENCES roadmaps(curriculum_id),
    payload TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('draft', 'ready')),
    validation TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
"""


EXTRA_COLUMNS = {
    "documents": {
        "file_hash": "TEXT",
        "file_size": "INTEGER",
        "storage_path": "TEXT",
    },
    # execution_state vocabulary (queued|running|partial_complete|complete|failed)
    # is enforced in app/pipeline/ — a CHECK can't be added via ALTER TABLE
    "jobs": {
        "execution_state": "TEXT NOT NULL DEFAULT 'queued'",
    },
}


def init_db(data_dir: Path | None = None) -> Path:
    data_dir = data_dir or DEFAULT_DATA_DIR
    data_dir.mkdir(parents=True, exist_ok=True)
    db_path = data_dir / "app.db"
    conn = sqlite3.connect(db_path)
    try:
        conn.execute("PRAGMA foreign_keys = ON")
        conn.execute("PRAGMA journal_mode = WAL")
        conn.executescript(SCHEMA)
        for table, columns in EXTRA_COLUMNS.items():
            existing = {row[1] for row in conn.execute(f"PRAGMA table_info({table})")}
            for name, col_type in columns.items():
                if name not in existing:
                    conn.execute(f"ALTER TABLE {table} ADD COLUMN {name} {col_type}")
        conn.commit()
    finally:
        conn.close()
    return db_path
