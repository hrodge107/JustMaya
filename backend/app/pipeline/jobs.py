"""Job queue operations on the jobs table.

`jobs` IS the queue: claim is a single atomic UPDATE so concurrent claimers
(worker, run endpoint, recovery) can never execute the same job twice.
execution_state (queued|running|partial_complete|complete|failed) tracks the
run lifecycle; jobs.status keeps the stage vocabulary.
"""

import sqlite3
from datetime import datetime, timezone
from pathlib import Path

EXECUTION_QUEUED = "queued"
EXECUTION_RUNNING = "running"
EXECUTION_PARTIAL = "partial_complete"
EXECUTION_COMPLETE = "complete"
EXECUTION_FAILED = "failed"
EXECUTION_STATES = frozenset(
    {
        EXECUTION_QUEUED,
        EXECUTION_RUNNING,
        EXECUTION_PARTIAL,
        EXECUTION_COMPLETE,
        EXECUTION_FAILED,
    }
)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def connect_db(data_dir: Path) -> sqlite3.Connection:
    conn = sqlite3.connect(data_dir / "app.db", timeout=10)
    conn.row_factory = sqlite3.Row
    return conn


def get_job(conn: sqlite3.Connection, job_id: str) -> dict | None:
    row = conn.execute(
        "SELECT job_id, document_id, status, stage, error, execution_state "
        "FROM jobs WHERE job_id = ?",
        (job_id,),
    ).fetchone()
    return dict(row) if row else None


def claim_job(
    conn: sqlite3.Connection, job_id: str, eligible: tuple[str, ...]
) -> bool:
    placeholders = ",".join("?" for _ in eligible)
    cur = conn.execute(
        f"UPDATE jobs SET execution_state = ?, updated_at = ? "
        f"WHERE job_id = ? AND execution_state IN ({placeholders})",
        (EXECUTION_RUNNING, _now(), job_id, *eligible),
    )
    conn.commit()
    return cur.rowcount == 1


def next_queued_job(conn: sqlite3.Connection) -> str | None:
    row = conn.execute(
        "SELECT job_id FROM jobs WHERE execution_state = ? "
        "ORDER BY created_at LIMIT 1",
        (EXECUTION_QUEUED,),
    ).fetchone()
    return row["job_id"] if row else None


def recover_abandoned(conn: sqlite3.Connection) -> list[str]:
    """Jobs left 'running' by a dead worker — resume from their checkpoint."""
    rows = conn.execute(
        "SELECT job_id FROM jobs WHERE execution_state = ? ORDER BY created_at",
        (EXECUTION_RUNNING,),
    ).fetchall()
    return [row["job_id"] for row in rows]


def job_pipeline_target(
    conn: sqlite3.Connection, job_id: str
) -> tuple[str, str] | None:
    row = conn.execute(
        "SELECT j.document_id, d.storage_path FROM jobs j "
        "JOIN documents d ON d.document_id = j.document_id WHERE j.job_id = ?",
        (job_id,),
    ).fetchone()
    return (row["document_id"], row["storage_path"]) if row else None


def set_document_status(
    conn: sqlite3.Connection, document_id: str, status: str
) -> None:
    with conn:
        conn.execute(
            "UPDATE documents SET status = ? WHERE document_id = ?",
            (status, document_id),
        )


def finish_job(
    conn: sqlite3.Connection, job_id: str, execution_state: str
) -> None:
    with conn:
        conn.execute(
            "UPDATE jobs SET execution_state = ?, updated_at = ? WHERE job_id = ?",
            (execution_state, _now(), job_id),
        )


def fail_job(conn: sqlite3.Connection, job_id: str, error: str) -> None:
    with conn:
        conn.execute(
            "UPDATE jobs SET status = 'failed', execution_state = ?, "
            "error = ?, updated_at = ? WHERE job_id = ?",
            (EXECUTION_FAILED, error[:1000], _now(), job_id),
        )
