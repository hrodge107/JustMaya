from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from app.errors import error_body
from app.models.curriculum import ConfirmRoadmap, RoadmapEdit
from app.services.curriculum_review import estimated_minutes, uncovered_concepts, warnings
from app.storage.curriculum import RoadmapConflict, confirm_draft, read_draft, update_draft

router = APIRouter()


def _response(data_dir, document_id):
    roadmap, inventory, _ = read_draft(data_dir, document_id)
    result = roadmap.model_dump(exclude={"lesson_context"})
    concepts = {item.id: {"id": item.id, "title": item.title, "uncertainty": item.uncertainty} for item in inventory.concepts}
    result["concepts"] = list(concepts.values())
    result["objectives"] = [{"id": item.id, "description": item.description} for item in inventory.learning_objectives]
    result["uncovered_concept_ids"] = uncovered_concepts(roadmap, inventory)
    for output, episode in zip(result["episodes"], roadmap.episodes):
        output["estimated_minutes"] = estimated_minutes(episode)
        output["warnings"] = warnings(episode)
    return result


def _error(exc):
    if isinstance(exc, LookupError):
        return JSONResponse(status_code=404, content=error_body("NOT_FOUND", "Roadmap not found."))
    if isinstance(exc, RoadmapConflict):
        return JSONResponse(status_code=409, content=error_body("ROADMAP_CONFLICT", str(exc)))
    return JSONResponse(status_code=422, content=error_body("INVALID_ROADMAP", str(exc)))


@router.get("/api/documents/{document_id}/curriculum")
def get_curriculum(document_id: str, request: Request):
    try:
        return _response(request.app.state.data_dir, document_id)
    except LookupError as exc:
        return _error(exc)


@router.put("/api/documents/{document_id}/curriculum")
def edit_curriculum(document_id: str, edit: RoadmapEdit, request: Request):
    try:
        update_draft(request.app.state.data_dir, document_id, edit)
        return _response(request.app.state.data_dir, document_id)
    except (LookupError, RoadmapConflict, ValueError) as exc:
        return _error(exc)


@router.post("/api/documents/{document_id}/curriculum/confirm")
def confirm_curriculum(document_id: str, confirmation: ConfirmRoadmap, request: Request):
    try:
        confirm_draft(request.app.state.data_dir, document_id, confirmation.expected_revision)
        return _response(request.app.state.data_dir, document_id)
    except (LookupError, RoadmapConflict, ValueError) as exc:
        return _error(exc)
