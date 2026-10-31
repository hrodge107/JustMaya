"""Pipeline tests inject through the public stage contract:
`StageContext(provider=..., services=StageServices(...))` into
run_job/drain/make_nodes, `build_graph(stages=...)` subsets via
`STAGES[:n]`, and `app.state.stage_ctx` for the run endpoint.

Remaining service-internal seam (deliberate, outside the node contract):
`episode_validator.generate_episode` — validate_and_publish's
regeneration path imports it by name inside the service module.
"""

import os
import sqlite3
import threading
from dataclasses import replace
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app
from app.models.document import ExtractedDocument
from app.models.concept import ConceptInventory
from app.pipeline.nodes import (
    STAGES,
    TransientStageError,
    make_nodes,
)
from app.pipeline.runner import run_job
from app.pipeline.stage import StageContext, StageServices
from app.pipeline.worker import drain
from app.services.analysis_windows import analysis_windows
from app.services.pdf_extractor import extract_document as real_extract_document
from app.services.vector_store import get_collection
from app.storage.artifacts import ArtifactStore
from app.storage.database import init_db
from app.storage.documents import init_storage
from app.storage.jobs import (
    ELIGIBLE_RECOVERY,
    ELIGIBLE_RUN,
    EXECUTION_FAILED,
    EXECUTION_PARTIAL,
    EXECUTION_REVIEW,
    EXECUTION_RUNNING,
    EXECUTION_STATES,
    claim_job,
    connect_db,
    get_job,
    next_queued_job,
    recover_abandoned,
)

EMBED = pytest.mark.skipif(
    os.environ.get("JUSTMAYA_EMBED") != "1", reason="requires ONNX embedding model"
)

DOC_ID = "doc-1"
JOB_ID = "job-1"


async def _fake_survey(document, provider, job_id, **kwargs):
    _, coverage = analysis_windows(document)
    ref = {"document_id": document.document_id, "page_start": 1, "page_end": 1, "section_id": None}
    return ConceptInventory(document_id=document.document_id, concepts=[{"id": "c", "title": "Topic", "explanation": "Content", "evidence": [ref]}],
                            learning_objectives=[{"id": "o", "description": "Learn", "concept_ids": ["c"], "evidence": [ref]}],
                            prerequisite_edges=[], coverage=coverage)


async def _fake_detail(document, locked, survey, scope_pages, provider, job_id, **kwargs):
    first = locked.episodes[0]
    ref = {"document_id": document.document_id, "page_start": 1, "page_end": 1, "section_id": None}
    return ConceptInventory(
        document_id=document.document_id,
        concepts=[{"id": item.concept_id, "title": "Topic", "explanation": "Deep", "evidence": [ref]}
                  for item in first.concepts],
        learning_objectives=[{"id": oid, "description": "Learn",
                              "concept_ids": [first.concepts[0].concept_id], "evidence": [ref]}
                             for oid in first.objective_ids],
        prerequisite_edges=[],
        coverage=[c for c in survey.coverage if c.page_number in scope_pages],
    )


async def _fake_plan(inventory, provider, job_id, settings):
    from app.models.curriculum import Roadmap
    return Roadmap.model_validate({"curriculum_id": inventory.document_id + "-curriculum", "document_id": inventory.document_id,
        "revision": 1, "episodes": [{"episode_id": inventory.document_id + "-episode", "title": "Topic",
        "objective_ids": ["o"], "concepts": [{"concept_id": "c", "basis": "inferred", "explanation": "Suggested", "uncertainty": []}],
        "dialogue_words": 2, "words_per_minute": 140, "interaction_minutes": 2}]})


def _services(**overrides):
    return replace(
        StageServices(survey_document=_fake_survey, plan_curriculum=_fake_plan,
                      detail_analysis=_fake_detail),
        **overrides,
    )


def _ctx(settings, data_dir, *, provider=None, services=None, **service_overrides):
    """StageContext with the default analyze/plan fakes (they would hit the
    real model); override per test via kwargs or a `services=` bundle."""
    return StageContext(
        settings, data_dir, provider=provider,
        services=services or _services(**service_overrides),
    )


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


def stub_index(calls, fail_times=0):
    def fake(extracted, settings=None):
        calls.append(extracted.document_id)
        if len(calls) <= fail_times:
            raise TransientStageError("transient boom")
        return 28

    return fake


def spy_extract(calls):
    def spy(*args, **kwargs):
        calls.append(1)
        return real_extract_document(*args, **kwargs)

    return spy


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


def test_retry_claim_clears_previous_error(tmp_path, fixtures):
    seed_job(tmp_path, fixtures)
    conn = connect_db(tmp_path)
    with conn:
        conn.execute("UPDATE jobs SET execution_state=?, error='old error' WHERE job_id=?", (EXECUTION_FAILED, JOB_ID))
    assert claim_job(conn, JOB_ID, (EXECUTION_FAILED,))
    assert get_job(conn, JOB_ID)["error"] is None
    conn.close()


