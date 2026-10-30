"""Learner-session persistence — owns learner_sessions and session_requests.

Mutation shape mirrors storage/curriculum.py: BEGIN IMMEDIATE, dedup
tombstone insert, read, version check, pure transition, write — one commit,
so the dedup record and the state change can never split. Transition
decisions live in services/session_controller.py.
"""

import sqlite3
from datetime import datetime, timezone
from pathlib import Path

from app.models.episode import EpisodeScript
from app.models.session import (
    MODE_QUESTION,
    AnswerRequest,
    LearnerSession,
    QuestionRequest,
    TutorInteraction,
)
from app.services.session_controller import (
    InvalidSessionTransition,
    advance as advance_session,
    new_session,
    restore_checkpoint,
)
from app.services.tutor_flow import validate_anchor
from app.services.session_controller import answer as answer_session
from app.services.session_controller import raise_hand as raise_hand_session
from app.services.session_controller import resume as resume_session


class SessionConflict(Exception):
    pass


class EpisodeNotReady(Exception):
    pass


def _connect(data_dir: Path) -> sqlite3.Connection:
    conn = sqlite3.connect(data_dir / "app.db", timeout=10, isolation_level=None)
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _write(conn: sqlite3.Connection, session: LearnerSession) -> None:
    conn.execute(
        "UPDATE learner_sessions SET payload = ?, mode = ?, status = ?, "
        "version = ?, updated_at = ? WHERE session_id = ?",
        (
            session.model_dump_json(),
            session.mode,
            session.status,
            session.version,
            session.updatedAt,
            session.sessionId,
        ),
    )


def create_session(data_dir: Path, episode_id: str) -> LearnerSession:
    """Persist a session at the episode start. Unknown episode raises
    LookupError; a non-ready episode raises EpisodeNotReady."""
    conn = _connect(data_dir)
    try:
        conn.execute("BEGIN IMMEDIATE")
        row = conn.execute(
            "SELECT payload, status FROM episodes WHERE episode_id = ?",
            (episode_id,),
        ).fetchone()
        if row is None:
            raise LookupError("Episode not found")
        if row[1] != "ready":
            raise EpisodeNotReady("Episode is not ready for play.")
        episode = EpisodeScript.model_validate_json(row[0])
        session = new_session(episode)
        conn.execute(
            "INSERT INTO learner_sessions "
            "(session_id, episode_id, mode, status, version, payload, "
            " created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (
                session.sessionId,
                session.episodeId,
                session.mode,
                session.status,
                session.version,
                session.model_dump_json(),
                _now(),
                session.updatedAt,
            ),
        )
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()
    return session


def get_session(data_dir: Path, session_id: str) -> LearnerSession:
    conn = _connect(data_dir)
    try:
        row = conn.execute(
            "SELECT payload FROM learner_sessions WHERE session_id = ?",
            (session_id,),
        ).fetchone()
        if row is None:
            raise LookupError("Session not found")
        session = LearnerSession.model_validate_json(row[0])
        episode_row = conn.execute(
            "SELECT payload FROM episodes WHERE episode_id = ?", (session.episodeId,)
        ).fetchone()
        if episode_row is None:
            raise LookupError("Episode not found")
        return restore_checkpoint(session, EpisodeScript.model_validate_json(episode_row[0]))
    finally:
        conn.close()


def apply_advance(
    data_dir: Path, session_id: str, request_id: str, expected_version: int
) -> LearnerSession:
    return _apply(data_dir, session_id, request_id, expected_version)


def apply_answer(data_dir: Path, session_id: str, request: AnswerRequest) -> LearnerSession:
    return _apply(
        data_dir, session_id, request.request_id, request.expected_version,
        mutate=lambda s, e: answer_session(s, e, request), kind="answer",
    )


def apply_raise_hand(
    data_dir: Path, session_id: str, request_id: str, expected_version: int
) -> LearnerSession:
    return _apply(
        data_dir, session_id, request_id, expected_version,
        mutate=lambda s, _e: raise_hand_session(s), kind="raise_hand",
    )


def apply_resume(
    data_dir: Path, session_id: str, request_id: str, expected_version: int
) -> LearnerSession:
    return _apply(
        data_dir, session_id, request_id, expected_version,
        mutate=lambda s, e: resume_session(s, e), kind="resume",
    )


