"""Pipeline A graph nodes. Currently wired: extract (A02) -> index (A03).

Each node marks its stage on the job row at entry, does its work against
deterministic artifacts, and returns a partial PipelineState update. Domain
failures (e.g. ExtractionError) propagate untransformed so the runner can mark
the job failed; transient failures are raised as TransientStageError (or raw
transient types listed in TRANSIENT_ERRORS) for the node retry policy.
"""

import sqlite3
from datetime import datetime, timezone
from pathlib import Path

from app.config import Settings
from app.models.document import ExtractedDocument
from app.pipeline.state import PipelineState
from app.services.pdf_extractor import extract_document
from app.services.rag_indexer import index_document
from app.storage.documents import resolve_document_path


class TransientStageError(Exception):
    """A pipeline-stage failure worth retrying (locks, transient IO)."""


TRANSIENT_ERRORS = (TransientStageError, sqlite3.OperationalError)

STAGE_STATUS = {"extract": "extracting", "index": "indexing"}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def mark_stage(data_dir: Path, job_id: str, node: str) -> None:
    conn = sqlite3.connect(data_dir / "app.db", timeout=10)
    try:
        with conn:
            conn.execute(
                "UPDATE jobs SET status = ?, stage = ?, updated_at = ? WHERE job_id = ?",
                (STAGE_STATUS[node], node, _now(), job_id),
            )
    finally:
        conn.close()


def extraction_artifact_path(data_dir: Path, document_id: str) -> Path:
    return data_dir / "storage" / f"{document_id}.extracted.json"


def make_nodes(settings: Settings, data_dir: Path) -> dict:
    storage_dir = data_dir / "storage"

    def extract(state: PipelineState) -> dict:
        mark_stage(data_dir, state["job_id"], "extract")
        pdf_path = resolve_document_path(storage_dir, state["storage_path"])
        extracted = extract_document(state["document_id"], pdf_path)
        artifact = extraction_artifact_path(data_dir, state["document_id"])
        artifact.write_text(extracted.model_dump_json(), encoding="utf-8")
        return {
            "extracted_path": artifact.name,
            "page_count": extracted.page_count,
        }

    def index(state: PipelineState) -> dict:
        mark_stage(data_dir, state["job_id"], "index")
        artifact = storage_dir / state["extracted_path"]
        extracted = ExtractedDocument.model_validate_json(
            artifact.read_text(encoding="utf-8")
        )
        count = index_document(extracted, settings)
        return {"chunk_count": count}

    return {"extract": extract, "index": index}