def test_full_run_partial_complete(tmp_path, fixtures):
    seed_job(tmp_path, fixtures)
    settings = make_settings(tmp_path)
    calls = []
    ctx = _ctx(settings, tmp_path, index_document=stub_index(calls))

    result = run_job(JOB_ID, settings, tmp_path, ctx=ctx)

    assert result["claimed"] is True
    job = result["job"]
    assert job["status"] == "planning"
    assert job["stage"] == "plan"
    assert job["execution_state"] == "awaiting_review"
    assert job["status"] != "ready"
    assert calls == [DOC_ID]
    artifact = ArtifactStore(tmp_path / "storage").path(DOC_ID, "extracted")
    assert artifact.exists()
    extracted = ExtractedDocument.model_validate_json(artifact.read_text())
    assert extracted.document_id == DOC_ID
    assert (tmp_path / "storage" / f"{DOC_ID}.concepts.json").exists()

    conn = connect_db(tmp_path)
    doc_status = conn.execute(
        "SELECT status FROM documents WHERE document_id = ?", (DOC_ID,)
    ).fetchone()[0]
    for row in conn.execute("SELECT execution_state FROM jobs").fetchall():
        assert row[0] in EXECUTION_STATES
    conn.close()
    assert doc_status == "processing"


def test_node_failure_marks_failed(tmp_path, fixtures):
    seed_job(tmp_path, fixtures)
    settings = make_settings(tmp_path)
    calls = []
    ctx = _ctx(settings, tmp_path, index_document=stub_index(calls, fail_times=10))

    result = run_job(JOB_ID, settings, tmp_path, ctx=ctx)

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


def test_domain_error_not_retried(tmp_path, fixtures):
    seed_job(tmp_path, fixtures)
    settings = make_settings(tmp_path)
    calls = []

    def bad_extract(*args, **kwargs):
        calls.append(1)
        raise ValueError("deterministic domain failure")

    result = run_job(JOB_ID, settings, tmp_path,
                     ctx=_ctx(settings, tmp_path, extract_document=bad_extract))
    assert result["job"]["execution_state"] == "failed"
    assert len(calls) == 1


# --- 5.2: resume from checkpoint ---


def test_resume_skips_completed_nodes(tmp_path, fixtures):
    seed_job(tmp_path, fixtures)
    settings = make_settings(tmp_path)
    extract_calls, index_calls = [], []

    first = run_job(JOB_ID, settings, tmp_path, ctx=_ctx(
        settings, tmp_path,
        extract_document=spy_extract(extract_calls),
        index_document=stub_index(index_calls, fail_times=10),
    ))
    assert first["job"]["execution_state"] == "failed"
    assert extract_calls == [1]
    assert len(index_calls) == settings.pipeline_node_max_attempts

    second = run_job(JOB_ID, settings, tmp_path, eligible=("failed",), ctx=_ctx(
        settings, tmp_path,
        extract_document=spy_extract(extract_calls),
        index_document=stub_index(index_calls, fail_times=-1),
    ))

    assert second["job"]["execution_state"] == "awaiting_review"
    assert second["job"]["status"] == "planning"
    assert extract_calls == [1]  # extract node was not re-executed
    assert index_calls[-1] == DOC_ID
    assert ArtifactStore(tmp_path / "storage").path(DOC_ID, "extracted").exists()


def test_analysis_failure_resumes_without_repeating_prior_nodes(tmp_path, fixtures):
    seed_job(tmp_path, fixtures)
    settings = make_settings(tmp_path)
    extract_calls, index_calls, analysis_calls = [], [], []

    async def fail(document, provider, job_id, **kwargs):
        analysis_calls.append(1)
        raise ValueError("analysis failed")

    previous = tmp_path / "storage" / f"{DOC_ID}.concepts.json"
    previous.write_text("previous", encoding="utf-8")
    first = run_job(JOB_ID, settings, tmp_path, ctx=_ctx(
        settings, tmp_path,
        extract_document=spy_extract(extract_calls),
        index_document=stub_index(index_calls),
        survey_document=fail,
    ))
    assert first["job"]["execution_state"] == "failed"
    assert previous.read_text(encoding="utf-8") == "previous"

    async def succeed(document, provider, job_id, **kwargs):
        analysis_calls.append(1)
        _, coverage = analysis_windows(document)
        ref = {"document_id": document.document_id, "page_start": 1, "page_end": 1, "section_id": None}
        return ConceptInventory(document_id=document.document_id, concepts=[{"id": "c", "title": "Topic", "explanation": "Content", "evidence": [ref]}],
                                learning_objectives=[{"id": "o", "description": "Learn", "concept_ids": ["c"], "evidence": [ref]}],
                                prerequisite_edges=[], coverage=coverage)

    second = run_job(JOB_ID, settings, tmp_path, ctx=_ctx(
        settings, tmp_path,
        extract_document=spy_extract(extract_calls),
        index_document=stub_index(index_calls),
        survey_document=succeed,
    ))
    assert second["job"]["status"] == "planning"
    assert second["job"]["execution_state"] == "awaiting_review"
    assert extract_calls == [1] and index_calls == [DOC_ID] and len(analysis_calls) == 2
    assert ConceptInventory.model_validate_json(previous.read_text(encoding="utf-8")).document_id == DOC_ID


