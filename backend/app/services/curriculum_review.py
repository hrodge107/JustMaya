"""Deterministic roadmap review and lesson-context preparation."""

from app.models.concept import ConceptInventory
from app.models.curriculum import LessonContext, OrderedConcept, Roadmap, RoadmapEdit, validate_roadmap


def uncovered_concepts(roadmap: Roadmap, inventory: ConceptInventory) -> list[str]:
    assigned = {item.concept_id for episode in roadmap.episodes for item in episode.concepts}
    return [item.id for item in inventory.concepts if item.id not in assigned]


def estimated_minutes(episode) -> float:
    return episode.dialogue_words / episode.words_per_minute + episode.interaction_minutes


def warnings(episode) -> list[str]:
    result = []
    if episode.estimate_stale:
        result.append("The word estimate predates the scope change.")
    if estimated_minutes(episode) > 10:
        result.append("This episode may be too broad for its target duration.")
    return result


def apply_edit(roadmap: Roadmap, edit: RoadmapEdit, inventory: ConceptInventory) -> Roadmap:
    if roadmap.confirmed or edit.expected_revision != roadmap.revision:
        raise ValueError("Roadmap is locked or revision is stale")
    result = roadmap.model_copy(deep=True)
    by_id = {item.episode_id: item for item in edit.episodes}
    if len(by_id) != len(edit.episodes) or set(by_id) != {item.episode_id for item in result.episodes}:
        raise ValueError("Edit must contain each episode exactly once")
    for episode in result.episodes:
        update = by_id[episode.episode_id]
        previous = [item.concept_id for item in episode.concepts]
        if update.concept_ids != previous:
            if set(update.concept_ids) != set(previous):
                episode.estimate_stale = True
                for concept_id in set(update.concept_ids).symmetric_difference(previous):
                    result.uncovered_reasons.pop(concept_id, None)
            episode.concepts = [OrderedConcept(concept_id=cid, basis="user", explanation="Changed during review")
                                for cid in update.concept_ids]
            selected = set(update.concept_ids)
            episode.objective_ids = [obj.id for obj in inventory.learning_objectives
                                     if obj.concept_ids and set(obj.concept_ids) <= selected]
        episode.words_per_minute = update.words_per_minute
        episode.interaction_minutes = update.interaction_minutes
    if not result.episodes[0].concepts:
        raise ValueError("Episode 1 needs at least one concept")
    result.revision += 1
    validate_roadmap(result, inventory)
    return result


def lock_lesson(roadmap: Roadmap, inventory: ConceptInventory) -> Roadmap:
    validate_roadmap(roadmap, inventory)
    first = roadmap.episodes[0]
    if not first.concepts or not first.objective_ids:
        raise ValueError("Episode 1 needs concepts and at least one supported objective")
    result = roadmap.model_copy(deep=True)
    first = result.episodes[0]
    first.status = "selected"
    selected = {item.concept_id for item in first.concepts}
    concepts = {item.id: item for item in inventory.concepts}
    objectives = {item.id: item for item in inventory.learning_objectives}
    pages = {page for cid in selected for ref in concepts[cid].evidence
             for page in range(ref.page_start, ref.page_end + 1)}
    result.lesson_context = LessonContext(
        episode_id=first.episode_id, objectives=[objectives[oid] for oid in first.objective_ids],
        concepts=[concepts[item.concept_id] for item in first.concepts], teaching_order=first.concepts,
        relationships=[edge for edge in inventory.prerequisite_edges if edge.source_id in selected and edge.target_id in selected],
        supplements=[item for item in inventory.supplements if pages.intersection(item.page_numbers)],
        uncertainty=inventory.uncertainty, excluded_concept_ids=[item.id for item in inventory.concepts if item.id not in selected],
    )
    result.confirmed = True
    return result
