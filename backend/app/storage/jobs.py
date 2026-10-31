"""Job lifecycle — the owner of the jobs table.

`jobs` IS the queue: claim is a single atomic UPDATE so concurrent claimers
(worker, run endpoint, recovery) can never execute the same job twice.
This module is the ONLY writer to the jobs table — enqueue, stage marks,
claims, review release, and terminal transitions all live here so the
vocabulary is declared once:

- jobs.status: queued | <stage status> | ready | failed  (CHECK-enforced,
  derived from STAGE_STATUS + terminal statuses via JOB_STATUSES)
- jobs.stage: the node name currently/last running (extract..validate)
- jobs.execution_state: queued | running | awaiting_review |
  partial_complete | complete | failed  (app-enforced — SQLite cannot
  ALTER a CHECK in, so admission() and claim_job() enforce it)

Conn-first functions: callers that already hold a transaction (upload,
curriculum confirm, the runner) compose these inside it; self-contained
helpers (mark_stage) open their own connection.
"""

import sqlite3
import uuid
from datetime import datetime, timezone
from pathlib import Path

from app.storage.episodes import read_episode_state

EXECUTION_QUEUED = "queued"
EXECUTION_RUNNING = "running"
EXECUTION_REVIEW = "awaiting_review"
EXECUTION_PARTIAL = "partial_complete"
EXECUTION_COMPLETE = "complete"
EXECUTION_FAILED = "failed"
EXECUTION_STATES = frozenset(
    {
        EXECUTION_QUEUED,
        EXECUTION_RUNNING,
        EXECUTION_REVIEW,
        EXECUTION_PARTIAL,
        EXECUTION_COMPLETE,
        EXECUTION_FAILED,
    }
)

# node name -> jobs.status while that stage runs. The single declaration of
# the stage vocabulary; jobs.status CHECK is generated from JOB_STATUSES.
STAGE_STATUS = {
    "extract": "extracting",
    "index": "indexing",
    "analyze": "analyzing",
    "plan": "planning",
    "detail": "detailing",
    "generate": "generating",
    "validate": "validating",
}
JOB_STATUSES = ("queued", *STAGE_STATUS.values(), "ready", "failed")

# (status, stage) pairs a partial_complete job may resume into via an
# as_node update — the runner-side admission gate.
_PARTIAL_ADMIT = (
    ("indexing", "index"),
    ("analyzing", "analyze"),
    ("planning", "plan"),
    ("detailing", "detail"),
    ("generating", "generate"),
    ("validating", "validate"),
)

# Claim intents: which execution_states each caller kind may pick up.
ELIGIBLE_RUN = (EXECUTION_QUEUED, EXECUTION_FAILED, EXECUTION_PARTIAL)
ELIGIBLE_WORKER = (EXECUTION_QUEUED,)
ELIGIBLE_RECOVERY = (EXECUTION_RUNNING,)


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


def enqueue(conn: sqlite3.Connection, document_id: str) -> str:
    """Create a queued job for a document inside the caller's transaction."""
    job_id = uuid.uuid4().hex
    now = _now()
    conn.execute(
        "INSERT INTO jobs (job_id, document_id, status, created_at, updated_at) "
        "VALUES (?, ?, 'queued', ?, ?)",
        (job_id, document_id, now, now),
    )
    return job_id


def claim_job(
    conn: sqlite3.Connection, job_id: str, eligible: tuple[str, ...]
) -> bool:
    placeholders = ",".join("?" for _ in eligible)
    cur = conn.execute(
        f"UPDATE jobs SET execution_state = ?, updated_at = ?, error = NULL "
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


def mark_stage(data_dir: Path, job_id: str, stage: str) -> None:
    """Record the running stage (status + stage columns) for a job."""
    conn = connect_db(data_dir)
    try:
        with conn:
            conn.execute(
                "UPDATE jobs SET status = ?, stage = ?, updated_at = ? WHERE job_id = ?",
                (STAGE_STATUS[stage], stage, _now(), job_id),
            )
    finally:
        conn.close()


def release_from_review(conn: sqlite3.Connection, job_id: str) -> bool:
    """awaiting_review -> partial_complete once the roadmap is confirmed.

    Runs inside the caller's transaction (curriculum confirm) so the
    roadmap lock and the job release commit atomically."""
    cur = conn.execute(
        "UPDATE jobs SET execution_state = ?, updated_at = ? "
        "WHERE job_id = ? AND execution_state = ?",
        (EXECUTION_PARTIAL, _now(), job_id, EXECUTION_REVIEW),
    )
    return cur.rowcount == 1


def needs_generate_resume(data_dir: Path, job: dict) -> bool:
    """Pre-change drafts parked at awaiting_review after generation resume
    into the validate stage once their roadmap is confirmed."""
    if (
        job["execution_state"] != EXECUTION_REVIEW
        or job["stage"] != "generate"
    ):
        return False
    episode = read_episode_state(data_dir, job["document_id"])
    return episode is not None and episode["status"] != "ready"


def admission(
    data_dir: Path, job: dict | None, eligible: tuple[str, ...]
) -> tuple[str, ...] | None:
    """The claimable execution_states for this job, or None if inadmissible.

    A partial_complete job only resumes at stages the checkpoint can honor;
    an awaiting_review generate-draft claims through EXECUTION_REVIEW."""
    if job is None:
        return None
    if needs_generate_resume(data_dir, job):
        return (EXECUTION_REVIEW,)
    state = job["execution_state"]
    if state not in eligible:
        return None
    if (
        state == EXECUTION_PARTIAL
        and (job["status"], job["stage"]) not in _PARTIAL_ADMIT
    ):
        return None
    return eligible


def can_run(data_dir: Path, job: dict | None) -> bool:
    """Serialized eligibility: would POST /jobs/{id}/run accept this job?"""
    return job is not None and admission(data_dir, job, ELIGIBLE_RUN) is not None


def resolve_outcome(data_dir: Path, document_id: str) -> str:
    """Terminal execution_state after a graph run: complete when the
    pipeline produced a ready episode, otherwise parked at review."""
    episode = read_episode_state(data_dir, document_id)
    if episode is not None and episode["status"] == "ready":
        return EXECUTION_COMPLETE
    return EXECUTION_REVIEW


def finish_job(
    conn: sqlite3.Connection, job_id: str, execution_state: str
) -> None:
    with conn:
        conn.execute(
            "UPDATE jobs SET execution_state = ?, updated_at = ? WHERE job_id = ?",
            (execution_state, _now(), job_id),
        )


def complete_job(conn: sqlite3.Connection, job_id: str) -> None:
    """Terminal publication state: pipeline produced a ready episode."""
    with conn:
        conn.execute(
            "UPDATE jobs SET status = 'ready', execution_state = ?, "
            "updated_at = ? WHERE job_id = ?",
            (EXECUTION_COMPLETE, _now(), job_id),
        )


def fail_job(conn: sqlite3.Connection, job_id: str, error: str) -> None:
    with conn:
        conn.execute(
            "UPDATE jobs SET status = 'failed', execution_state = ?, "
            "error = ?, updated_at = ? WHERE job_id = ?",
            (EXECUTION_FAILED, error[:1000], _now(), job_id),
        )
