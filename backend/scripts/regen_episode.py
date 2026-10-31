"""Regenerate Episode 1 by re-uploading a PDF through the real pipeline.

A `ready` episode row is frozen by design, so a new upload mints a fresh
document/job/episode rather than mutating the stored one — the document list
then shows both as run history. Usage:

    ./.venv/Scripts/python.exe -m scripts.regen_episode <path-to.pdf>

Runs extract -> index -> survey -> plan, confirms the draft roadmap as-is,
then resumes through detail -> generate -> validate. Live model calls are
metered under the new job's token budget.
"""

import json
import sys
from pathlib import Path

from fastapi.testclient import TestClient

from app.config import load_settings
from app.main import create_app
from app.pipeline.runner import run_job
from app.storage.episodes import read_episode_state
from app.storage.jobs import ELIGIBLE_RUN


def main() -> int:
    pdf = Path(sys.argv[1])
    settings = load_settings()
    with TestClient(create_app()) as client:
        resp = client.post(
            "/api/documents",
            files={"file": (pdf.name, pdf.read_bytes(), "application/pdf")},
        )
        if resp.status_code != 201:
            print("upload failed:", resp.status_code, resp.json())
            return 1
        document_id = resp.json()["document_id"]
        job_id = resp.json()["job_id"]
        print("document:", document_id, "job:", job_id)

        result = run_job(job_id, settings, settings.data_dir, ELIGIBLE_RUN)
        job = result["job"]
        print("after run 1:", job["status"], job["stage"], job["execution_state"])
        if job["execution_state"] != "awaiting_review":
            print("job did not park for review:", job.get("error"))
            return 1

        roadmap = client.get(f"/api/documents/{document_id}/curriculum").json()
        print("roadmap episodes:",
              [(e["title"], e["dialogue_words"]) for e in roadmap["episodes"]])
        resp = client.post(
            f"/api/documents/{document_id}/curriculum/confirm",
            json={"expected_revision": roadmap["revision"]},
        )
        if resp.status_code != 200:
            print("confirm failed:", resp.status_code, resp.json())
            return 1

        result = run_job(job_id, settings, settings.data_dir, ELIGIBLE_RUN)
        job = result["job"]
        print("after run 2:", job["status"], job["stage"], job["execution_state"])
        if job.get("error"):
            print("error:", job["error"])

        state = read_episode_state(settings.data_dir, document_id)
        report = json.loads(state["validation"]) if state and state["validation"] else None
        print("episode:", state["status"] if state else None,
              "| validation:", json.dumps(report)[:1500] if report else None)
        return 0 if state and state["status"] == "ready" else 1


if __name__ == "__main__":
    sys.exit(main())
