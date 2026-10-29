"""Learner session endpoints (spec section 8) — thin routes translating
typed storage/controller errors into the standard error envelope."""

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from app.errors import error_body
from app.models.session import AdvanceRequest, AnswerRequest, learner_session_view
from app.services.session_controller import InvalidSessionTransition
from app.storage.sessions import (
    EpisodeNotReady,
    SessionConflict,
    apply_advance,
    create_session,
    get_session,
    apply_answer,
)

router = APIRouter()


def _error(exc: Exception) -> JSONResponse:
    if isinstance(exc, ValueError):
        return JSONResponse(status_code=422, content=error_body("VALIDATION_ERROR", str(exc)))
    if isinstance(exc, LookupError):
        return JSONResponse(
            status_code=404, content=error_body("NOT_FOUND", str(exc))
        )
    if isinstance(exc, EpisodeNotReady):
        return JSONResponse(
            status_code=409, content=error_body("EPISODE_NOT_READY", str(exc))
        )
    if isinstance(exc, SessionConflict):
        return JSONResponse(
            status_code=409, content=error_body("SESSION_CONFLICT", str(exc))
        )
    return JSONResponse(
        status_code=409,
        content=error_body("INVALID_SESSION_TRANSITION", str(exc)),
    )


@router.post("/api/sessions/{session_id}/answers")
def answer_endpoint(session_id: str, answer: AnswerRequest, request: Request):
    try:
        return learner_session_view(apply_answer(request.app.state.data_dir, session_id, answer))
    except (LookupError, SessionConflict, InvalidSessionTransition, ValueError) as exc:
        return _error(exc)


@router.post("/api/episodes/{episode_id}/sessions")
def start_session(episode_id: str, request: Request):
    try:
        return learner_session_view(create_session(request.app.state.data_dir, episode_id))
    except (LookupError, EpisodeNotReady) as exc:
        return _error(exc)


@router.get("/api/sessions/{session_id}")
def read_session(session_id: str, request: Request):
    try:
        return learner_session_view(get_session(request.app.state.data_dir, session_id))
    except LookupError as exc:
        return _error(exc)


@router.post("/api/sessions/{session_id}/advance")
def advance_session_endpoint(
    session_id: str, advance: AdvanceRequest, request: Request
):
    try:
        return learner_session_view(apply_advance(
            request.app.state.data_dir,
            session_id,
            advance.request_id,
            advance.expected_version,
        ))
    except (
        LookupError,
        SessionConflict,
        InvalidSessionTransition,
    ) as exc:
        return _error(exc)
