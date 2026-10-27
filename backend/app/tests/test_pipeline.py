import os
import sqlite3
import threading
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app
from app.models.document import ExtractedDocument
from app.pipeline import nodes as pipeline_nodes
from app.pipeline.jobs import (
    EXECUTION_STATES,
    claim_job,
    connect_db,
    get_job,
    next_queued_job,
    recover_abandoned,
)
from app.pipeline.nodes import TransientStageError, extraction_artifact_path
from app.pipeline.runner import ELIGIBLE_RECOVERY, ELIGIBLE_RUN, run_job
from app.pipeline.worker import drain
from app.services.vector_store import get_collection
from app.storage.database import init_db
from app.storage.documents import init_storage

EMBED = pytest.mark.skipif(
    os.environ.get("JUSTMAYA_EMBED") != "1", reason="requires ONNX embedding model"
)

DOC_ID = "doc-1"
JOB_ID = "job-1"


def make_settings(tmp_path):
    return Settings(
        meta_api_key="test-placeholder-key",
        data_dir=tmp_path,
        checkpoint_db_path=tmp_path / "checkpoints.db",
        chroma_dir=tmp_path / "chroma",
        worker_poll_seconds=0.01,
        pipeline_node_max_attempts=3,
    )


def seed_job(tmp_path, fixture_path, doc_id=DOC_ID, job_id=JOB_ID):
    init_db(tmp_path)
    storage = init_storage(tmp_path)
    (storage / f"{doc_id}.pdf").write_bytes(
        fixture_path("PDF_SAMPLE.pdf").read_bytes()
    )
    conn = connect_db(tmp_path)
    with conn:
        conn.execute(
            "INSERT INTO documents (document_id, filename, status, page_count, "
            "file_hash, file_size, storage_path, created_at) "
            "VALUES (?, 'sample.pdf', 'uploaded', 27, 'h', 1, ?, 't')",
            (doc_id, f"{doc_id}.pdf"),
        )
        conn.execute(
            "INSERT INTO jobs (job_id, document_id, status, created_at, updated_at) "
            "VALUES (?, ?, 'queued', 't', 't')",
            (job_id, doc_id),
        )
    conn.close()


def stub_index(monkeypatch, calls, fail_times=0):
    def fake(extracted, settings=None):
        calls.append(extracted.document_id)
        if len(calls) <= fail_times:
            raise TransientStageError("transient boom")
        return 28

    monkeypatch.setattr(pipeline_nodes, "index_document", fake)


def spy_extract(monkeypatch, calls):
    real = pipeline_nodes.extract_document

    def spy(*args, **kwargs):
        calls.append(1)
        return real(*args, **kwargs)

    monkeypatch.setattr(pipeline_nodes, "extract_document", spy)


# --- 5.1: claiming, stages, terminal states ---


