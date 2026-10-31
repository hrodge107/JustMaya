import pytest

from app.config import Settings
from app.models.curriculum import RoadmapEdit
from app.services.curriculum_review import apply_edit, build_lesson_context, detail_scope, estimated_minutes, lock_selection, uncovered_concepts, warnings
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
        lock_selection(value, source)


def test_lock_preserves_order_and_excluded_scope():
    source, value = inventory(), roadmap()
    source.concepts.append(source.concepts[0].model_copy(update={"id": "other"}))
    locked = lock_selection(value, source)
    assert locked.confirmed and locked.episodes[0].status == "selected"
    assert locked.lesson_context is None
    # The detail pass attaches the context; an inventory covering the locked
    # scope stands in for it here.
    context = build_lesson_context(locked, source, source)
    assert context.excluded_concept_ids == ["other"]
    assert context.teaching_order[0].basis == "inferred"


def test_coverage_counts_concept_assigned_to_multiple_episodes_once():
    source, value = inventory(), roadmap()
    value.episodes.append(value.episodes[0].model_copy(deep=True, update={"episode_id": "e2"}))
    assert uncovered_concepts(value, source) == []
    value.episodes[0].concepts.clear()
    assert uncovered_concepts(value, source) == []


def test_scope_warning_and_objectives_follow_edited_concepts():
    source, value = inventory(), roadmap()
    source.concepts.append(source.concepts[0].model_copy(update={"id": "other"}))
    updated = apply_edit(value, edit(value, ["other"], pace=10, minutes=3), source)
    assert updated.episodes[0].objective_ids == []
    assert any("too broad" in warning for warning in warnings(updated.episodes[0]))
    with pytest.raises(ValueError, match="supported objective"):
        lock_selection(updated, source)


def test_duration_warning_threshold_is_twelve_minutes():
    value = roadmap()
    episode = value.episodes[0]
    episode.dialogue_words = 1120  # 1120/140 + 2 = 10 minutes — on target, silent
    assert not any("too broad" in w for w in warnings(episode))
    episode.dialogue_words = 1540  # 1540/140 + 2 = 13 minutes — warns
    assert any("too broad" in w for w in warnings(episode))


def _scope_inventory(pages_by_concept):
    from app.models.concept import ConceptInventory
    return ConceptInventory.model_validate({
        "document_id": "d",
        "concepts": [
            {"id": cid, "title": cid, "explanation": "x",
             "evidence": [] if page is None else
             [{"document_id": "d", "page_start": page, "page_end": page, "section_id": None}]}
            for cid, page in pages_by_concept.items()
        ],
        "learning_objectives": [{"id": "o", "description": "Learn",
                                 "concept_ids": list(pages_by_concept), "evidence": []}],
        "prerequisite_edges": [],
        "coverage": [{"page_number": n, "section_ids": [], "textless": False,
                      "insufficient": False} for n in range(1, 11)],
    })


def _scope_roadmap(concept_ids):
    value = roadmap()
    value.episodes[0].concepts = [
        value.episodes[0].concepts[0].model_copy(update={"concept_id": cid})
        for cid in concept_ids
    ]
    return value


def test_detail_scope_unions_evidence_pages_with_margin():
    source = _scope_inventory({"c": 3, "other": 7})
    scope = detail_scope(_scope_roadmap(["c", "other"]), source,
                         Settings(meta_api_key="t", detail_context_margin_pages=1))
    assert scope == {2, 3, 4, 6, 7, 8}


def test_detail_scope_margin_clamps_at_document_edge():
    source = _scope_inventory({"c": 1})
    scope = detail_scope(_scope_roadmap(["c"]), source,
                         Settings(meta_api_key="t", detail_context_margin_pages=2))
    assert scope == {1, 2, 3}


def test_detail_scope_empty_and_over_cap_fail_actionably():
    source = _scope_inventory({"c": 3})
    empty = _scope_inventory({"c": None})
    with pytest.raises(ValueError, match="DETAIL_SCOPE_EMPTY"):
        detail_scope(_scope_roadmap(["c"]), empty, Settings(meta_api_key="t"))
    with pytest.raises(ValueError, match="DETAIL_SCOPE_TOO_LARGE"):
        detail_scope(_scope_roadmap(["c"]), source,
                     Settings(meta_api_key="t", detail_scope_max_pages=2))
