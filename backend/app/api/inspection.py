"""Read persisted pipeline output for the separate local review tool."""

import sqlite3

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from app.errors import error_body
from app.models.concept import ConceptInventory
from app.models.document import ExtractedDocument
from app.services.vector_store import get_collection
from app.storage.episodes import read_episode

router = APIRouter()


@router.get("/api/documents/{document_id}/inspection/{stage}")
def inspect_stage(document_id: str, stage: str, request: Request):
    if stage not in ("extraction", "index", "analysis", "episode"):
        return JSONResponse(status_code=404, content=error_body("NOT_FOUND", "Stage not found."))
    base = request.app.state.data_dir
    conn = sqlite3.connect(base / "app.db")
    try:
        exists = conn.execute("SELECT 1 FROM documents WHERE document_id = ?", (document_id,)).fetchone()
    finally:
        conn.close()
    if not exists:
        return JSONResponse(status_code=404, content=error_body("NOT_FOUND", "Document not found."))
    if stage == "index":
        result = get_collection(request.app.state.settings).get(where={"document_id": document_id}, include=["documents", "metadatas"])
        return {"ids": result["ids"], "documents": result["documents"], "metadatas": result["metadatas"]}
    if stage == "episode":
        try:
            return read_episode(base, document_id)
        except LookupError:
            return JSONResponse(status_code=404, content=error_body("NOT_FOUND", "Stage output is not available yet."))
    suffix, model = ("extracted", ExtractedDocument) if stage == "extraction" else ("concepts", ConceptInventory)
    path = base / "storage" / f"{document_id}.{suffix}.json"
    if not path.is_file():
        return JSONResponse(status_code=404, content=error_body("NOT_FOUND", "Stage output is not available yet."))
    return model.model_validate_json(path.read_text(encoding="utf-8"))
