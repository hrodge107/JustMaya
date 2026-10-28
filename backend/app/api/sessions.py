"""Learner session endpoints (spec section 8) — thin routes translating
typed storage/controller errors into the standard error envelope."""

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from app.errors import error_body
from app.models.session import AdvanceRequest
from app.services.session_controller import InvalidSessionTransition
from app.storage.sessions import (
    EpisodeNotReady,
    SessionConflict,
    apply_advance,
    create_session,
    get_session,
)

router = APIRouter()


def _error(exc: Exception) -> JSONResponse:
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


@router.post("/api/episodes/{episode_id}/sessions")
def start_session(episode_id: str, request: Request):
    try:
        return create_session(request.app.state.data_dir, episode_id)
    except (LookupError, EpisodeNotReady) as exc:
        return _error(exc)


@router.get("/api/sessions/{session_id}")
def read_session(session_id: str, request: Request):
    try:
        return get_session(request.app.state.data_dir, session_id)
    except LookupError as exc:
        return _error(exc)


@router.post("/api/sessions/{session_id}/advance")
def advance_session_endpoint(
    session_id: str, advance: AdvanceRequest, request: Request
):
    try:
        return apply_advance(
            request.app.state.data_dir,
            session_id,
            advance.request_id,
            advance.expected_version,
        )
    except (
        LookupError,
        SessionConflict,
        InvalidSessionTransition,
    ) as exc:
        return _error(exc)
