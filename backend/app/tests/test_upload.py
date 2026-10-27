import sqlite3

import pymupdf
import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app
from app.models.document import DocumentRecord, JobStatusResponse, UploadResponse
from app.storage.database import init_db
from app.storage.documents import (
    init_storage,
    resolve_document_path,
    save_document_file,
)

EMPTY_PDF = (
    b"%PDF-1.4\n"
    b"1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n"
    b"2 0 obj << /Type /Pages /Count 0 /Kids [] >> endobj\n"
    b"trailer << /Root 1 0 R >>\n%%EOF\n"
)


def make_pdf(pages=1):
    doc = pymupdf.open()
    for i in range(pages):
        page = doc.new_page()
        page.insert_text((72, 72), f"page {i + 1}")
    return doc.tobytes()


def encrypted_pdf():
    doc = pymupdf.open()
    doc.new_page().insert_text((72, 72), "secret")
    return doc.tobytes(
        encryption=pymupdf.PDF_ENCRYPT_AES_256, owner_pw="o", user_pw="u"
    )


@pytest.fixture
def client(tmp_path):
    app = create_app(data_dir=tmp_path)
    with TestClient(app) as c:
        yield c


def post_pdf(client, data, filename="doc.pdf", title=None):
    form = {"title": title} if title else None
    return client.post(
        "/api/documents",
        files={"file": (filename, data, "application/pdf")},
        data=form,
    )


def assert_no_leftovers(data_dir):
    conn = sqlite3.connect(data_dir / "app.db")
    try:
        docs = conn.execute("SELECT COUNT(*) FROM documents").fetchone()[0]
        jobs = conn.execute("SELECT COUNT(*) FROM jobs").fetchone()[0]
    finally:
        conn.close()
    assert docs == 0 and jobs == 0
    assert list((data_dir / "storage").iterdir()) == []


def test_upload_limit_defaults_and_env(monkeypatch):
    assert Settings().max_upload_bytes == 20 * 1024 * 1024
    assert Settings().max_upload_pages == 100
    monkeypatch.setenv("MAX_UPLOAD_BYTES", "1024")
    monkeypatch.setenv("MAX_UPLOAD_PAGES", "2")
    s = Settings()
    assert s.max_upload_bytes == 1024 and s.max_upload_pages == 2


def test_documents_extra_columns_migration(tmp_path):
    db_path = init_db(tmp_path)
    init_db(tmp_path)
    conn = sqlite3.connect(db_path)
    try:
        cols = {r[1] for r in conn.execute("PRAGMA table_info(documents)")}
    finally:
        conn.close()
    assert {"file_hash", "file_size", "storage_path"} <= cols


def test_document_file_round_trip(tmp_path):
    storage = init_storage(tmp_path)
    path = save_document_file(storage, "doc-1", b"%PDF-x")
    assert resolve_document_path(storage, path.name).read_bytes() == b"%PDF-x"


def test_models_serialize():
    assert UploadResponse(document_id="d", job_id="j", status="queued").model_dump() == {
        "document_id": "d",
        "job_id": "j",
        "status": "queued",
    }
    assert JobStatusResponse(
        job_id="j", document_id="d", status="queued"
    ).model_dump() == {
        "job_id": "j",
        "document_id": "d",
        "status": "queued",
        "stage": None,
        "error": None,
        "execution_state": None,
    }
    record = DocumentRecord(
        documentId="d", filename="f.pdf", status="uploaded", createdAt="t"
    )
    assert record.pageCount is None and record.errorCode is None


def test_rejects_non_pdf(client, tmp_path, fixtures):
    resp = post_pdf(client, fixtures("not_a_pdf.pdf").read_bytes())
    assert resp.status_code == 422
    err = resp.json()["error"]
    assert err["code"] == "INVALID_FILE_TYPE" and err["retryable"] is False
    assert_no_leftovers(tmp_path)


def test_rejects_corrupt_pdf(client, tmp_path):
    resp = post_pdf(client, b"%PDF-1.4 not actually a pdf")
    assert resp.status_code == 422
    assert resp.json()["error"]["code"] == "PDF_UNREADABLE"
    assert_no_leftovers(tmp_path)


def test_rejects_encrypted_pdf(client, tmp_path):
    resp = post_pdf(client, encrypted_pdf())
    assert resp.status_code == 422
    assert resp.json()["error"]["code"] == "PDF_ENCRYPTED"
    assert_no_leftovers(tmp_path)


def test_rejects_empty_pdf(client, tmp_path):
    resp = post_pdf(client, EMPTY_PDF)
    assert resp.status_code == 422
    assert resp.json()["error"]["code"] == "DOCUMENT_EMPTY"
    assert_no_leftovers(tmp_path)


def test_rejects_oversize(tmp_path, monkeypatch):
    monkeypatch.setenv("MAX_UPLOAD_BYTES", "100")
    with TestClient(create_app(data_dir=tmp_path)) as client:
        resp = post_pdf(client, make_pdf())
    assert resp.status_code == 422
    assert resp.json()["error"]["code"] == "FILE_TOO_LARGE"
    assert_no_leftovers(tmp_path)


def test_rejects_too_many_pages(tmp_path, monkeypatch):
    monkeypatch.setenv("MAX_UPLOAD_PAGES", "1")
    with TestClient(create_app(data_dir=tmp_path)) as client:
        resp = post_pdf(client, make_pdf(pages=3))
    assert resp.status_code == 422
    err = resp.json()["error"]
    assert err["code"] == "TOO_MANY_PAGES" and "1" in err["message"]
    assert_no_leftovers(tmp_path)


def test_upload_sample_pdf_creates_rows(client, tmp_path, fixtures):
    sample = fixtures("PDF_SAMPLE.pdf").read_bytes()
    resp = post_pdf(client, sample, filename="PDF_SAMPLE.pdf", title="Sample")
    assert resp.status_code == 201
    body = resp.json()
    assert body["status"] == "queued" and body["document_id"] and body["job_id"]

    conn = sqlite3.connect(tmp_path / "app.db")
    try:
        doc = conn.execute(
            "SELECT status, page_count, file_hash, file_size, storage_path "
            "FROM documents WHERE document_id = ?",
            (body["document_id"],),
        ).fetchone()
        job = conn.execute(
            "SELECT status, stage, error FROM jobs WHERE job_id = ?", (body["job_id"],)
        ).fetchone()
    finally:
        conn.close()

    assert doc[0] == "uploaded" and doc[1] > 0
    assert len(doc[2]) == 64 and doc[3] == len(sample) and doc[4].endswith(".pdf")
    assert (tmp_path / "storage" / doc[4]).read_bytes() == sample
    assert job == ("queued", None, None)

    resp = client.get(f"/api/jobs/{body['job_id']}")
    assert resp.status_code == 200
    assert resp.json()["status"] == "queued"


def test_get_unknown_job_404(client):
    resp = client.get("/api/jobs/nope")
    assert resp.status_code == 404
    assert resp.json()["error"]["code"] == "NOT_FOUND"


def test_identical_upload_dedupes_file(client, tmp_path):
    data = make_pdf()
    first = post_pdf(client, data).json()
    second = post_pdf(client, data).json()

    assert first["document_id"] != second["document_id"]
    assert first["job_id"] != second["job_id"]

    conn = sqlite3.connect(tmp_path / "app.db")
    try:
        rows = conn.execute(
            "SELECT file_hash, storage_path FROM documents ORDER BY created_at"
        ).fetchall()
    finally:
        conn.close()
    assert len(rows) == 2
    assert rows[0] == rows[1]
    assert len(list((tmp_path / "storage").iterdir())) == 1
