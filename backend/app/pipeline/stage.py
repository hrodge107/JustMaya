"""Stage contract: declared stage set + injectable dependency context.

Every pipeline stage is a `Stage(name, run)` where `run(ctx, state)`
returns a partial PipelineState update. `StageContext` carries everything
a stage needs — settings, storage paths, the shared metered provider, the
stage services, and the roadmap guard — built once per graph so node
bodies never assemble their own dependencies and tests inject through one
public seam. Treat a built context as read-only.
"""

from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any, NamedTuple

from app.config import Settings
from app.models.curriculum import Roadmap
from app.pipeline.state import PipelineState
from app.services.concept_analyzer import detail_analysis, survey_document
from app.services.curriculum_planner import plan_curriculum
from app.services.episode_generator import generate_episode
from app.services.episode_validator import validate_and_publish
from app.services.model_provider import GenerationProvider, MetaProvider
from app.services.pdf_extractor import extract_document
from app.services.rag_indexer import index_document
from app.services.token_budget import MeteredProvider
from app.storage.artifacts import ArtifactStore
from app.storage.curriculum import read_draft


class Stage(NamedTuple):
    name: str
    run: Callable[["StageContext", PipelineState], dict[str, Any]]


@dataclass(frozen=True)
class StageServices:
    """Stage-service callables tests may substitute; frozen so
    `dataclasses.replace` yields per-test overrides."""

    extract_document: Callable = extract_document
    index_document: Callable = index_document
    survey_document: Callable = survey_document
    plan_curriculum: Callable = plan_curriculum
    detail_analysis: Callable = detail_analysis
    generate_episode: Callable = generate_episode
    validate_and_publish: Callable = validate_and_publish


class RoadmapCheck(NamedTuple):
    draft: Roadmap | None = None
    foreign: bool = False
    usable: bool = False


def roadmap_guard(data_dir: Path, document_id: str, job_id: str) -> RoadmapCheck:
    """One shared draft read; each stage maps the result to its own
    outcome (idempotent return / domain error / park)."""
    try:
        draft, _, owner = read_draft(data_dir, document_id)
    except LookupError:
        return RoadmapCheck()
    return RoadmapCheck(
        draft=draft,
        foreign=owner != job_id,
        usable=draft.confirmed and draft.lesson_context is not None,
    )


class StageContext:
    """Dependency bundle shared by every stage in a run."""

    def __init__(
        self,
        settings: Settings,
        data_dir: Path,
        *,
        provider: GenerationProvider | None = None,
        services: StageServices | None = None,
    ):
        self.settings = settings
        self.data_dir = data_dir
        self.storage_dir = data_dir / "storage"
        self.artifacts = ArtifactStore(self.storage_dir)
        self.provider = MeteredProvider(
            provider if provider is not None else MetaProvider(settings),
            settings,
            data_dir,
        )
        self.services = services if services is not None else StageServices()

    def roadmap_guard(self, document_id: str, job_id: str) -> RoadmapCheck:
        return roadmap_guard(self.data_dir, document_id, job_id)
