import pytest

from app.models.concept import ConceptInventory, validate_inventory
from app.models.document import DocumentPage, DocumentSection, ExtractedDocument


@pytest.fixture
def document():
    return ExtractedDocument(document_id="d", page_count=2, pages=[
        DocumentPage(document_id="d", page_number=1, text="a"),
        DocumentPage(document_id="d", page_number=2, text="b"),
    ], sections=[DocumentSection(section_id="s", title="A", page_start=1, page_end=1)])


@pytest.fixture
def inventory():
    ref = {"document_id": "d", "page_start": 1, "page_end": 1, "section_id": "s"}
    return ConceptInventory.model_validate({
        "document_id": "d", "concepts": [{"id": "c", "title": "A", "explanation": "B", "evidence": [ref]}],
        "learning_objectives": [{"id": "o", "description": "Learn", "concept_ids": ["c"], "evidence": [ref]}],
        "prerequisite_edges": [], "coverage": [
            {"page_number": 1, "section_ids": ["s"], "textless": False, "insufficient": False},
            {"page_number": 2, "section_ids": [], "textless": False, "insufficient": False},
        ],
    })


def test_valid_inventory(document, inventory):
    validate_inventory(inventory, document)


@pytest.mark.parametrize("mutation", ["document", "page", "section", "entity", "coverage", "duplicate"])
def test_invalid_references_are_rejected(document, inventory, mutation):
    if mutation == "document":
        inventory.concepts[0].evidence[0].document_id = "other"
    elif mutation == "page":
        inventory.concepts[0].evidence[0].page_end = 3
    elif mutation == "section":
        inventory.concepts[0].evidence[0].section_id = "missing"
    elif mutation == "entity":
        inventory.learning_objectives[0].concept_ids = ["missing"]
    elif mutation == "coverage":
        inventory.coverage.pop()
    else:
        inventory.concepts.append(inventory.concepts[0])
    with pytest.raises(ValueError):
        validate_inventory(inventory, document)
