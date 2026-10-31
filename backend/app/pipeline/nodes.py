"""Pipeline A stages: extract (A02), index (A03), analyze/survey (A04),
plan (A05/A06), detail (confirmed-scope deep analysis), generate (A07),
validate (A08).

Each stage is a declared `Stage(name, run)` in STAGES; run(ctx, state)
does its work against deterministic artifacts and returns a partial
PipelineState update. Dependencies arrive through the injected
StageContext; `mark_stage` stays inside each run because its position
relative to the roadmap guard is stage semantics (plan marks before the
guard; generate/validate guard first so parking never marks). Domain
failures (e.g. ExtractionError) propagate untransformed so the runner can
mark the job failed; transient failures are raised as TransientStageError
(or raw transient types listed in TRANSIENT_ERRORS) for the node retry
policy.
"""

import asyncio
import sqlite3
from functools import partial

from app.models.document import ExtractedDocument
from app.models.concept import ConceptInventory
from app.pipeline.stage import Stage, StageContext
from app.pipeline.state import PipelineState
from app.services.curriculum_review import build_lesson_context, detail_scope
from app.services.episode_generator import GenerationError, passages_for_lesson
from app.services.episode_validator import ValidationFailed, report_passing
from app.storage.curriculum import attach_lesson_context, save_draft
from app.storage.documents import resolve_document_path
from app.storage.episodes import read_episode, read_episode_state, save_episode_draft
from app.storage.jobs import mark_stage


class TransientStageError(Exception):
    """A pipeline-stage failure worth retrying (locks, transient IO)."""


TRANSIENT_ERRORS = (TransientStageError, sqlite3.OperationalError)


def _extract(ctx: StageContext, state: PipelineState) -> dict:
    mark_stage(ctx.data_dir, state["job_id"], "extract")
    pdf_path = resolve_document_path(ctx.storage_dir, state["storage_path"])
    extracted = ctx.services.extract_document(state["document_id"], pdf_path)
    artifact = ctx.artifacts.save(
        state["document_id"], "extracted", extracted.model_dump_json()
    )
    return {
        "extracted_path": artifact.name,
        "page_count": extracted.page_count,
    }


def _index(ctx: StageContext, state: PipelineState) -> dict:
    mark_stage(ctx.data_dir, state["job_id"], "index")
    extracted = ctx.artifacts.load(state["extracted_path"], ExtractedDocument)
    count = ctx.services.index_document(extracted, ctx.settings)
    return {"chunk_count": count}


def _analyze(ctx: StageContext, state: PipelineState) -> dict:
    mark_stage(ctx.data_dir, state["job_id"], "analyze")
    extracted = ctx.artifacts.load(state["extracted_path"], ExtractedDocument)
    inventory = asyncio.run(
        ctx.services.survey_document(
            extracted, ctx.provider, state["job_id"],
            settings=ctx.settings, data_dir=ctx.data_dir,
        )
    )
    artifact = ctx.artifacts.save(
        state["document_id"], "concepts", inventory.model_dump_json()
    )
    return {"inventory_path": artifact.name}


def _plan(ctx: StageContext, state: PipelineState) -> dict:
    mark_stage(ctx.data_dir, state["job_id"], "plan")
    check = ctx.roadmap_guard(state["document_id"], state["job_id"])
    if check.draft is not None:
        if check.foreign:
            raise ValueError("Roadmap belongs to a different job")
        return {"curriculum_id": check.draft.curriculum_id}
    inventory = ctx.artifacts.load(state["inventory_path"], ConceptInventory)
    roadmap = asyncio.run(
        ctx.services.plan_curriculum(
            inventory, ctx.provider, state["job_id"], ctx.settings
        )
    )
    save_draft(ctx.data_dir, roadmap, inventory, state["job_id"])
    return {"curriculum_id": roadmap.curriculum_id}