def _apply(
    data_dir: Path, session_id: str, request_id: str, expected_version: int,
    mutate=None, kind: str = "advance",
) -> LearnerSession:
    """The same transaction owns every versioned learner mutation."""
    conn = _connect(data_dir)
    try:
        conn.execute("BEGIN IMMEDIATE")
        row = conn.execute(
            "SELECT payload FROM learner_sessions WHERE session_id = ?",
            (session_id,),
        ).fetchone()
        if row is None:
            raise LookupError("Session not found")
        session = LearnerSession.model_validate_json(row[0])
        inserted = conn.execute(
            "INSERT INTO session_requests "
            "(session_id, request_id, kind, created_at) "
            "VALUES (?, ?, ?, ?) "
            "ON CONFLICT(session_id, request_id) DO NOTHING",
            (session_id, request_id, kind, _now()),
        )
        if inserted.rowcount == 0:
            existing = conn.execute(
                "SELECT kind FROM session_requests "
                "WHERE session_id = ? AND request_id = ?",
                (session_id, request_id),
            ).fetchone()
            if existing[0] != kind:
                raise SessionConflict("Request ID was used for another operation.")
            conn.rollback()
            return get_session(data_dir, session_id)
        if session.version != expected_version:
            raise SessionConflict("Session version is stale.")
        episode_row = conn.execute(
            "SELECT payload FROM episodes WHERE episode_id = ?",
            (session.episodeId,),
        ).fetchone()
        if episode_row is None:
            raise LookupError("Episode not found")
        episode = EpisodeScript.model_validate_json(episode_row[0])
        updated = mutate(session, episode) if mutate else advance_session(session, episode)
        _write(conn, updated)
        conn.commit()
        return updated
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def prepare_question(
    data_dir: Path, session_id: str, request: QuestionRequest
) -> tuple[LearnerSession, EpisodeScript | None, TutorInteraction | None]:
    """Phase 1 for question answering: replay lookup + cheap rejections
    before any model spend. Returns (session, episode, recorded):
    `recorded` set means the request is a replay — answer without calling
    the model; `episode` set means the call may proceed."""
    conn = _connect(data_dir)
    try:
        row = conn.execute(
            "SELECT payload FROM learner_sessions WHERE session_id = ?",
            (session_id,),
        ).fetchone()
        if row is None:
            raise LookupError("Session not found")
        session = LearnerSession.model_validate_json(row[0])
        existing = conn.execute(
            "SELECT kind FROM session_requests "
            "WHERE session_id = ? AND request_id = ?",
            (session_id, request.request_id),
        ).fetchone()
        if existing is not None:
            if existing[0] != "question":
                raise SessionConflict("Request ID was used for another operation.")
            recorded = next(
                i for i in session.interactions
                if i.kind == "raise_hand" and i.requestId == request.request_id
            )
            return session.model_copy(update={"checkpoint": None}), None, recorded
        if session.version != request.expected_version:
            raise SessionConflict("Session version is stale.")
        if session.mode != MODE_QUESTION:
            raise InvalidSessionTransition("Session is not in question mode.")
        # Anchors resolve against the active thread before any spend (422).
        validate_anchor(session, request.reply_to_interaction_id)
        episode_row = conn.execute(
            "SELECT payload FROM episodes WHERE episode_id = ?",
            (session.episodeId,),
        ).fetchone()
        if episode_row is None:
            raise LookupError("Episode not found")
        return session, EpisodeScript.model_validate_json(episode_row[0]), None
    finally:
        conn.close()


def commit_question(
    data_dir: Path,
    session_id: str,
    request: QuestionRequest,
    interaction: TutorInteraction,
    learning_note: str | None,
) -> tuple[LearnerSession, TutorInteraction]:
    """Phase 3: tombstone + version/mode re-check + append in one commit,
    serialized against a resume or second question that raced the model."""
    conn = _connect(data_dir)
    try:
        conn.execute("BEGIN IMMEDIATE")
        row = conn.execute(
            "SELECT payload FROM learner_sessions WHERE session_id = ?",
            (session_id,),
        ).fetchone()
        if row is None:
            raise LookupError("Session not found")
        session = LearnerSession.model_validate_json(row[0])
        inserted = conn.execute(
            "INSERT INTO session_requests "
            "(session_id, request_id, kind, created_at) "
            "VALUES (?, ?, 'question', ?) "
            "ON CONFLICT(session_id, request_id) DO NOTHING",
            (session_id, request.request_id, _now()),
        )
        if inserted.rowcount == 0:
            existing = conn.execute(
                "SELECT kind FROM session_requests "
                "WHERE session_id = ? AND request_id = ?",
                (session_id, request.request_id),
            ).fetchone()
            if existing[0] != "question":
                raise SessionConflict("Request ID was used for another operation.")
            conn.rollback()
            fresh = get_session(data_dir, session_id)
            recorded = next(
                i for i in fresh.interactions
                if i.kind == "raise_hand" and i.requestId == request.request_id
            )
            return fresh, recorded
        if session.version != request.expected_version:
            raise SessionConflict("Session version is stale.")
        if session.mode != MODE_QUESTION:
            raise InvalidSessionTransition("Session is not in question mode.")
        notes = (
            [*session.learningNotes, learning_note]
            if learning_note else session.learningNotes
        )
        update: dict = {
            "interactions": [*session.interactions, interaction],
            "learningNotes": notes,
            "version": session.version + 1,
            "updatedAt": _now(),
        }
        if session.tutorThreadId is None:
            # Legacy question-mode sessions gain the interrupt identity
            # lazily in this same write — no extra write or increment.
            update["tutorThreadId"] = (
                f"{session.sessionId}:{session.version}"
            )
        updated = session.model_copy(update=update)
        _write(conn, updated)
        conn.commit()
        return updated, interaction
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()