def test_claim_atomicity(tmp_path, fixtures):
    seed_job(tmp_path, fixtures)
    results = []
    barrier = threading.Barrier(2)

    def attempt():
        conn = connect_db(tmp_path)
        barrier.wait()
        results.append(claim_job(conn, JOB_ID, ("queued",)))
        conn.close()

    threads = [threading.Thread(target=attempt) for _ in range(2)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert results.count(True) == 1
    assert results.count(False) == 1


def test_full_run_partial_complete(tmp_path, fixtures, monkeypatch):
    seed_job(tmp_path, fixtures)
    settings = make_settings(tmp_path)
    calls = []
    stub_index(monkeypatch, calls)

    result = run_job(JOB_ID, settings, tmp_path)

    assert result["claimed"] is True
    job = result["job"]
    assert job["status"] == "indexing"
    assert job["stage"] == "index"
    assert job["execution_state"] == "partial_complete"
    assert job["status"] != "ready"
    assert calls == [DOC_ID]
    artifact = extraction_artifact_path(tmp_path, DOC_ID)
    assert artifact.exists()
    extracted = ExtractedDocument.model_validate_json(artifact.read_text())
    assert extracted.document_id == DOC_ID

    conn = connect_db(tmp_path)
    doc_status = conn.execute(
        "SELECT status FROM documents WHERE document_id = ?", (DOC_ID,)
    ).fetchone()[0]
    for row in conn.execute("SELECT execution_state FROM jobs").fetchall():
        assert row[0] in EXECUTION_STATES
    conn.close()
    assert doc_status == "processing"


def test_node_failure_marks_failed(tmp_path, fixtures, monkeypatch):
    seed_job(tmp_path, fixtures)
    settings = make_settings(tmp_path)
    calls = []
    stub_index(monkeypatch, calls, fail_times=10)

    result = run_job(JOB_ID, settings, tmp_path)

    job = result["job"]
    assert job["status"] == "failed"
    assert job["execution_state"] == "failed"
    assert "transient boom" in job["error"]
    assert len(calls) == settings.pipeline_node_max_attempts
    conn = connect_db(tmp_path)
    doc_status = conn.execute(
        "SELECT status FROM documents WHERE document_id = ?", (DOC_ID,)
    ).fetchone()[0]
    conn.close()
    assert doc_status == "failed"


def test_ineligible_job_not_claimed(tmp_path, fixtures):
    seed_job(tmp_path, fixtures)
    settings = make_settings(tmp_path)
    conn = connect_db(tmp_path)
    claim_job(conn, JOB_ID, ("queued",))
    conn.close()
    result = run_job(JOB_ID, settings, tmp_path, eligible=("queued",))
    assert result["claimed"] is False
    assert result["job"]["execution_state"] == "running"


def test_domain_error_not_retried(tmp_path, fixtures, monkeypatch):
    seed_job(tmp_path, fixtures)
    settings = make_settings(tmp_path)
    calls = []

    def bad_extract(*args, **kwargs):
        calls.append(1)
        raise ValueError("deterministic domain failure")

    monkeypatch.setattr(pipeline_nodes, "extract_document", bad_extract)
    result = run_job(JOB_ID, settings, tmp_path)
    assert result["job"]["execution_state"] == "failed"
    assert len(calls) == 1


# --- 5.2: resume from checkpoint ---


def test_resume_skips_completed_nodes(tmp_path, fixtures, monkeypatch):
    seed_job(tmp_path, fixtures)
    settings = make_settings(tmp_path)
    extract_calls = []
    index_calls = []
    spy_extract(monkeypatch, extract_calls)
    stub_index(monkeypatch, index_calls, fail_times=10)

    first = run_job(JOB_ID, settings, tmp_path)
    assert first["job"]["execution_state"] == "failed"
    assert extract_calls == [1]
    assert len(index_calls) == settings.pipeline_node_max_attempts

    stub_index(monkeypatch, index_calls, fail_times=-1)
    second = run_job(JOB_ID, settings, tmp_path, eligible=("failed",))

    assert second["job"]["execution_state"] == "partial_complete"
    assert second["job"]["status"] == "indexing"
    assert extract_calls == [1]  # extract node was not re-executed
    assert index_calls[-1] == DOC_ID
    assert extraction_artifact_path(tmp_path, DOC_ID).exists()


# --- 5.3: abandoned recovery ---


def test_abandoned_job_recovered(tmp_path, fixtures, monkeypatch):
    seed_job(tmp_path, fixtures)
    settings = make_settings(tmp_path)
    calls = []
    stub_index(monkeypatch, calls, fail_times=10)
    first = run_job(JOB_ID, settings, tmp_path)
    assert first["job"]["execution_state"] == "failed"

    # simulate a worker that died after claiming: running state + pending checkpoint
    conn = connect_db(tmp_path)
    with conn:
        conn.execute(
            "UPDATE jobs SET execution_state = 'running' WHERE job_id = ?",
            (JOB_ID,),
        )
    abandoned = recover_abandoned(conn)
    conn.close()
    assert abandoned == [JOB_ID]

    stub_index(monkeypatch, calls, fail_times=-1)
    recovered = run_job(JOB_ID, settings, tmp_path, eligible=ELIGIBLE_RECOVERY)
    assert recovered["claimed"] is True
    assert recovered["job"]["execution_state"] == "partial_complete"


def test_worker_drain_processes_queued(tmp_path, fixtures, monkeypatch):
    seed_job(tmp_path, fixtures)
    settings = make_settings(tmp_path)
    calls = []
    stub_index(monkeypatch, calls)

    drain(settings, tmp_path)

    conn = connect_db(tmp_path)
    job = get_job(conn, JOB_ID)
    queued = next_queued_job(conn)
    conn.close()
    assert job["execution_state"] == "partial_complete"
    assert queued is None


# --- 4.x: run endpoint and status reporting ---


@pytest.fixture
def client(tmp_path, monkeypatch):
    app = create_app(data_dir=tmp_path)
    app.state.settings = make_settings(tmp_path)
    calls = []
    stub_index(monkeypatch, calls)
    with TestClient(app) as c:
        yield c


def test_run_endpoint_happy_path(client, fixtures):
    pdf = fixtures("PDF_SAMPLE.pdf").read_bytes()
    resp = client.post(
        "/api/documents", files={"file": ("s.pdf", pdf, "application/pdf")}
    )
    assert resp.status_code == 201
    job_id = resp.json()["job_id"]

    polled = client.get(f"/api/jobs/{job_id}").json()
    assert polled["status"] == "queued"
    assert polled["execution_state"] == "queued"

    run = client.post(f"/api/jobs/{job_id}/run")
    assert run.status_code == 200
    body = run.json()
    assert body["status"] == "indexing"
    assert body["execution_state"] == "partial_complete"


def test_run_endpoint_unknown_job(client):
    resp = client.post("/api/jobs/nonexistent/run")
    assert resp.status_code == 404
    assert resp.json()["error"]["code"] == "NOT_FOUND"


def test_run_endpoint_ineligible(client, fixtures, tmp_path):
    pdf = fixtures("PDF_SAMPLE.pdf").read_bytes()
    resp = client.post(
        "/api/documents", files={"file": ("s.pdf", pdf, "application/pdf")}
    )
    job_id = resp.json()["job_id"]
    client.post(f"/api/jobs/{job_id}/run")
    again = client.post(f"/api/jobs/{job_id}/run")
    assert again.status_code == 409
    assert again.json()["error"]["code"] == "JOB_NOT_ELIGIBLE"


# --- 5.4/5.5: real-index idempotency and end-to-end ---


@EMBED
def test_index_node_idempotent(tmp_path, fixtures):
    seed_job(tmp_path, fixtures)
    settings = make_settings(tmp_path)
    nodes = pipeline_nodes.make_nodes(settings, tmp_path)
    extracted = nodes["extract"](
        {"job_id": JOB_ID, "document_id": DOC_ID, "storage_path": f"{DOC_ID}.pdf"}
    )
    state = {
        "job_id": JOB_ID,
        "document_id": DOC_ID,
        "extracted_path": extracted["extracted_path"],
    }
    first = nodes["index"](state)
    collection = get_collection(settings)
    ids_first = sorted(
        collection.get(where={"document_id": DOC_ID})["ids"]
    )
    second = nodes["index"](state)
    ids_second = sorted(
        collection.get(where={"document_id": DOC_ID})["ids"]
    )
    assert first["chunk_count"] == second["chunk_count"] > 0
    assert ids_first == ids_second


@EMBED
def test_end_to_end_upload_to_indexed(tmp_path, fixtures):
    app = create_app(data_dir=tmp_path)
    app.state.settings = make_settings(tmp_path)
    with TestClient(app) as client:
        pdf = fixtures("PDF_SAMPLE.pdf").read_bytes()
        resp = client.post(
            "/api/documents", files={"file": ("s.pdf", pdf, "application/pdf")}
        )
        assert resp.status_code == 201
        job_id = resp.json()["job_id"]

        run = client.post(f"/api/jobs/{job_id}/run")
        assert run.status_code == 200
        body = run.json()
        assert body["status"] == "indexing"
        assert body["execution_state"] == "partial_complete"

        document_id = body["document_id"]
        artifact = tmp_path / "storage" / f"{document_id}.extracted.json"
        assert artifact.exists()
        settings = app.state.settings
        collection = get_collection(settings)
        count = collection.get(where={"document_id": document_id})["ids"]
        assert len(count) > 0
