import pytest

from app.models.curriculum import RoadmapEdit
from app.services.curriculum_review import apply_edit, estimated_minutes, lock_lesson, uncovered_concepts, warnings
from app.tests.test_curriculum_models import inventory, roadmap


def edit(value, concepts, pace=140, minutes=2):
    return RoadmapEdit.model_validate({"expected_revision": value.revision, "episodes": [{
        "episode_id": "e", "concept_ids": concepts, "words_per_minute": pace, "interaction_minutes": minutes}]})


def test_coverage_and_timing_update():
    source, value = inventory(), roadmap()
    source.concepts.append(source.concepts[0].model_copy(update={"id": "other"}))
    value.uncovered_reasons["other"] = "Outside the original scope"
    assert uncovered_concepts(value, source) == ["other"]
    updated = apply_edit(value, edit(value, ["c", "other"], pace=100, minutes=3), source)
    assert uncovered_concepts(updated, source) == []
    assert estimated_minutes(updated.episodes[0]) == 4
    assert updated.episodes[0].estimate_stale and warnings(updated.episodes[0])
    assert updated.episodes[0].objective_ids == ["o"]
    assert "other" not in updated.uncovered_reasons


def test_empty_or_unsupported_episode_cannot_lock():
    source, value = inventory(), roadmap()
    with pytest.raises(ValueError, match="at least one concept"):
        apply_edit(value, edit(value, []), source)
    value.episodes[0].objective_ids = []
    with pytest.raises(ValueError, match="supported objective"):
        lock_lesson(value, source)


def test_lock_preserves_order_and_excluded_scope():
    source, value = inventory(), roadmap()
    source.concepts.append(source.concepts[0].model_copy(update={"id": "other"}))
    locked = lock_lesson(value, source)
    assert locked.confirmed and locked.episodes[0].status == "selected"
    assert locked.lesson_context.excluded_concept_ids == ["other"]
    assert locked.lesson_context.teaching_order[0].basis == "inferred"


def test_coverage_counts_concept_assigned_to_multiple_episodes_once():
    source, value = inventory(), roadmap()
    value.episodes.append(value.episodes[0].model_copy(deep=True, update={"episode_id": "e2"}))
    assert uncovered_concepts(value, source) == []
    value.episodes[0].concepts.clear()
    assert uncovered_concepts(value, source) == []


def test_scope_warning_and_objectives_follow_edited_concepts():
    source, value = inventory(), roadmap()
    source.concepts.append(source.concepts[0].model_copy(update={"id": "other"}))
    updated = apply_edit(value, edit(value, ["other"], pace=10, minutes=2), source)
    assert updated.episodes[0].objective_ids == []
    assert any("too broad" in warning for warning in warnings(updated.episodes[0]))
    with pytest.raises(ValueError, match="supported objective"):
        lock_lesson(updated, source)