def test_explicitly_advance_old_partial_job(tmp_path, fixtures):
    seed_job(tmp_path, fixtures)
    settings = make_settings(tmp_path)
    extract_calls, index_calls = [], []
    ctx = _ctx(settings, tmp_path,
               extract_document=spy_extract(extract_calls),
               index_document=stub_index(index_calls))
    assert run_job(JOB_ID, settings, tmp_path, ctx=ctx, stages=STAGES[:2])["job"]["status"] == "indexing"
    conn = connect_db(tmp_path)
    with conn:
        conn.execute("UPDATE jobs SET execution_state = ? WHERE job_id = ?", (EXECUTION_PARTIAL, JOB_ID))
    conn.close()
    resumed = run_job(JOB_ID, settings, tmp_path, ctx=ctx, stages=STAGES[:4])
    assert resumed["job"]["status"] == "planning"
    assert resumed["job"]["execution_state"] == "awaiting_review"
    assert extract_calls == [1] and index_calls == [DOC_ID]
    assert run_job(JOB_ID, settings, tmp_path, eligible=("partial_complete",))["claimed"] is False


def test_advance_analysis_checkpoint_without_reanalysis(tmp_path, fixtures):
    seed_job(tmp_path, fixtures)
    settings = make_settings(tmp_path)
    calls = []
    ctx = _ctx(settings, tmp_path, index_document=stub_index(calls))
    assert run_job(JOB_ID, settings, tmp_path, ctx=ctx, stages=STAGES[:3])["job"]["status"] == "analyzing"
    conn = connect_db(tmp_path)
    with conn:
        conn.execute("UPDATE jobs SET execution_state = ? WHERE job_id = ?", (EXECUTION_PARTIAL, JOB_ID))
    conn.close()

    def unexpected(*args, **kwargs):
        raise AssertionError("analysis must not repeat")

    ctx = _ctx(settings, tmp_path, survey_document=unexpected)
    result = run_job(JOB_ID, settings, tmp_path, ctx=ctx, stages=STAGES[:4])
    assert result["job"]["execution_state"] == "awaiting_review"
    assert calls == [DOC_ID]
    drain(settings, tmp_path, ctx=ctx, stages=STAGES[:4])
    conn = connect_db(tmp_path)
    assert get_job(conn, JOB_ID)["execution_state"] == "awaiting_review"
    conn.close()


def test_analysis_node_reexecution_replaces_one_artifact(tmp_path, fixtures):
    seed_job(tmp_path, fixtures)
    settings = make_settings(tmp_path)
    nodes = make_nodes(_ctx(settings, tmp_path))
    state = {"job_id": JOB_ID, "document_id": DOC_ID, "storage_path": f"{DOC_ID}.pdf"}
    state.update(nodes["extract"](state))
    first = nodes["analyze"](state)
    artifact = tmp_path / "storage" / first["inventory_path"]
    contents = artifact.read_text(encoding="utf-8")
    second = nodes["analyze"](state)
    assert first == second and artifact.read_text(encoding="utf-8") == contents
    assert list((tmp_path / "storage").glob("*.concepts.json")) == [artifact]


# --- A07: generation stage ---


def _script_payload(episode_id, document_id, title):
    return {
            "episodeId": episode_id,
            "documentId": document_id,
            "title": title,
            "learningObjectives": ["Learn"],
            "estimatedMinutes": 5.0,
            "startSceneId": "s1",
            "scenes": [
                {"sceneId": "s1", "kind": "dialogue",
                 "dialogue": [{"lineId": "l1", "speaker": "mascot", "text": "Hi",
                               "emotion": "happy", "sourceRefs": [], "webRefs": []}],
                 "nextSceneId": "s2"},
                {"sceneId": "s2", "kind": "checkpoint", "dialogue": [],
                 "question": {"questionId": "q1", "prompt": "W?", "objectiveId": "o",
                              "options": [{"optionId": "a", "label": "A", "mistakeResponse": "Not A."},
                                          {"optionId": "b", "label": "B", "mistakeResponse": "Not B."},
                                          {"optionId": "c", "label": "C", "mistakeResponse": "Not C."}],
                              "correctOptionId": "a", "correctExplanation": "R",
                              "incorrectExplanation": "N", "sourceRefs": [],
                              "feedback": {"firstIncorrect": "Hint", "correct": "R", "finalIncorrect": "N"},
                              "webRefs": [], "maxAttempts": 2},
                 "nextSceneId": "s3"},
                {"sceneId": "s3", "kind": "checkpoint", "dialogue": [],
                 "question": {"questionId": "q2", "prompt": "W?", "objectiveId": "o",
                              "options": [{"optionId": "a", "label": "A", "mistakeResponse": "Not A."},
                                          {"optionId": "b", "label": "B", "mistakeResponse": "Not B."},
                                          {"optionId": "c", "label": "C", "mistakeResponse": "Not C."}],
                              "correctOptionId": "a", "correctExplanation": "R",
                              "incorrectExplanation": "N", "sourceRefs": [],
                              "feedback": {"firstIncorrect": "Hint", "correct": "R", "finalIncorrect": "N"},
                              "webRefs": [], "maxAttempts": 2},
                 "nextSceneId": "s4"},
                {"sceneId": "s4", "kind": "ending",
                 "dialogue": [{"lineId": "l2", "speaker": "mascot", "text": "Done",
                               "emotion": "happy", "sourceRefs": [], "webRefs": []}],
                 "nextSceneId": None},
            ],
        }


