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
from app.models.session import LearnerSession
from app.services.session_controller import advance as advance_session
from app.services.session_controller import new_session


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
    finally:
        conn.close()
    if row is None:
        raise LookupError("Session not found")
    return LearnerSession.model_validate_json(row[0])


def apply_advance(
    data_dir: Path, session_id: str, request_id: str, expected_version: int
) -> LearnerSession:
    """Deduplicated, version-checked advance — one atomic transaction."""
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
            "VALUES (?, ?, 'advance', ?) "
            "ON CONFLICT(session_id, request_id) DO NOTHING",
            (session_id, request_id, _now()),
        )
        if inserted.rowcount == 0:
            existing = conn.execute(
                "SELECT kind FROM session_requests "
                "WHERE session_id = ? AND request_id = ?",
                (session_id, request_id),
            ).fetchone()
            if existing[0] != "advance":
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
        updated = advance_session(session, episode)
        _write(conn, updated)
        conn.commit()
        return updated
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()
