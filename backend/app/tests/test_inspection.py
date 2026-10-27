import sqlite3

from fastapi.testclient import TestClient

from app.main import create_app
from app.models.document import DocumentPage, ExtractedDocument
from app.storage.episodes import save_episode_draft
from app.tests.test_curriculum_models import inventory
from app.tests.test_episode_models import _script, _valid_scenes


def test_inspection_reads_persisted_document_scoped_outputs(tmp_path, monkeypatch):
    class Collection:
        def get(self, **kwargs):
            assert kwargs["where"] == {"document_id": "d"}
            return {"ids": ["chunk"], "documents": ["source"], "metadatas": [{"document_id": "d"}]}
    monkeypatch.setattr("app.api.inspection.get_collection", lambda settings: Collection())
    with TestClient(create_app(data_dir=tmp_path)) as client:
        conn = sqlite3.connect(tmp_path / "app.db")
        conn.execute("INSERT INTO documents (document_id, filename, status, created_at) VALUES ('d', 'a.pdf', 'processing', 'now')")
        conn.commit()
        conn.close()
        base = "/api/documents/d/inspection/"
        assert client.get(base + "extraction").status_code == 404
        document = ExtractedDocument(document_id="d", page_count=1, pages=[DocumentPage(document_id="d", page_number=1, text="source")])
        (tmp_path / "storage" / "d.extracted.json").write_text(document.model_dump_json(), encoding="utf-8")
        assert client.get(base + "extraction").json()["pages"][0]["text"] == "source"
        assert client.get(base + "index").json()["ids"] == ["chunk"]
        assert client.get("/api/documents/other/inspection/index").status_code == 404
        assert client.get(base + "analysis").status_code == 404
        (tmp_path / "storage" / "d.concepts.json").write_text(inventory().model_dump_json(), encoding="utf-8")
        assert client.get(base + "analysis").json()["concepts"][0]["id"] == "c"
        assert client.get(base + "episode").status_code == 404
        save_episode_draft(tmp_path, _script(_valid_scenes(), documentId="d"), "cur-1")
        episode = client.get(base + "episode").json()
        assert episode["episodeId"] == "ep-1" and episode["status"] == "draft"
