"""Real photo -> published Episode 1 check, isolated from application data.

Run from the repo root: backend/.venv/Scripts/python.exe -u backend/scripts/live_photo_check.py
Uses the configured Meta account. Prints artifact location and metered usage, never credentials.
"""
import io
import json
import sys
import tempfile
from pathlib import Path

import pymupdf
from fastapi.testclient import TestClient
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app.main import create_app


def main():
    base = Path(tempfile.mkdtemp(prefix="mita-live-photos-"))
    app = create_app(data_dir=base)
    settings = app.state.settings
    settings.data_dir = base
    settings.chroma_dir = base / "chroma"
    settings.checkpoint_db_path = base / "checkpoints.db"
    print("Artifacts:", base, flush=True)
    pdf = pymupdf.open(Path(__file__).resolve().parents[2] / "public/sample-chapter.pdf")
    images = [pdf[i].get_pixmap(matrix=pymupdf.Matrix(2, 2)).tobytes("png") for i in (1, 2)]
    with TestClient(app) as client:
        response = client.post("/api/documents/photos", files=[
            ("files", (f"chapter-photo-{i}.png", data, "image/png")) for i, data in enumerate(images, 1)
        ])
        response.raise_for_status()
        job = response.json()
        print("Source:", job, flush=True)
        def run():
            response = client.post(f"/api/jobs/{job['job_id']}/run")
            response.raise_for_status()
            result = response.json()
            print("Run:", json.dumps(result), flush=True)
            return result
        planned = run()
        assert planned["execution_state"] == "awaiting_review", planned
        roadmap = client.get(f"/api/documents/{job['document_id']}/curriculum").json()
        response = client.post(f"/api/documents/{job['document_id']}/curriculum/confirm",
                               json={"expected_revision": roadmap["revision"]})
        response.raise_for_status()
        complete = run()
        assert complete["execution_state"] == "complete", complete
        episode_id = roadmap["episodes"][0]["episode_id"]
        episode = client.get(f"/api/episodes/{episode_id}").json()
        assert episode["status"] == "ready"
        refs = [ref for scene in episode["scenes"] for line in scene.get("dialogue", [])
                for ref in line.get("sourceRefs", [])]
        assert refs and all(ref["documentId"] == job["document_id"]
                            and 1 <= ref["pageStart"] <= ref["pageEnd"] <= 2 for ref in refs)
        extraction = client.get(f"/api/documents/{job['document_id']}/inspection/extraction").json()
        assert extraction["source_kind"] == "photos" and extraction["page_count"] == 2
        assert all(page["text"].strip() for page in extraction["pages"])
        detail = client.get(f"/api/documents/{job['document_id']}/inspection/detail").json()
        assert detail["supplements"] == []
        assert all(outline["status"] == "planned_only" for outline in roadmap["episodes"][1:])
        print("Published:", episode_id, episode["title"], flush=True)
        output = io.BytesIO()
        Image.new("RGB", (512, 512), "white").save(output, format="PNG")
        blank = client.post("/api/documents/photos", files=[("files", ("blank.png", output.getvalue(), "image/png"))]).json()
        result = client.post(f"/api/jobs/{blank['job_id']}/run").json()
        assert result["status"] == "failed" and result["stage"] == "extract", result
        assert "clearer photos" in result["error"]
        print("Blank-photo recovery:", json.dumps(result), flush=True)
    print("LIVE PHOTO CHECK PASSED", flush=True)


if __name__ == "__main__":
    main()