def _stub_generate(monkeypatch):
    import app.services.episode_validator as episode_validator
    from app.models.episode import EpisodeScript

    async def fake(roadmap, lesson_context, passages, known, provider, job_id, settings, **kw):
        return EpisodeScript.model_validate(_script_payload(
            lesson_context.episode_id, roadmap.document_id, roadmap.episodes[0].title))

    # validate_and_publish imports generate_episode by name — its regen path
    # must hit the same stub (service-internal seam, not the node contract).
    monkeypatch.setattr(episode_validator, "generate_episode", fake)
    return fake


def _episode_rows(tmp_path):
    conn = connect_db(tmp_path)
    try:
        return conn.execute("SELECT * FROM episodes").fetchall()
    finally:
        conn.close()


def test_generate_skips_until_confirmed(tmp_path, fixtures, monkeypatch):
    seed_job(tmp_path, fixtures)
    settings = make_settings(tmp_path)
    called = []

    async def must_not_run(*a, **k):
        called.append(1)
        raise AssertionError("must not run")

    result = run_job(JOB_ID, settings, tmp_path, ctx=_ctx(
        settings, tmp_path,
        index_document=stub_index([]),
        generate_episode=must_not_run,
    ))
    assert result["job"]["execution_state"] == "awaiting_review"
    assert called == [] and _episode_rows(tmp_path) == []


def test_confirmed_resume_generates_and_publishes(tmp_path, fixtures, monkeypatch):
    from app.storage.curriculum import confirm_draft
    from app.storage.episodes import read_episode

    seed_job(tmp_path, fixtures)
    settings = make_settings(tmp_path)
    ctx = _ctx(settings, tmp_path,
               index_document=stub_index([]),
               generate_episode=_stub_generate(monkeypatch),
               provider=_ReviewProvider([{"verdict": "pass", "violations": []}]))

    first = run_job(JOB_ID, settings, tmp_path, ctx=ctx)
    assert first["job"]["stage"] == "plan"
    confirm_draft(tmp_path, DOC_ID, revision=1)

    resumed = run_job(JOB_ID, settings, tmp_path, eligible=("partial_complete",), ctx=ctx)
    assert resumed["claimed"] is True
    assert resumed["job"]["status"] == "ready"
    assert resumed["job"]["execution_state"] == "complete"

    rows = _episode_rows(tmp_path)
    assert len(rows) == 1
    script = read_episode(tmp_path, DOC_ID)
    assert script.status == "ready"
    artifact = tmp_path / "storage" / f"{DOC_ID}.{script.episodeId}.script.json"
    assert artifact.exists()
    contents = artifact.read_text(encoding="utf-8")

    # idempotent node re-execution (mid-node crash replays the whole node)
    nodes = make_nodes(ctx)
    state = {"job_id": JOB_ID, "document_id": DOC_ID}
    first = nodes["generate"](state)
    second = nodes["generate"](state)
    assert first == second == {"episode_id": script.episodeId}
    assert len(_episode_rows(tmp_path)) == 1
    assert artifact.read_text(encoding="utf-8") == contents


# --- A08: validation stage ---


