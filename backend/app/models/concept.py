"""Source-grounded lesson ingredients produced by document analysis."""

from typing import Literal

from pydantic import BaseModel, Field

from app.models.document import ExtractedDocument


class Evidence(BaseModel):
    document_id: str
    page_start: int = Field(ge=1)
    page_end: int = Field(ge=1)
    section_id: str | None = None


class Concept(BaseModel):
    id: str
    title: str
    explanation: str
    evidence: list[Evidence]
    examples: list[str] = []
    misconceptions: list[str] = []
    uncertainty: list[str] = []
    evidence_gaps: list[str] = []


class Objective(BaseModel):
    id: str
    description: str
    concept_ids: list[str]
    evidence: list[Evidence]


class Relationship(BaseModel):
    source_id: str
    target_id: str
    kind: Literal["prerequisite", "cause_effect"]
    explanation: str
    evidence: list[Evidence]


class Coverage(BaseModel):
    page_number: int
    section_ids: list[str]
    textless: bool
    insufficient: bool


class WebSupplement(BaseModel):
    origin: Literal["web"] = "web"
    title: str
    url: str
    retrieved_at: str
    summary: str
    page_numbers: list[int]


class ConceptInventory(BaseModel):
    document_id: str
    subject: str | None = None
    audience: str | None = None
    complexity: str | None = None
    concepts: list[Concept]
    learning_objectives: list[Objective]
    prerequisite_edges: list[Relationship]
    coverage: list[Coverage]
    supplements: list[WebSupplement] = []
    uncertainty: list[str] = []


def validate_inventory(inventory: ConceptInventory, document: ExtractedDocument) -> None:
    """Reject dangling links and references outside the extracted document."""
    if inventory.document_id != document.document_id:
        raise ValueError("Inventory document ID does not match extraction")
    sections = {section.section_id: section for section in document.sections}
    ids = [concept.id for concept in inventory.concepts]
    if len(ids) != len(set(ids)) or any(not value for value in ids):
        raise ValueError("Concept IDs must be unique and nonempty")
    objective_ids = [objective.id for objective in inventory.learning_objectives]
    if len(objective_ids) != len(set(objective_ids)) or any(not value for value in objective_ids):
        raise ValueError("Objective IDs must be unique and nonempty")
    refs = []
    for concept in inventory.concepts:
        refs.extend(concept.evidence)
    for objective in inventory.learning_objectives:
        if not set(objective.concept_ids).issubset(ids):
            raise ValueError("Objective references an unknown concept")
        refs.extend(objective.evidence)
    for edge in inventory.prerequisite_edges:
        if edge.source_id not in ids or edge.target_id not in ids:
            raise ValueError("Relationship references an unknown concept")
        refs.extend(edge.evidence)
    for ref in refs:
        if ref.document_id != document.document_id or not (1 <= ref.page_start <= ref.page_end <= document.page_count):
            raise ValueError("Invalid document evidence reference")
        if ref.section_id is not None:
            section = sections.get(ref.section_id)
            if section is None or not (section.page_start <= ref.page_start <= ref.page_end <= section.page_end):
                raise ValueError("Invalid section evidence reference")
    expected_pages = set(range(1, document.page_count + 1))
    if len(inventory.coverage) != document.page_count or {c.page_number for c in inventory.coverage} != expected_pages:
        raise ValueError("Coverage must contain every page exactly once")
    for coverage in inventory.coverage:
        for section_id in coverage.section_ids:
            section = sections.get(section_id)
            if section is None or not section.page_start <= coverage.page_number <= section.page_end:
                raise ValueError("Invalid coverage section")
    for supplement in inventory.supplements:
        if not set(supplement.page_numbers).issubset(expected_pages):
            raise ValueError("Invalid supplement page")
