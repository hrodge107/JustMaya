"""Contracts for roadmap review and the episode-one lesson lock."""

from typing import Literal

from pydantic import BaseModel, Field

from app.models.concept import Concept, ConceptInventory, Objective, Relationship, WebSupplement


class OrderedConcept(BaseModel):
    concept_id: str = Field(min_length=1)
    basis: Literal["source_relationship", "source_order", "inferred", "user"]
    explanation: str
    uncertainty: list[str] = []


class EpisodeOutline(BaseModel):
    episode_id: str = Field(min_length=1)
    title: str = Field(min_length=1)
    objective_ids: list[str]
    concepts: list[OrderedConcept]
    dialogue_words: int = Field(ge=0)
    words_per_minute: float = Field(gt=0, allow_inf_nan=False)
    interaction_minutes: float = Field(ge=0, allow_inf_nan=False)
    estimate_stale: bool = False
    status: Literal["planned_only", "selected"] = "planned_only"


class LessonContext(BaseModel):
    episode_id: str
    objectives: list[Objective]
    concepts: list[Concept]
    teaching_order: list[OrderedConcept]
    relationships: list[Relationship]
    supplements: list[WebSupplement]
    uncertainty: list[str]
    excluded_concept_ids: list[str]


class Roadmap(BaseModel):
    curriculum_id: str = Field(min_length=1)
    document_id: str = Field(min_length=1)
    revision: int = Field(ge=1)
    confirmed: bool = False
    episodes: list[EpisodeOutline] = Field(min_length=1, max_length=5)
    uncovered_reasons: dict[str, str] = {}
    lesson_context: LessonContext | None = None


class OutlineEdit(BaseModel):
    episode_id: str
    concept_ids: list[str]
    words_per_minute: float = Field(gt=0, allow_inf_nan=False)
    interaction_minutes: float = Field(ge=0, allow_inf_nan=False)


class RoadmapEdit(BaseModel):
    expected_revision: int = Field(ge=1)
    episodes: list[OutlineEdit] = Field(min_length=1, max_length=5)


class ConfirmRoadmap(BaseModel):
    expected_revision: int = Field(ge=1)


def validate_roadmap(roadmap: Roadmap, inventory: ConceptInventory) -> None:
    if roadmap.document_id != inventory.document_id:
        raise ValueError("Roadmap document does not match inventory")
    concept_ids = {item.id for item in inventory.concepts}
    objectives = {item.id: item for item in inventory.learning_objectives}
    episode_ids = [episode.episode_id for episode in roadmap.episodes]
    if len(episode_ids) != len(set(episode_ids)):
        raise ValueError("Duplicate episode ID")
    for episode in roadmap.episodes:
        selected = [item.concept_id for item in episode.concepts]
        if len(selected) != len(set(selected)) or not set(selected) <= concept_ids:
            raise ValueError("Invalid or duplicate concept ID")
        if len(episode.objective_ids) != len(set(episode.objective_ids)):
            raise ValueError("Duplicate objective ID")
        for objective_id in episode.objective_ids:
            objective = objectives.get(objective_id)
            if objective is None or not objective.concept_ids or not set(objective.concept_ids) <= set(selected):
                raise ValueError("Objective does not match episode concepts")
    if not set(roadmap.uncovered_reasons) <= concept_ids:
        raise ValueError("Unknown uncovered concept ID")
