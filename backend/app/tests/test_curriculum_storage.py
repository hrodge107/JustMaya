import sqlite3

import pytest

from app.storage.curriculum import RoadmapConflict, confirm_draft, read_draft, save_draft, update_draft
from app.storage.database import init_db
from app.tests.test_curriculum_models import inventory, roadmap
from app.tests.test_curriculum_review import edit


@pytest.fixture
def store(tmp_path):
    init_db(tmp_path)
    init_db(tmp_path)
    conn = sqlite3.connect(tmp_path / "app.db")
    conn.execute("INSERT INTO documents (document_id, filename, status, created_at) VALUES ('d', 'a.pdf', 'processing', 'now')")
    conn.execute("INSERT INTO jobs (job_id, document_id, status, stage, error, created_at, updated_at, execution_state) VALUES ('j', 'd', 'planning', 'plan', NULL, 'now', 'now', 'awaiting_review')")
    conn.commit()
    conn.close()
    return tmp_path


def test_revision_and_confirmation_are_atomic_and_repeatable(store):
    source, value = inventory(), roadmap()
    save_draft(store, value, source, "j")
    changed = update_draft(store, "d", edit(value, ["c"], pace=100))
    with pytest.raises(RoadmapConflict):
        update_draft(store, "d", edit(value, ["c"]))
    locked = confirm_draft(store, "d", changed.revision)
    assert locked.confirmed and confirm_draft(store, "d", changed.revision) == locked
    with pytest.raises(RoadmapConflict):
        update_draft(store, "d", edit(changed, ["c"]))
    conn = sqlite3.connect(store / "app.db")
    assert conn.execute("SELECT execution_state FROM jobs WHERE job_id='j'").fetchone()[0] == "partial_complete"
    conn.close()


def test_failed_replacement_keeps_saved_draft(store):
    source, value = inventory(), roadmap()
    save_draft(store, value, source, "j")
    with pytest.raises(ValueError):
        update_draft(store, "d", edit(value, ["missing"]))
    assert read_draft(store, "d")[0] == value