def _detail(ctx: StageContext, state: PipelineState) -> dict:
    check = ctx.roadmap_guard(state["document_id"], state["job_id"])
    if check.draft is None:
        # Nothing planned yet — park like validate; plan always runs first.
        return {}
    if check.foreign:
        raise ValueError("Roadmap belongs to a different job")
    if check.draft.lesson_context is not None:
        # Idempotent re-execution: context already built — no re-spend.
        return {"curriculum_id": check.draft.curriculum_id}
    if not check.draft.confirmed:
        # Draft still awaits human review — park like generate.
        return {}
    mark_stage(ctx.data_dir, state["job_id"], "detail")
    extracted = ctx.artifacts.load(state["extracted_path"], ExtractedDocument)
    survey = ctx.artifacts.load(state["inventory_path"], ConceptInventory)
    scope = detail_scope(check.draft, survey, ctx.settings)
    detail = asyncio.run(
        ctx.services.detail_analysis(
            extracted, check.draft, survey, scope,
            ctx.provider, state["job_id"],
            settings=ctx.settings, data_dir=ctx.data_dir,
        )
    )
    ctx.artifacts.save(
        state["document_id"], "concepts-detail", detail.model_dump_json()
    )
    context = build_lesson_context(check.draft, detail, survey)
    attach_lesson_context(ctx.data_dir, state["document_id"], context)
    return {"curriculum_id": check.draft.curriculum_id}


def _generate(ctx: StageContext, state: PipelineState) -> dict:
    check = ctx.roadmap_guard(state["document_id"], state["job_id"])
    if check.draft is None:
        raise GenerationError("ROADMAP_NOT_CONFIRMED: no roadmap exists")
    if check.foreign:
        raise ValueError("Roadmap belongs to a different job")
    if not check.usable:
        # Draft still awaits human review — park for END/awaiting_review;
        # the confirmed resume path after confirm_draft runs the real work.
        return {}
    roadmap = check.draft
    mark_stage(ctx.data_dir, state["job_id"], "generate")
    passages, known_chunks = passages_for_lesson(
        state["document_id"], roadmap.lesson_context, ctx.settings
    )
    script = asyncio.run(
        ctx.services.generate_episode(
            roadmap,
            roadmap.lesson_context,
            passages,
            known_chunks,
            ctx.provider,
            state["job_id"],
            ctx.settings,
        )
    )
    ctx.artifacts.save(
        state["document_id"], "script", script.model_dump_json(),
        episode_id=script.episodeId,
    )
    save_episode_draft(ctx.data_dir, script, roadmap.curriculum_id)
    return {"episode_id": script.episodeId}


def _validate(ctx: StageContext, state: PipelineState) -> dict:
    check = ctx.roadmap_guard(state["document_id"], state["job_id"])
    if check.draft is None or check.foreign or not check.usable:
        # Parked for review or nothing generated yet — same early-exit
        # contract as the generate node.
        return {}
    roadmap = check.draft
    existing = read_episode_state(ctx.data_dir, state["document_id"])
    if existing is not None and existing["status"] == "ready":
        # Idempotent re-execution: already published — no re-spend.
        script = read_episode(ctx.data_dir, state["document_id"])
        return {"episode_id": script.episodeId}
    mark_stage(ctx.data_dir, state["job_id"], "validate")
    try:
        script = read_episode(ctx.data_dir, state["document_id"])
    except LookupError:
        raise ValidationFailed(
            "VALIDATION_NO_EPISODE: no episode draft exists"
        )
    passages, known_chunks = passages_for_lesson(
        state["document_id"], roadmap.lesson_context, ctx.settings
    )
    script, report = asyncio.run(
        ctx.services.validate_and_publish(
            ctx.data_dir,
            script,
            roadmap,
            roadmap.lesson_context,
            passages,
            known_chunks,
            ctx.provider,
            state["job_id"],
            ctx.settings,
        )
    )
    ctx.artifacts.save(
        state["document_id"], "script", script.model_dump_json(),
        episode_id=script.episodeId,
    )
    if not report_passing(report):
        failures = report.deterministic_violations or [
            f"{v.check}: {v.detail}"
            for v in (report.semantic.violations if report.semantic else [])
        ]
        raise ValidationFailed(
            "Episode failed validation: " + "; ".join(failures)
        )
    return {"episode_id": script.episodeId}


STAGES = (
    Stage("extract", _extract),
    Stage("index", _index),
    Stage("analyze", _analyze),
    Stage("plan", _plan),
    Stage("detail", _detail),
    Stage("generate", _generate),
    Stage("validate", _validate),
)


def make_nodes(ctx: StageContext) -> dict:
    return {stage.name: partial(stage.run, ctx) for stage in STAGES}
