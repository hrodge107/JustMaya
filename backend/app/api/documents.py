import hashlib
import sqlite3
import uuid
from datetime import datetime, timezone

import pymupdf
from fastapi import APIRouter, Form, Request, UploadFile
from fastapi.responses import JSONResponse

from app.config import Settings
from app.errors import error_body
from app.models.document import UploadResponse
from app.storage.documents import save_document_file

router = APIRouter()


class UploadRejection(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


def validate_pdf(data: bytes, settings: Settings) -> int:
    """Return the page count, or raise UploadRejection with a stable error code."""
    if len(data) > settings.max_upload_bytes:
        raise UploadRejection(
            "FILE_TOO_LARGE",
            f"File exceeds the {settings.max_upload_bytes // (1024 * 1024)} MB upload limit.",
        )
    if not data.startswith(b"%PDF"):
        raise UploadRejection("INVALID_FILE_TYPE", "File is not a PDF.")
    try:
        doc = pymupdf.open(stream=data, filetype="pdf")
    except Exception:
        raise UploadRejection("PDF_UNREADABLE", "File could not be parsed as a PDF.")
    with doc:
        if doc.needs_pass or doc.is_encrypted:
            raise UploadRejection(
                "PDF_ENCRYPTED", "PDF is password-protected; remove the password and retry."
            )
        if doc.page_count == 0:
            raise UploadRejection("DOCUMENT_EMPTY", "PDF contains no pages.")
        if doc.page_count > settings.max_upload_pages:
            raise UploadRejection(
                "TOO_MANY_PAGES",
                f"PDF has {doc.page_count} pages; limit is {settings.max_upload_pages}.",
            )
        return doc.page_count


@router.post("/api/documents", status_code=201)
async def upload_document(
    request: Request,
    file: UploadFile,
    title: str | None = Form(default=None),
) -> UploadResponse:
    settings: Settings = request.app.state.settings
    data_dir = request.app.state.data_dir

    data = await file.read()
    try:
        page_count = validate_pdf(data, settings)
    except UploadRejection as exc:
        return JSONResponse(status_code=422, content=error_body(exc.code, exc.message))

    file_hash = hashlib.sha256(data).hexdigest()
    document_id = uuid.uuid4().hex
    job_id = uuid.uuid4().hex
    now = datetime.now(timezone.utc).isoformat()

    storage_dir = data_dir / "storage"
    conn = sqlite3.connect(data_dir / "app.db")
    try:
        existing = conn.execute(
            "SELECT storage_path FROM documents WHERE file_hash = ?", (file_hash,)
        ).fetchone()
        if existing:
            storage_path = existing[0]
        else:
            storage_path = save_document_file(storage_dir, document_id, data).name
        with conn:
            conn.execute(
                "INSERT INTO documents (document_id, filename, status, page_count, "
                "file_hash, file_size, storage_path, created_at) "
                "VALUES (?, ?, 'uploaded', ?, ?, ?, ?, ?)",
                (
                    document_id,
                    title or file.filename or "document.pdf",
                    page_count,
                    file_hash,
                    len(data),
                    storage_path,
                    now,
                ),
            )
            conn.execute(
                "INSERT INTO jobs (job_id, document_id, status, created_at, updated_at) "
                "VALUES (?, ?, 'queued', ?, ?)",
                (job_id, document_id, now, now),
            )
    except Exception:
        if not existing:
            (storage_dir / storage_path).unlink(missing_ok=True)
        raise
    finally:
        conn.close()

    return UploadResponse(document_id=document_id, job_id=job_id, status="queued")
