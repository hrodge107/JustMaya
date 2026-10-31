"""Transactional persistence for reviewable roadmaps."""

import sqlite3
from datetime import datetime, timezone
from pathlib import Path

from app.models.concept import ConceptInventory
from app.models.curriculum import LessonContext, Roadmap, RoadmapEdit, validate_roadmap
from app.services.curriculum_review import apply_edit, lock_selection
from app.storage.jobs import release_from_review


class RoadmapConflict(Exception):
    pass


def _connect(data_dir: Path) -> sqlite3.Connection:
    return sqlite3.connect(data_dir / "app.db", timeout=10, isolation_level=None)


def save_draft(data_dir: Path, roadmap: Roadmap, inventory: ConceptInventory, job_id: str) -> None:
    validate_roadmap(roadmap, inventory)
    conn = _connect(data_dir)
    try:
        conn.execute("BEGIN IMMEDIATE")
        existing = conn.execute("SELECT payload FROM roadmaps WHERE document_id = ?", (roadmap.document_id,)).fetchone()
        if existing:
            conn.rollback()
            return
        conn.execute("INSERT INTO roadmaps (curriculum_id, document_id, payload, schema_version, created_at, inventory_payload, job_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
                     (roadmap.curriculum_id, roadmap.document_id, roadmap.model_dump_json(), 1,
                      datetime.now(timezone.utc).isoformat(), inventory.model_dump_json(), job_id))
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def _read(conn: sqlite3.Connection, document_id: str):
    row = conn.execute("SELECT payload, inventory_payload, job_id FROM roadmaps WHERE document_id = ?", (document_id,)).fetchone()
    if row is None:
        raise LookupError("Roadmap not found")
    return Roadmap.model_validate_json(row[0]), ConceptInventory.model_validate_json(row[1]), row[2]


def read_draft(data_dir: Path, document_id: str):
    conn = _connect(data_dir)
    try:
        return _read(conn, document_id)
    finally:
        conn.close()


def update_draft(data_dir: Path, document_id: str, edit: RoadmapEdit) -> Roadmap:
    conn = _connect(data_dir)
    try:
        conn.execute("BEGIN IMMEDIATE")
        roadmap, inventory, _ = _read(conn, document_id)
        if roadmap.confirmed or roadmap.revision != edit.expected_revision:
            raise RoadmapConflict("Roadmap is locked or revision is stale")
        updated = apply_edit(roadmap, edit, inventory)
        conn.execute("UPDATE roadmaps SET payload = ? WHERE curriculum_id = ?", (updated.model_dump_json(), updated.curriculum_id))
        conn.commit()
        return updated
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def confirm_draft(data_dir: Path, document_id: str, revision: int) -> Roadmap:
    conn = _connect(data_dir)
    try:
        conn.execute("BEGIN IMMEDIATE")
        roadmap, inventory, job_id = _read(conn, document_id)
        if roadmap.revision != revision:
            raise RoadmapConflict("Roadmap revision is stale")
        if roadmap.confirmed:
            conn.commit()
            return roadmap
        result = lock_selection(roadmap, inventory)
        if not release_from_review(conn, job_id):
            raise RoadmapConflict("Job is not awaiting review")
        conn.execute("UPDATE roadmaps SET payload = ? WHERE curriculum_id = ?", (result.model_dump_json(), result.curriculum_id))
        conn.commit()
        return result
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def attach_lesson_context(data_dir: Path, document_id: str, context: LessonContext) -> Roadmap:
    """Persist the detail pass's lesson context onto the confirmed roadmap.
    Idempotent: an existing context is returned unchanged, never overwritten."""
    conn = _connect(data_dir)
    try:
        conn.execute("BEGIN IMMEDIATE")
        roadmap, _, _ = _read(conn, document_id)
        if not roadmap.confirmed:
            raise RoadmapConflict("Roadmap is not confirmed")
        if roadmap.lesson_context is not None:
            conn.commit()
            return roadmap
        updated = roadmap.model_copy(deep=True, update={"lesson_context": context})
        conn.execute("UPDATE roadmaps SET payload = ? WHERE curriculum_id = ?",
                     (updated.model_dump_json(), updated.curriculum_id))
        conn.commit()
        return updated
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()
