"""Pipeline A graph nodes: extract (A02), index (A03), analyze (A04),
plan (A05/A06), generate (A07).

Each node marks its stage on the job row at entry, does its work against
deterministic artifacts, and returns a partial PipelineState update. Domain
failures (e.g. ExtractionError) propagate untransformed so the runner can mark
the job failed; transient failures are raised as TransientStageError (or raw
transient types listed in TRANSIENT_ERRORS) for the node retry policy.
"""

import asyncio
import os
import sqlite3
import tempfile
from datetime import datetime, timezone
from pathlib import Path

from app.config import Settings
from app.models.document import ExtractedDocument
from app.models.concept import ConceptInventory
from app.pipeline.state import PipelineState
from app.services.pdf_extractor import extract_document
from app.services.rag_indexer import index_document
from app.services.concept_analyzer import analyze_document
from app.services.curriculum_planner import plan_curriculum
from app.services.episode_generator import (
    GenerationError,
    generate_episode,
    passages_for_lesson,
)
from app.services.episode_validator import (
    ValidationFailed,
    report_passing,
    validate_and_publish,
)
from app.services.model_provider import MetaProvider
from app.services.token_budget import MeteredProvider
from app.storage.documents import resolve_document_path
from app.storage.curriculum import read_draft, save_draft
from app.storage.episodes import (
    read_episode,
    read_episode_state,
    save_episode_draft,
)


class TransientStageError(Exception):
    """A pipeline-stage failure worth retrying (locks, transient IO)."""


TRANSIENT_ERRORS = (TransientStageError, sqlite3.OperationalError)

STAGE_STATUS = {"extract": "extracting", "index": "indexing", "analyze": "analyzing", "plan": "planning", "generate": "generating", "validate": "validating"}


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

    def _write_atomic(artifact: Path, payload: str) -> None:
        temporary = None
        try:
            with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=storage_dir, delete=False) as handle:
                temporary = Path(handle.name)
                handle.write(payload)
            os.replace(temporary, artifact)
        finally:
            if temporary is not None:
                temporary.unlink(missing_ok=True)

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

    def analyze(state: PipelineState) -> dict:
        mark_stage(data_dir, state["job_id"], "analyze")
        extracted = ExtractedDocument.model_validate_json((storage_dir / state["extracted_path"]).read_text(encoding="utf-8"))
        provider = MeteredProvider(MetaProvider(settings), settings, data_dir)
        inventory = asyncio.run(analyze_document(extracted, provider, state["job_id"], settings=settings, data_dir=data_dir))
        artifact = storage_dir / f"{state['document_id']}.concepts.json"
        _write_atomic(artifact, inventory.model_dump_json())
        return {"inventory_path": artifact.name}

    def plan(state: PipelineState) -> dict:
        mark_stage(data_dir, state["job_id"], "plan")
        try:
            existing, _, job_id = read_draft(data_dir, state["document_id"])
        except LookupError:
            existing = None
        if existing is not None:
            if job_id != state["job_id"]:
                raise ValueError("Roadmap belongs to a different job")
            return {"curriculum_id": existing.curriculum_id}
        inventory = ConceptInventory.model_validate_json((storage_dir / state["inventory_path"]).read_text(encoding="utf-8"))
        provider = MeteredProvider(MetaProvider(settings), settings, data_dir)
        roadmap = asyncio.run(plan_curriculum(inventory, provider, state["job_id"], settings))
        save_draft(data_dir, roadmap, inventory, state["job_id"])
        return {"curriculum_id": roadmap.curriculum_id}

    def generate(state: PipelineState) -> dict:
        try:
            roadmap, _, owner = read_draft(data_dir, state["document_id"])
        except LookupError:
            raise GenerationError("ROADMAP_NOT_CONFIRMED: no roadmap exists")
        if owner != state["job_id"]:
            raise ValueError("Roadmap belongs to a different job")
        if not roadmap.confirmed or roadmap.lesson_context is None:
            # Draft still awaits human review — park for END/awaiting_review;
            # the confirmed resume path after confirm_draft runs the real work.
            return {}
        mark_stage(data_dir, state["job_id"], "generate")
        passages, known_chunks = passages_for_lesson(
            state["document_id"], roadmap.lesson_context, settings
        )
        provider = MeteredProvider(MetaProvider(settings), settings, data_dir)
        script = asyncio.run(
            generate_episode(
                roadmap,
                roadmap.lesson_context,
                passages,
                known_chunks,
                provider,
                state["job_id"],
                settings,
            )
        )
        artifact = storage_dir / f"{state['document_id']}.{script.episodeId}.script.json"
        _write_atomic(artifact, script.model_dump_json())
        save_episode_draft(data_dir, script, roadmap.curriculum_id)
        return {"episode_id": script.episodeId}

    def validate(state: PipelineState) -> dict:
        try:
            roadmap, _, owner = read_draft(data_dir, state["document_id"])
        except LookupError:
            roadmap = None
        if (
            roadmap is None
            or owner != state["job_id"]
            or not roadmap.confirmed
            or roadmap.lesson_context is None
        ):
            # Parked for review or nothing generated yet — same early-exit
            # contract as the generate node.
            return {}
        existing = read_episode_state(data_dir, state["document_id"])
        if existing is not None and existing["status"] == "ready":
            # Idempotent re-execution: already published — no re-spend.
            script = read_episode(data_dir, state["document_id"])
            return {"episode_id": script.episodeId}
        mark_stage(data_dir, state["job_id"], "validate")
        try:
            script = read_episode(data_dir, state["document_id"])
        except LookupError:
            raise ValidationFailed(
                "VALIDATION_NO_EPISODE: no episode draft exists"
            )
        passages, known_chunks = passages_for_lesson(
            state["document_id"], roadmap.lesson_context, settings
        )
        provider = MeteredProvider(MetaProvider(settings), settings, data_dir)
        script, report = asyncio.run(
            validate_and_publish(
                data_dir,
                script,
                roadmap,
                roadmap.lesson_context,
                passages,
                known_chunks,
                provider,
                state["job_id"],
                settings,
            )
        )
        artifact = storage_dir / f"{state['document_id']}.{script.episodeId}.script.json"
        _write_atomic(artifact, script.model_dump_json())
        if not report_passing(report):
            failures = report.deterministic_violations or [
                f"{v.check}: {v.detail}"
                for v in (report.semantic.violations if report.semantic else [])
            ]
            raise ValidationFailed(
                "Episode failed validation: " + "; ".join(failures)
            )
        return {"episode_id": script.episodeId}

    return {"extract": extract, "index": index, "analyze": analyze, "plan": plan, "generate": generate, "validate": validate}
