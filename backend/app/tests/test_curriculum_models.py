import pytest
from pydantic import ValidationError

from app.models.concept import ConceptInventory
from app.models.curriculum import Roadmap, validate_roadmap


def inventory():
    return ConceptInventory.model_validate({
        "document_id": "d", "concepts": [{"id": "c", "title": "A", "explanation": "B", "evidence": []}],
        "learning_objectives": [{"id": "o", "description": "Learn", "concept_ids": ["c"], "evidence": []}],
        "prerequisite_edges": [], "coverage": [],
    })


def roadmap():
    return Roadmap.model_validate({"curriculum_id": "r", "document_id": "d", "revision": 1, "episodes": [{
        "episode_id": "e", "title": "A", "objective_ids": ["o"],
        "concepts": [{"concept_id": "c", "basis": "inferred", "explanation": "Suggested", "uncertainty": ["Unverified"]}],
        "dialogue_words": 100, "words_per_minute": 140, "interaction_minutes": 2,
    }]})


def test_valid_roadmap_preserves_inference():
    value = roadmap()
    validate_roadmap(value, inventory())
    assert value.episodes[0].concepts[0].basis == "inferred"
    assert value.episodes[0].concepts[0].uncertainty == ["Unverified"]


@pytest.mark.parametrize("change", ["concept", "objective", "duplicate", "document"])
def test_invalid_links_rejected(change):
    value = roadmap()
    if change == "concept":
        value.episodes[0].concepts[0].concept_id = "missing"
    elif change == "objective":
        value.episodes[0].objective_ids = ["missing"]
    elif change == "duplicate":
        value.episodes[0].concepts.append(value.episodes[0].concepts[0])
    else:
        value.document_id = "other"
    with pytest.raises(ValueError):
        validate_roadmap(value, inventory())


@pytest.mark.parametrize("field,value", [("words_per_minute", 0), ("interaction_minutes", -1), ("dialogue_words", -1)])
def test_invalid_timing_rejected(field, value):
    data = roadmap().model_dump()
    data["episodes"][0][field] = value
    with pytest.raises(ValidationError):
        Roadmap.model_validate(data)
