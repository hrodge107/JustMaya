"""Live end-to-end check for episode validation (task 6.2).

Uploads the fixture PDF, runs the pipeline to awaiting_review, confirms the
roadmap, resumes through generation + validation, and verifies the published
ready episode, the metered `validation` usage row, and pure-read retrieval.

    ./.venv/Scripts/python.exe scripts/live_validate_check.py
"""

import json
import sqlite3
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fastapi.testclient import TestClient

from app.main import create_app

REPO_ROOT = Path(__file__).resolve().parents[2]
FIXTURE = REPO_ROOT / "docs" / "PDF_SAMPLE.pdf"


def main() -> int:
    data_dir = Path(tempfile.mkdtemp(prefix="justmaya-live-"))
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
        print("roadmap confirmed -> resuming into generation + validation")

        response = client.post(f"/api/jobs/{job_id}/run")
        response.raise_for_status()
        job = response.json()
        print(f"after resume: {job['status']}/{job['stage']} {job['execution_state']}")
        assert job["execution_state"] == "complete", job
        assert job["status"] == "ready", job

        episode_id = roadmap["episodes"][0]["episode_id"]
        response = client.get(f"/api/episodes/{episode_id}")
        response.raise_for_status()
        script = response.json()
        print(f"GET /api/episodes/{episode_id}: status={script['status']} "
              f"title='{script['title']}' scenes={len(script['scenes'])}")
        assert script["status"] == "ready"
        assert script["documentId"] == document_id

        response = client.get(f"/api/documents/{document_id}/inspection/validation")
        response.raise_for_status()
        inspection = response.json()
        report = json.loads(inspection["validation"])
        print(f"validation report: semantic={report['semantic']['verdict']} "
              f"regenerated={report['regenerated']} "
              f"deterministic_violations={len(report['deterministic_violations'])}")
        assert inspection["status"] == "ready"
        assert report["semantic"]["verdict"] == "pass"

        curriculum = client.get(f"/api/documents/{document_id}/curriculum").json()
        assert curriculum["episodes"][0]["status"] == "selected"
        assert all(e["status"] == "planned_only" for e in curriculum["episodes"][1:])

        conn = sqlite3.connect(data_dir / "app.db")
        usage = conn.execute(
            "SELECT stage, total_tokens FROM token_usage WHERE job_id = ? ORDER BY created_at",
            (job_id,)).fetchall()
        conn.close()
        print("token_usage stages:", usage)
        assert any(stage == "validation" for stage, _ in usage)
    print("LIVE CHECK PASSED")
    return 0


if __name__ == "__main__":
    sys.exit(main())
