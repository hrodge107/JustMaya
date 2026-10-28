"""Job lifecycle vocabulary, admission matrix, and transitions.

The lifecycle owner (app/storage/jobs.py) declares every vocabulary once;
these tests pin the declared constants to the schema CHECK, to the stage
nodes the graph runs, and to the admission matrix the API serializes.
"""

import sqlite3

import pytest

from app.pipeline.graph import STAGE_NODES
from app.storage.database import init_db
from app.storage.jobs import (
    ELIGIBLE_RUN,
    EXECUTION_COMPLETE,
    EXECUTION_FAILED,
    EXECUTION_PARTIAL,
    EXECUTION_QUEUED,
    EXECUTION_REVIEW,
    EXECUTION_RUNNING,
    EXECUTION_STATES,
    JOB_STATUSES,
    STAGE_STATUS,
    admission,
    can_run,
    enqueue,
    get_job,
    connect_db,
    mark_stage,
    needs_generate_resume,
    release_from_review,
    resolve_outcome,
)


def _seed(tmp_path, *, execution=EXECUTION_QUEUED, status="queued", stage=None):
    init_db(tmp_path)
    conn = connect_db(tmp_path)
    with conn:
        conn.execute(
            "INSERT INTO documents (document_id, filename, status, created_at) "
            "VALUES ('d', 'a.pdf', 'processing', 'now')"
        )
        conn.execute(
            "INSERT INTO jobs (job_id, document_id, status, stage, error, "
            "created_at, updated_at, execution_state) "
            "VALUES ('j', 'd', ?, ?, NULL, 'now', 'now', ?)",
            (status, stage, execution),
        )
    return conn


def _seed_episode(tmp_path, status):
    conn = sqlite3.connect(tmp_path / "app.db")
    with conn:
        conn.execute(
            "INSERT INTO episodes (episode_id, document_id, curriculum_id, "
            "payload, status, validation, created_at, updated_at) "
            "VALUES ('e', 'd', NULL, '{}', ?, NULL, 'now', 'now')",
            (status,),
        )
    conn.close()


def test_status_check_constraint_matches_declared_vocabulary(tmp_path):
    init_db(tmp_path)
    conn = sqlite3.connect(tmp_path / "app.db")
    sql = conn.execute(
        "SELECT sql FROM sqlite_master WHERE name = 'jobs'"
    ).fetchone()[0]
    conn.close()
    for status in JOB_STATUSES:
        assert f"'{status}'" in sql
    assert len(set(JOB_STATUSES)) == len(JOB_STATUSES)


def test_stage_vocabulary_covers_every_graph_node():
    assert set(STAGE_STATUS) == set(STAGE_NODES)
    assert set(STAGE_STATUS.values()) <= set(JOB_STATUSES)
    assert EXECUTION_STATES == frozenset(
        {
            EXECUTION_QUEUED,
            EXECUTION_RUNNING,
            EXECUTION_REVIEW,
            EXECUTION_PARTIAL,
            EXECUTION_COMPLETE,
            EXECUTION_FAILED,
        }
    )


def test_enqueue_creates_queued_job_in_caller_transaction(tmp_path):
    init_db(tmp_path)
    conn = connect_db(tmp_path)
    with conn:
        conn.execute(
            "INSERT INTO documents (document_id, filename, status, created_at) "
            "VALUES ('d', 'a.pdf', 'uploaded', 'now')"
        )
        job_id = enqueue(conn, "d")
    job = get_job(conn, job_id)
    conn.close()
    assert job["status"] == EXECUTION_QUEUED
    assert job["execution_state"] == EXECUTION_QUEUED
    assert job["stage"] is None


def test_mark_stage_writes_stage_vocabulary(tmp_path):
    conn = _seed(tmp_path)
    conn.close()
    mark_stage(tmp_path, "j", "generate")
    conn = connect_db(tmp_path)
    job = get_job(conn, "j")
    conn.close()
    assert job["status"] == STAGE_STATUS["generate"] == "generating"
    assert job["stage"] == "generate"


@pytest.mark.parametrize(
    "state, status, stage, expected",
    [
        (EXECUTION_QUEUED, "queued", None, True),
        (EXECUTION_FAILED, "failed", "validate", True),
        (EXECUTION_RUNNING, "generating", "generate", False),
        (EXECUTION_COMPLETE, "ready", "validate", False),
        # awaiting_review without a generate-stage draft is not runnable
        (EXECUTION_REVIEW, "planning", "plan", False),
        (EXECUTION_REVIEW, "generating", "generate", False),  # no episode yet
        (EXECUTION_PARTIAL, "indexing", "index", True),
        (EXECUTION_PARTIAL, "analyzing", "analyze", True),
        (EXECUTION_PARTIAL, "planning", "plan", True),
        (EXECUTION_PARTIAL, "generating", "generate", True),
        (EXECUTION_PARTIAL, "validating", "validate", True),
        # partial only resumes where a checkpoint can honor it
        (EXECUTION_PARTIAL, "extracting", "extract", False),
        (EXECUTION_PARTIAL, "queued", None, False),
        (EXECUTION_PARTIAL, "failed", "generate", False),
    ],
)
def test_admission_matrix(tmp_path, state, status, stage, expected):
    conn = _seed(tmp_path, execution=state, status=status, stage=stage)
    job = get_job(conn, "j")
    conn.close()
    claimable = admission(tmp_path, job, ELIGIBLE_RUN)
    assert (claimable is not None) == expected
    assert can_run(tmp_path, job) == expected


def test_generate_draft_review_resumes_via_review_claim(tmp_path):
    conn = _seed(
        tmp_path, execution=EXECUTION_REVIEW, status="generating", stage="generate"
    )
    _seed_episode(tmp_path, "draft")
    job = get_job(conn, "j")
    conn.close()
    assert needs_generate_resume(tmp_path, job)
    assert admission(tmp_path, job, ELIGIBLE_RUN) == (EXECUTION_REVIEW,)
    assert can_run(tmp_path, job)


def test_generate_draft_with_ready_episode_is_not_runnable(tmp_path):
    conn = _seed(
        tmp_path, execution=EXECUTION_REVIEW, status="generating", stage="generate"
    )
    _seed_episode(tmp_path, "ready")
    job = get_job(conn, "j")
    conn.close()
    assert not needs_generate_resume(tmp_path, job)
    assert not can_run(tmp_path, job)


def test_release_from_review_moves_only_awaiting_review(tmp_path):
    conn = _seed(
        tmp_path, execution=EXECUTION_REVIEW, status="generating", stage="generate"
    )
    assert release_from_review(conn, "j")
    assert get_job(conn, "j")["execution_state"] == EXECUTION_PARTIAL
    # a second release is a no-op, not a silent rewrite
    assert not release_from_review(conn, "j")
    conn.close()


def test_resolve_outcome_parks_at_review_until_episode_is_ready(tmp_path):
    conn = _seed(tmp_path, execution=EXECUTION_RUNNING, status="validating", stage="validate")
    conn.close()
    assert resolve_outcome(tmp_path, "d") == EXECUTION_REVIEW
    _seed_episode(tmp_path, "draft")
    assert resolve_outcome(tmp_path, "d") == EXECUTION_REVIEW
    conn = sqlite3.connect(tmp_path / "app.db")
    with conn:
        conn.execute("UPDATE episodes SET status = 'ready'")
    conn.close()
    assert resolve_outcome(tmp_path, "d") == EXECUTION_COMPLETE
