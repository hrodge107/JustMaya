"""Episode persistence — draft upsert keyed by the deterministic episode_id.

A re-run converges to one row; the conditional upsert preserves a `ready`
episode — a failed or repeated generation can never overwrite a published
script (A08 invariant, enforced here from the start).
"""

import sqlite3
from datetime import datetime, timezone
from pathlib import Path

from app.models.episode import EpisodeScript, ValidationReport


def save_episode_draft(
    data_dir: Path, script: EpisodeScript, curriculum_id: str
) -> None:
    now = datetime.now(timezone.utc).isoformat()
    conn = sqlite3.connect(data_dir / "app.db", timeout=10)
    try:
        with conn:
            conn.execute(
                "INSERT INTO episodes "
                "(episode_id, document_id, curriculum_id, payload, status, "
                " validation, created_at, updated_at) "
                "VALUES (?, ?, ?, ?, 'draft', NULL, ?, ?) "
                "ON CONFLICT(episode_id) DO UPDATE SET "
                "payload = excluded.payload, status = 'draft', "
                "updated_at = excluded.updated_at "
                "WHERE episodes.status != 'ready'",
                (
                    script.episodeId,
                    script.documentId,
                    curriculum_id,
                    script.model_dump_json(),
                    now,
                    now,
                ),
            )
    finally:
        conn.close()


def read_episode(data_dir: Path, document_id: str) -> EpisodeScript:
    conn = sqlite3.connect(data_dir / "app.db", timeout=10)
    try:
        row = conn.execute(
            "SELECT payload FROM episodes WHERE document_id = ? "
            "ORDER BY created_at LIMIT 1",
            (document_id,),
        ).fetchone()
    finally:
        conn.close()
    if row is None:
        raise LookupError("Episode not found")
    return EpisodeScript.model_validate_json(row[0])


def read_episode_by_id(data_dir: Path, episode_id: str) -> EpisodeScript:
    conn = sqlite3.connect(data_dir / "app.db", timeout=10)
    try:
        row = conn.execute(
            "SELECT payload FROM episodes WHERE episode_id = ?",
            (episode_id,),
        ).fetchone()
    finally:
        conn.close()
    if row is None:
        raise LookupError("Episode not found")
    return EpisodeScript.model_validate_json(row[0])


def read_episode_state(data_dir: Path, document_id: str) -> dict | None:
    """{status, validation} for the document's latest episode, if any."""
    conn = sqlite3.connect(data_dir / "app.db", timeout=10)
    try:
        row = conn.execute(
            "SELECT status, validation FROM episodes WHERE document_id = ? "
            "ORDER BY created_at LIMIT 1",
            (document_id,),
        ).fetchone()
    finally:
        conn.close()
    if row is None:
        return None
    return {"status": row[0], "validation": row[1]}


def publish_episode(
    data_dir: Path,
    script: EpisodeScript,
    report: ValidationReport,
    curriculum_id: str | None = None,
) -> bool:
    """Atomic publish: episode -> ready with the validation outcome, owning
    document -> ready, in one transaction. A frozen `ready` row is never
    overwritten — returns False when the episode was already published."""
    now = datetime.now(timezone.utc).isoformat()
    published = script.model_copy(update={"status": "ready"})
    conn = sqlite3.connect(data_dir / "app.db", timeout=10)
    try:
        with conn:
            changed = conn.execute(
                "INSERT INTO episodes "
                "(episode_id, document_id, curriculum_id, payload, status, "
                " validation, created_at, updated_at) "
                "VALUES (?, ?, ?, ?, 'ready', ?, ?, ?) "
                "ON CONFLICT(episode_id) DO UPDATE SET "
                "payload = excluded.payload, status = 'ready', "
                "validation = excluded.validation, updated_at = excluded.updated_at "
                "WHERE episodes.status != 'ready'",
                (
                    script.episodeId,
                    script.documentId,
                    curriculum_id,
                    published.model_dump_json(),
                    report.model_dump_json(),
                    now,
                    now,
                ),
            ).rowcount
            if changed == 1:
                conn.execute(
                    "UPDATE documents SET status = 'ready' WHERE document_id = ?",
                    (script.documentId,),
                )
    finally:
        conn.close()
    return changed == 1


def record_validation(
    data_dir: Path, episode_id: str, report: ValidationReport
) -> None:
    """Persist a validation outcome without publishing. A frozen `ready`
    row keeps its original report."""
    conn = sqlite3.connect(data_dir / "app.db", timeout=10)
    try:
        with conn:
            conn.execute(
                "UPDATE episodes SET validation = ?, updated_at = ? "
                "WHERE episode_id = ? AND status != 'ready'",
                (
                    report.model_dump_json(),
                    datetime.now(timezone.utc).isoformat(),
                    episode_id,
                ),
            )
    finally:
        conn.close()
