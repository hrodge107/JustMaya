import sqlite3

import pytest
from fastapi.testclient import TestClient

from app.main import create_app
from app.services.curriculum_review import build_lesson_context
from app.storage.curriculum import RoadmapConflict, attach_lesson_context, read_draft, save_draft
from app.storage.jobs import EXECUTION_REVIEW
from app.tests.test_curriculum_models import inventory, roadmap


def _seed_review_draft(tmp_path):
    conn = sqlite3.connect(tmp_path / "app.db")
    conn.execute("INSERT INTO documents (document_id, filename, status, created_at) VALUES ('d', 'a.pdf', 'processing', 'now')")
    conn.execute("INSERT INTO jobs (job_id, document_id, status, stage, created_at, updated_at, execution_state) VALUES ('j', 'd', 'planning', 'plan', 'now', 'now', ?)", (EXECUTION_REVIEW,))
    conn.commit()
    conn.close()
    save_draft(tmp_path, roadmap(), inventory(), "j")


def test_review_api_conflicts_confirmation_and_private_context(tmp_path):
    with TestClient(create_app(data_dir=tmp_path)) as client:
        url = "/api/documents/d/curriculum"
        assert client.get(url).status_code == 404
        conn = sqlite3.connect(tmp_path / "app.db")
        conn.execute("INSERT INTO documents (document_id, filename, status, created_at) VALUES ('d', 'a.pdf', 'processing', 'now')")
        conn.execute("INSERT INTO jobs (job_id, document_id, status, stage, created_at, updated_at, execution_state) VALUES ('j', 'd', 'planning', 'plan', 'now', 'now', ?)", (EXECUTION_REVIEW,))
        conn.commit()
        conn.close()
        save_draft(tmp_path, roadmap(), inventory(), "j")
        initial = client.get(url).json()
        assert initial["uncovered_concept_ids"] == [] and "lesson_context" not in initial
        payload = {"expected_revision": 1, "episodes": [{"episode_id": "e", "concept_ids": ["missing"], "words_per_minute": 140, "interaction_minutes": 2}]}
        assert client.put(url, json=payload).status_code == 422
        payload["episodes"][0]["concept_ids"] = ["c"]
        assert client.put(url, json=payload).json()["revision"] == 2
        assert client.put(url, json=payload).status_code == 409
        assert client.post(url + "/confirm", json={"expected_revision": 2}).json()["confirmed"]
        # Confirm locks the selection; the detail pass attaches the context.
        assert read_draft(tmp_path, "d")[0].lesson_context is None
        confirmed, source, _ = read_draft(tmp_path, "d")
        attach_lesson_context(tmp_path, "d", build_lesson_context(confirmed, source, source))
        assert read_draft(tmp_path, "d")[0].lesson_context is not None
        assert "lesson_context" not in client.get(url).json()
        payload["expected_revision"] = 2
        assert client.put(url, json=payload).status_code == 409


def test_attach_lesson_context_atomic_and_idempotent(tmp_path):
    from app.storage.curriculum import confirm_draft

    with TestClient(create_app(data_dir=tmp_path)):
        _seed_review_draft(tmp_path)
        draft, source, _ = read_draft(tmp_path, "d")
        context = build_lesson_context(draft, source, source)
        with pytest.raises(RoadmapConflict):
            attach_lesson_context(tmp_path, "d", context)
        confirm_draft(tmp_path, "d", revision=1)
        first = attach_lesson_context(tmp_path, "d", context)
        second = attach_lesson_context(tmp_path, "d", context)
        assert first.model_dump() == second.model_dump()
        assert second.lesson_context is not None