class _ReviewProvider:
    """Stub generation provider serving the semantic review call."""

    def __init__(self, payloads):
        self.payloads = list(payloads)
        self.calls = []

    async def generate_structured(self, **kw):
        from app.services.model_provider import StructuredResult

        self.calls.append(kw)
        return StructuredResult(
            data=self.payloads.pop(0),
            usage={"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15},
        )

    async def generate_text(self, **kw):
        raise AssertionError("validation must not call generate_text")

    async def count_input_tokens(self, **kw):
        return 10


def _confirmed_run(tmp_path, settings, monkeypatch, review_payloads):
    from app.storage.curriculum import confirm_draft

    provider = _ReviewProvider(review_payloads)
    ctx = _ctx(settings, tmp_path,
               index_document=stub_index([]),
               generate_episode=_stub_generate(monkeypatch),
               provider=provider)
    run_job(JOB_ID, settings, tmp_path, ctx=ctx)
    confirm_draft(tmp_path, DOC_ID, revision=1)
    resumed = run_job(JOB_ID, settings, tmp_path, eligible=("partial_complete",), ctx=ctx)
    return resumed, provider


def test_validate_failure_marks_failed(tmp_path, fixtures, monkeypatch):
    seed_job(tmp_path, fixtures)
    settings = make_settings(tmp_path)
    resumed, provider = _confirmed_run(
        tmp_path, settings, monkeypatch,
        [{"verdict": "fail", "violations": [{"check": "coverage", "detail": "obj-1 not taught"}]},
         {"verdict": "fail", "violations": [{"check": "coverage", "detail": "still uncovered"}]}],
    )
    assert resumed["job"]["status"] == "failed"
    assert resumed["job"]["execution_state"] == "failed"
    assert "still uncovered" in resumed["job"]["error"]
    # review + regen + re-review bounded calls; draft survives with the report
    assert len(provider.calls) == 2  # generate path is module-stubbed, not provider-served
    rows = _episode_rows(tmp_path)
    assert len(rows) == 1


def test_validate_node_idempotent_no_respend(tmp_path, fixtures, monkeypatch):
    from app.storage.episodes import read_episode

    seed_job(tmp_path, fixtures)
    settings = make_settings(tmp_path)
    resumed, provider = _confirmed_run(
        tmp_path, settings, monkeypatch, [{"verdict": "pass", "violations": []}]
    )
    assert resumed["job"]["execution_state"] == "complete"

    nodes = make_nodes(_ctx(settings, tmp_path))
    state = {"job_id": JOB_ID, "document_id": DOC_ID}
    result = nodes["validate"](state)
    assert result["episode_id"] == read_episode(tmp_path, DOC_ID).episodeId
    assert len(provider.calls) == 1  # ready short-circuit — no re-spend


def test_validate_crash_resumes_at_validate(tmp_path, fixtures, monkeypatch):
    from app.storage.curriculum import confirm_draft
    from app.storage.episodes import read_episode_state

    seed_job(tmp_path, fixtures)
    settings = make_settings(tmp_path)
    services = _services(index_document=stub_index([]),
                         generate_episode=_stub_generate(monkeypatch))
    run_job(JOB_ID, settings, tmp_path,
            ctx=StageContext(settings, tmp_path, services=services))
    confirm_draft(tmp_path, DOC_ID, revision=1)

    boom = []

    async def explode(*a, **k):
        boom.append(1)
        raise TransientStageError("validate boom")

    first = run_job(JOB_ID, settings, tmp_path, eligible=("partial_complete",),
                    ctx=StageContext(settings, tmp_path,
                                     services=replace(services, validate_and_publish=explode)))
    assert first["job"]["execution_state"] == "failed"
    assert len(boom) == settings.pipeline_node_max_attempts

    provider = _ReviewProvider([{"verdict": "pass", "violations": []}])
    second = run_job(JOB_ID, settings, tmp_path, eligible=("failed",),
                     ctx=StageContext(settings, tmp_path, provider=provider, services=services))
    assert second["job"]["status"] == "ready"
    assert second["job"]["execution_state"] == "complete"
    assert read_episode_state(tmp_path, DOC_ID)["status"] == "ready"


def test_pre_change_draft_resumes_into_validate(tmp_path, fixtures, monkeypatch):
    """Jobs parked at awaiting_review after generation continue into validate."""
    from app.storage.curriculum import confirm_draft
    from app.storage.episodes import read_episode_state

    seed_job(tmp_path, fixtures)
    settings = make_settings(tmp_path)
    services = _services(index_document=stub_index([]),
                         generate_episode=_stub_generate(monkeypatch))
    ctx = StageContext(settings, tmp_path, services=services)
    run_job(JOB_ID, settings, tmp_path, ctx=ctx, stages=STAGES[:6])
    confirm_draft(tmp_path, DOC_ID, revision=1)
    parked = run_job(JOB_ID, settings, tmp_path, eligible=("partial_complete",),
                     ctx=ctx, stages=STAGES[:6])
    assert parked["job"]["execution_state"] == "awaiting_review"
    assert parked["job"]["stage"] == "generate"
    assert read_episode_state(tmp_path, DOC_ID)["status"] == "draft"

    provider = _ReviewProvider([{"verdict": "pass", "violations": []}])
    resumed = run_job(JOB_ID, settings, tmp_path,
                      ctx=StageContext(settings, tmp_path, provider=provider, services=services))
    assert resumed["job"]["status"] == "ready"
    assert resumed["job"]["execution_state"] == "complete"
    assert read_episode_state(tmp_path, DOC_ID)["status"] == "ready"


# --- detail stage ---


def _spy_detail(calls):
    async def spy(document, locked, survey, scope_pages, provider, job_id, **kw):
        calls.append(sorted(scope_pages))
        return await _fake_detail(document, locked, survey, scope_pages, provider, job_id, **kw)
    return spy


def test_detail_waits_for_confirmation(tmp_path, fixtures, monkeypatch):
    """No detail spend before the roadmap is confirmed; one call after."""
    from app.storage.curriculum import confirm_draft, read_draft

    seed_job(tmp_path, fixtures)
    settings = make_settings(tmp_path)
    calls = []
    ctx = _ctx(settings, tmp_path,
               index_document=stub_index([]),
               detail_analysis=_spy_detail(calls),
               generate_episode=_stub_generate(monkeypatch),
               provider=_ReviewProvider([{"verdict": "pass", "violations": []}]))
    first = run_job(JOB_ID, settings, tmp_path, ctx=ctx)
    assert first["job"]["execution_state"] == "awaiting_review"
    assert calls == []

    confirm_draft(tmp_path, DOC_ID, revision=1)
    resumed = run_job(JOB_ID, settings, tmp_path, eligible=("partial_complete",), ctx=ctx)
    assert resumed["job"]["status"] == "ready"
    assert calls == [[1, 2]]
    # detail artifact persisted; lesson context attached for generation
    assert (tmp_path / "storage" / f"{DOC_ID}.concepts-detail.json").exists()
    roadmap, _, _ = read_draft(tmp_path, DOC_ID)
    assert roadmap.lesson_context is not None

    # idempotent re-execution: context already attached — no re-spend
    nodes = make_nodes(ctx)
    assert nodes["detail"]({"job_id": JOB_ID, "document_id": DOC_ID}) == {
        "curriculum_id": roadmap.curriculum_id}
    assert len(calls) == 1


def test_partial_past_plan_resumes_via_detail(tmp_path, fixtures, monkeypatch):
    """A checkpoint parked past plan when confirmed without a lesson context
    re-enters at detail instead of skipping it."""
    from app.storage.curriculum import confirm_draft

    seed_job(tmp_path, fixtures)
    settings = make_settings(tmp_path)
    calls = []
    ctx = _ctx(settings, tmp_path,
               index_document=stub_index([]),
               detail_analysis=_spy_detail(calls),
               generate_episode=_stub_generate(monkeypatch),
               provider=_ReviewProvider([{"verdict": "pass", "violations": []}]))
    run_job(JOB_ID, settings, tmp_path, ctx=ctx)
    confirm_draft(tmp_path, DOC_ID, revision=1)
    conn = connect_db(tmp_path)
    with conn:
        conn.execute(
            "UPDATE jobs SET stage = 'generate', status = 'generating' WHERE job_id = ?",
            (JOB_ID,))
    conn.close()

    resumed = run_job(JOB_ID, settings, tmp_path, eligible=("partial_complete",), ctx=ctx)
    assert resumed["job"]["status"] == "ready"
    assert resumed["job"]["execution_state"] == "complete"
    assert calls == [[1, 2]]


def test_pre_change_generated_draft_resumes_via_detail(tmp_path, fixtures, monkeypatch):
    """An episode draft parked at awaiting_review/generate and confirmed
    after the detail stage existed still runs detail before validate."""
    from app.models.episode import EpisodeScript
    from app.storage.curriculum import confirm_draft
    from app.storage.episodes import read_episode_state, save_episode_draft

    seed_job(tmp_path, fixtures)
    settings = make_settings(tmp_path)
    calls = []
    ctx = _ctx(settings, tmp_path,
               index_document=stub_index([]),
               detail_analysis=_spy_detail(calls),
               generate_episode=_stub_generate(monkeypatch),
               provider=_ReviewProvider([{"verdict": "pass", "violations": []}]))
    run_job(JOB_ID, settings, tmp_path, ctx=ctx)
    confirmed = confirm_draft(tmp_path, DOC_ID, revision=1)
    # Pre-change parked state: generated draft + REVIEW at the generate stage.
    save_episode_draft(tmp_path, EpisodeScript.model_validate(
        _script_payload(DOC_ID + "-episode", DOC_ID, "Topic")), confirmed.curriculum_id)
    conn = connect_db(tmp_path)
    with conn:
        conn.execute(
            "UPDATE jobs SET stage = 'generate', status = 'generating', "
            "execution_state = ? WHERE job_id = ?",
            (EXECUTION_REVIEW, JOB_ID))
    conn.close()

    resumed = run_job(JOB_ID, settings, tmp_path, ctx=ctx)
    assert resumed["job"]["status"] == "ready"
    assert resumed["job"]["execution_state"] == "complete"
    assert calls == [[1, 2]]
    assert read_episode_state(tmp_path, DOC_ID)["status"] == "ready"


def test_detail_guard_outcomes(tmp_path, fixtures):
    """Absent draft parks, foreign draft raises — no service call either way."""
    seed_job(tmp_path, fixtures)
    settings = make_settings(tmp_path)
    calls = []
    nodes = make_nodes(_ctx(settings, tmp_path, detail_analysis=_spy_detail(calls)))
    state = {"job_id": JOB_ID, "document_id": DOC_ID}
    assert nodes["detail"](state) == {}
    assert calls == []

    from app.storage.curriculum import save_draft
    from app.tests.test_curriculum_models import inventory, roadmap
    save_draft(tmp_path,
               roadmap().model_copy(update={"document_id": DOC_ID}),
               inventory().model_copy(update={"document_id": DOC_ID}),
               "other-job")
    with pytest.raises(ValueError, match="different job"):
        nodes["detail"](state)
    assert calls == []


def test_inspection_detail_stage(tmp_path, fixtures, monkeypatch):
    """The detail artifact is readable through the inspection endpoint."""
    from app.storage.curriculum import confirm_draft

    seed_job(tmp_path, fixtures)
    settings = make_settings(tmp_path)
    ctx = _ctx(settings, tmp_path,
               index_document=stub_index([]),
               generate_episode=_stub_generate(monkeypatch),
               provider=_ReviewProvider([{"verdict": "pass", "violations": []}]))
    run_job(JOB_ID, settings, tmp_path, ctx=ctx)
    confirm_draft(tmp_path, DOC_ID, revision=1)
    run_job(JOB_ID, settings, tmp_path, eligible=("partial_complete",), ctx=ctx)

    app = create_app(data_dir=tmp_path)
    app.state.settings = settings
    with TestClient(app) as client:
        resp = client.get(f"/api/documents/{DOC_ID}/inspection/detail")
        assert resp.status_code == 200
        body = resp.json()
        assert body["document_id"] == DOC_ID
        assert {c["page_number"] for c in body["coverage"]} == {1, 2}
        assert client.get(f"/api/documents/{DOC_ID}/inspection/analysis").status_code == 200


def test_inspection_validation_stage(tmp_path, fixtures, monkeypatch):
    seed_job(tmp_path, fixtures)
    settings = make_settings(tmp_path)
    resumed, _ = _confirmed_run(
        tmp_path, settings, monkeypatch, [{"verdict": "pass", "violations": []}]
    )
    assert resumed["job"]["execution_state"] == "complete"

    app = create_app(data_dir=tmp_path)
    app.state.settings = settings
    with TestClient(app) as client:
        resp = client.get(f"/api/documents/{DOC_ID}/inspection/validation")
        assert resp.status_code == 200
        body = resp.json()
        assert body["status"] == "ready"
        assert '"verdict":"pass"' in body["validation"]
        assert client.get("/api/documents/none/inspection/validation").status_code == 404


def test_generate_failure_preserves_prior_draft(tmp_path, fixtures, monkeypatch):
    from app.storage.curriculum import confirm_draft

    seed_job(tmp_path, fixtures)
    settings = make_settings(tmp_path)
    services = _services(index_document=stub_index([]),
                         generate_episode=_stub_generate(monkeypatch))
    ctx = StageContext(settings, tmp_path,
                       provider=_ReviewProvider([{"verdict": "pass", "violations": []}]),
                       services=services)
    run_job(JOB_ID, settings, tmp_path, ctx=ctx)
    confirm_draft(tmp_path, DOC_ID, revision=1)
    run_job(JOB_ID, settings, tmp_path, eligible=("partial_complete",), ctx=ctx)
    assert len(_episode_rows(tmp_path)) == 1

    async def boom(*a, **k):
        raise ValueError("generation exploded")

    nodes = make_nodes(StageContext(
        settings, tmp_path, services=replace(services, generate_episode=boom)))
    state = {"job_id": JOB_ID, "document_id": DOC_ID}
    with pytest.raises(ValueError, match="generation exploded"):
        nodes["generate"](state)
    assert len(_episode_rows(tmp_path)) == 1


def test_ready_episode_survives_draft_overwrite(tmp_path, fixtures, monkeypatch):
    from app.storage.curriculum import confirm_draft
    from app.storage.episodes import read_episode, save_episode_draft

    seed_job(tmp_path, fixtures)
    settings = make_settings(tmp_path)
    ctx = _ctx(settings, tmp_path,
               index_document=stub_index([]),
               generate_episode=_stub_generate(monkeypatch),
               provider=_ReviewProvider([{"verdict": "pass", "violations": []}]))
    run_job(JOB_ID, settings, tmp_path, ctx=ctx)
    confirm_draft(tmp_path, DOC_ID, revision=1)
    run_job(JOB_ID, settings, tmp_path, eligible=("partial_complete",), ctx=ctx)

    script = read_episode(tmp_path, DOC_ID)
    conn = connect_db(tmp_path)
    with conn:
        conn.execute("UPDATE episodes SET status = 'ready' WHERE episode_id = ?", (script.episodeId,))
    conn.close()

    changed = script.model_copy(deep=True)
    changed.title = "overwritten"
    save_episode_draft(tmp_path, changed, "cur-1")
    assert read_episode(tmp_path, DOC_ID).title == script.title


# --- 5.3: abandoned recovery ---


def test_abandoned_job_recovered(tmp_path, fixtures):
    seed_job(tmp_path, fixtures)
    settings = make_settings(tmp_path)
    calls = []
    first = run_job(JOB_ID, settings, tmp_path, ctx=_ctx(
        settings, tmp_path, index_document=stub_index(calls, fail_times=10)))
    assert first["job"]["execution_state"] == "failed"

    # simulate a worker that died after claiming: running state + pending checkpoint
    conn = connect_db(tmp_path)
    with conn:
        conn.execute(
            "UPDATE jobs SET execution_state = ? WHERE job_id = ?",
            (EXECUTION_RUNNING, JOB_ID),
        )
    abandoned = recover_abandoned(conn)
    conn.close()
    assert abandoned == [JOB_ID]

    recovered = run_job(JOB_ID, settings, tmp_path, eligible=ELIGIBLE_RECOVERY,
                        ctx=_ctx(settings, tmp_path, index_document=stub_index(calls, fail_times=-1)))
    assert recovered["claimed"] is True
    assert recovered["job"]["execution_state"] == "awaiting_review"


def test_worker_drain_processes_queued(tmp_path, fixtures):
    seed_job(tmp_path, fixtures)
    settings = make_settings(tmp_path)
    calls = []
    drain(settings, tmp_path, ctx=_ctx(settings, tmp_path, index_document=stub_index(calls)))

    conn = connect_db(tmp_path)
    job = get_job(conn, JOB_ID)
    queued = next_queued_job(conn)
    conn.close()
    assert job["execution_state"] == "awaiting_review"
    assert queued is None


# --- 4.x: run endpoint and status reporting ---


@pytest.fixture
def client(tmp_path):
    app = create_app(data_dir=tmp_path)
    app.state.settings = make_settings(tmp_path)
    app.state.stage_ctx = _ctx(app.state.settings, tmp_path,
                               index_document=stub_index([]))
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
    assert body["status"] == "planning"
    assert body["execution_state"] == "awaiting_review"


def test_run_endpoint_unknown_job(client):
    resp = client.post("/api/jobs/nonexistent/run")
    assert resp.status_code == 404
    assert resp.json()["error"]["code"] == "NOT_FOUND"


def test_run_endpoint_ineligible(client, fixtures):
    pdf = fixtures("PDF_SAMPLE.pdf").read_bytes()
    resp = client.post(
        "/api/documents", files={"file": ("s.pdf", pdf, "application/pdf")}
    )
    assert resp.status_code == 201
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
    nodes = make_nodes(_ctx(settings, tmp_path))
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
    app.state.stage_ctx = _ctx(app.state.settings, tmp_path)
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
        assert body["status"] == "planning"
        assert body["execution_state"] == "awaiting_review"

        document_id = body["document_id"]
        artifact = tmp_path / "storage" / f"{document_id}.extracted.json"
        assert artifact.exists()
        settings = app.state.settings
        collection = get_collection(settings)
        count = collection.get(where={"document_id": document_id})["ids"]
        assert len(count) > 0


@EMBED
def test_end_to_end_upload_to_ready_episode(tmp_path, fixtures, monkeypatch):
    """A08: upload -> review -> confirm -> validated episode -> retrieval."""
    from app.models.curriculum import Roadmap

    def outline(episode_id):
        return {"episode_id": episode_id, "title": "Topic",
                "objective_ids": ["o"],
                "concepts": [{"concept_id": "c", "basis": "inferred",
                              "explanation": "Suggested", "uncertainty": []}],
                "dialogue_words": 2, "words_per_minute": 140,
                "interaction_minutes": 2}

    async def fake_plan(inventory, provider, job_id, settings):
        doc = inventory.document_id
        return Roadmap.model_validate({
            "curriculum_id": doc + "-curriculum", "document_id": doc,
            "revision": 1,
            "episodes": [outline(doc + "-episode-1"), outline(doc + "-episode-2")]})

    app = create_app(data_dir=tmp_path)
    app.state.settings = make_settings(tmp_path)
    app.state.stage_ctx = _ctx(
        app.state.settings, tmp_path,
        plan_curriculum=fake_plan,
        generate_episode=_stub_generate(monkeypatch),
        provider=_ReviewProvider([{"verdict": "pass", "violations": []}]),
    )
    with TestClient(app) as client:
        pdf = fixtures("PDF_SAMPLE.pdf").read_bytes()
        resp = client.post(
            "/api/documents", files={"file": ("s.pdf", pdf, "application/pdf")}
        )
        assert resp.status_code == 201
        job_id = resp.json()["job_id"]

        run = client.post(f"/api/jobs/{job_id}/run")
        assert run.status_code == 200
        assert run.json()["execution_state"] == "awaiting_review"
        document_id = run.json()["document_id"]

        curriculum = client.get(f"/api/documents/{document_id}/curriculum")
        assert curriculum.status_code == 200
        roadmap = curriculum.json()
        assert roadmap["confirmed"] is False
        assert all(e["status"] == "planned_only" for e in roadmap["episodes"])

        confirm = client.post(
            f"/api/documents/{document_id}/curriculum/confirm",
            json={"expected_revision": roadmap["revision"]},
        )
        assert confirm.status_code == 200

        resumed = client.post(f"/api/jobs/{job_id}/run")
        assert resumed.status_code == 200
        body = resumed.json()
        assert body["status"] == "ready"
        assert body["execution_state"] == "complete"

        episode_id = document_id + "-episode-1"
        episode = client.get(f"/api/episodes/{episode_id}")
        assert episode.status_code == 200
        payload = episode.json()
        assert payload["status"] == "ready"
        assert payload["documentId"] == document_id
        assert payload["episodeId"] == episode_id

        after = client.get(f"/api/documents/{document_id}/curriculum").json()
        assert after["confirmed"] is True
        assert after["episodes"][0]["status"] == "selected"
        assert all(
            e["status"] == "planned_only" for e in after["episodes"][1:]
        )

        inspection = client.get(
            f"/api/documents/{document_id}/inspection/validation"
        )
        assert inspection.status_code == 200
        assert inspection.json()["status"] == "ready"
