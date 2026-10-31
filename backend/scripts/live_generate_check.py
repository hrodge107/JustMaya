"""Live end-to-end check for episode generation (task 6.1).

Uploads the fixture PDF, runs the pipeline to awaiting_review, confirms the
roadmap, resumes into generation, and verifies the persisted draft script.

    ./.venv/Scripts/python.exe scripts/live_generate_check.py
"""

import sqlite3
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fastapi.testclient import TestClient

from app.main import create_app
from app.models.episode import EpisodeScript, validate_script
from app.services.vector_store import get_collection
from app.storage.curriculum import read_draft

REPO_ROOT = Path(__file__).resolve().parents[2]
FIXTURE = REPO_ROOT / "docs" / "PDF_SAMPLE.pdf"


def main() -> int:
    data_dir = Path(tempfile.mkdtemp(prefix="meet-mita-live-"))
    with TestClient(create_app(data_dir=data_dir)) as client:
        with FIXTURE.open("rb") as handle:
            response = client.post("/api/documents", files={"file": (FIXTURE.name, handle, "application/pdf")})
        response.raise_for_status()
        job_id = response.json()["job_id"]
        print(f"job {job_id} -> extract/index/analyze/plan (real model calls)")

        response = client.post(f"/api/jobs/{job_id}/run")
        response.raise_for_status()
        job = response.json()
        print(f"after plan run: {job['status']}/{job['stage']} {job['execution_state']}")
        assert job["execution_state"] == "awaiting_review", job

        document_id = job["document_id"]
        roadmap = client.get(f"/api/documents/{document_id}/curriculum").json()
        response = client.post(
            f"/api/documents/{document_id}/curriculum/confirm",
            json={"expected_revision": roadmap["revision"]},
        )
        response.raise_for_status()
        print("roadmap confirmed -> resuming into generation")

        response = client.post(f"/api/jobs/{job_id}/run")
        response.raise_for_status()
        job = response.json()
        print(f"after generation: {job['status']}/{job['stage']} {job['execution_state']}")
        assert job["execution_state"] == "awaiting_review", job
        assert job["stage"] == "generate", job

        response = client.get(f"/api/documents/{document_id}/inspection/episode")
        response.raise_for_status()
        script = EpisodeScript.model_validate(response.json())
        print(f"script: '{script.title}' status={script.status} "
              f"scenes={len(script.scenes)} est={script.estimatedMinutes}min")

        result = get_collection(client.app.state.settings).get(
            where={"document_id": document_id}, include=["metadatas"])
        chunks = {
            chunk_id: (meta["page_start"], meta["page_end"])
            for chunk_id, meta in zip(result["ids"], result["metadatas"])
        }
        conn = sqlite3.connect(data_dir / "app.db")
        usage = conn.execute(
            "SELECT stage, total_tokens FROM token_usage WHERE job_id = ? ORDER BY created_at",
            (job_id,)).fetchall()
        conn.close()

        roadmap_draft, _, _ = read_draft(data_dir, document_id)
        context = roadmap_draft.lesson_context
        objectives = {o.id for o in context.objectives}
        web_urls = {s.url for s in context.supplements}
        violations = validate_script(script, chunks, objectives, web_urls)
        assert not violations, violations
        assert sum(1 for s in script.scenes if s.kind == "checkpoint") == 2
        print("validate_script: 0 violations, exactly 2 checkpoints")
        print("token_usage stages:", usage)
        assert any(stage == "generation" for stage, _ in usage)
    print("LIVE CHECK PASSED")
    return 0


if __name__ == "__main__":
    sys.exit(main())
