"""Learner session endpoints (spec section 8) — thin routes translating
typed storage/controller errors into the standard error envelope."""

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from app.errors import error_body
from app.models.session import (
    AdvanceRequest,
    AnswerRequest,
    QuestionRequest,
    RaiseHandRequest,
    ResumeRequest,
    learner_session_view,
)
from app.services.model_provider import MetaProvider, ModelProviderError
from app.services.retriever import retrieve
from app.services.session_controller import InvalidSessionTransition
from app.services.token_budget import MeteredProvider, TokenBudgetError
from app.services.tutor import answer_question
from app.storage.sessions import (
    EpisodeNotReady,
    SessionConflict,
    apply_advance,
    apply_answer,
    apply_raise_hand,
    apply_resume,
    commit_question,
    create_session,
    get_session,
    prepare_question,
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


@router.post("/api/sessions/{session_id}/raise-hand")
def raise_hand_endpoint(session_id: str, body: RaiseHandRequest, request: Request):
    try:
        return learner_session_view(apply_raise_hand(
            request.app.state.data_dir,
            session_id,
            body.request_id,
            body.expected_version,
        ))
    except (LookupError, SessionConflict, InvalidSessionTransition) as exc:
        return _error(exc)


@router.post("/api/sessions/{session_id}/resume")
def resume_endpoint(session_id: str, body: ResumeRequest, request: Request):
    try:
        return learner_session_view(apply_resume(
            request.app.state.data_dir,
            session_id,
            body.request_id,
            body.expected_version,
        ))
    except (LookupError, SessionConflict, InvalidSessionTransition) as exc:
        return _error(exc)


@router.post("/api/sessions/{session_id}/questions")
async def question_endpoint(
    session_id: str, body: QuestionRequest, request: Request
):
    """Pre-check → tutor call outside the write transaction → commit."""
    data_dir = request.app.state.data_dir
    try:
        session, episode, recorded = prepare_question(data_dir, session_id, body)
        if recorded is not None:
            return {
                "interaction": recorded.model_dump(),
                "session": learner_session_view(session),
            }
        provider = getattr(request.app.state, "tutor_provider", None)
        if provider is None:
            provider = request.app.state.tutor_provider = MeteredProvider(
                MetaProvider(request.app.state.settings),
                request.app.state.settings,
                data_dir,
            )
        answer = await answer_question(
            provider=provider,
            session=session,
            episode=episode,
            request=body,
            settings=request.app.state.settings,
            retriever=getattr(request.app.state, "retriever", retrieve),
        )
        updated, interaction = commit_question(
            data_dir, session_id, body, answer.interaction, answer.learning_note
        )
        return {
            "interaction": interaction.model_dump(),
            "session": learner_session_view(updated),
        }
    except (LookupError, SessionConflict, InvalidSessionTransition, ValueError) as exc:
        return _error(exc)
    except TokenBudgetError as exc:
        return JSONResponse(status_code=503, content=error_body(exc.code, str(exc)))
    except ModelProviderError as exc:
        return JSONResponse(
            status_code=503,
            content=error_body(exc.code, exc.message, exc.retryable),
        )
