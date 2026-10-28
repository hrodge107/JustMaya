import sqlite3
from pathlib import Path

from app.config import DEFAULT_DATA_DIR
from app.models.session import SESSION_MODES, SESSION_STATUSES
from app.storage.jobs import JOB_STATUSES

_JOB_STATUS_CHECK = ", ".join(f"'{status}'" for status in JOB_STATUSES)
_SESSION_MODE_CHECK = ", ".join(f"'{mode}'" for mode in SESSION_MODES)
_SESSION_STATUS_CHECK = ", ".join(f"'{status}'" for status in SESSION_STATUSES)

SCHEMA = f"""
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
    status TEXT NOT NULL CHECK (status IN ({_JOB_STATUS_CHECK})),
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

CREATE TABLE IF NOT EXISTS token_usage (
    usage_id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id TEXT NOT NULL,
    stage TEXT NOT NULL,
    prompt_tokens INTEGER NOT NULL,
    completion_tokens INTEGER NOT NULL,
    cached_tokens INTEGER NOT NULL DEFAULT 0,
    total_tokens INTEGER NOT NULL,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS learner_sessions (
    session_id TEXT PRIMARY KEY,
    episode_id TEXT NOT NULL REFERENCES episodes(episode_id),
    mode TEXT NOT NULL CHECK (mode IN ({_SESSION_MODE_CHECK})),
    status TEXT NOT NULL CHECK (status IN ({_SESSION_STATUS_CHECK})),
    version INTEGER NOT NULL,
    payload TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS session_requests (
    session_id TEXT NOT NULL REFERENCES learner_sessions(session_id),
    request_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (session_id, request_id)
);
"""


EXTRA_COLUMNS = {
    "documents": {
        "file_hash": "TEXT",
        "file_size": "INTEGER",
        "storage_path": "TEXT",
    },
    # execution_state vocabulary (queued|running|awaiting_review|
    # partial_complete|complete|failed) is enforced in app/storage/jobs.py —
    # a CHECK can't be added via ALTER TABLE
    "jobs": {
        "execution_state": "TEXT NOT NULL DEFAULT 'queued'",
    },
    "roadmaps": {
        "inventory_payload": "TEXT",
        "job_id": "TEXT",
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
