import sqlite3

from fastapi.testclient import TestClient

from app.main import create_app
from app.storage.curriculum import read_draft, save_draft
from app.tests.test_curriculum_models import inventory, roadmap


def test_review_api_conflicts_confirmation_and_private_context(tmp_path):
    with TestClient(create_app(data_dir=tmp_path)) as client:
        url = "/api/documents/d/curriculum"
        assert client.get(url).status_code == 404
        conn = sqlite3.connect(tmp_path / "app.db")
        conn.execute("INSERT INTO documents (document_id, filename, status, created_at) VALUES ('d', 'a.pdf', 'processing', 'now')")
        conn.execute("INSERT INTO jobs (job_id, document_id, status, stage, created_at, updated_at, execution_state) VALUES ('j', 'd', 'planning', 'plan', 'now', 'now', 'awaiting_review')")
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
        assert read_draft(tmp_path, "d")[0].lesson_context is not None
        payload["expected_revision"] = 2
        assert client.put(url, json=payload).status_code == 409
