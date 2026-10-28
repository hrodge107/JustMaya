"""Stage contract: context wiring and the shared roadmap guard."""

import asyncio
import inspect
import sqlite3

import app.pipeline.nodes as nodes_module
from app.config import Settings
from app.pipeline.stage import StageContext, StageServices, roadmap_guard
from app.services.model_provider import GenerationResult, StructuredResult
from app.services.pdf_extractor import extract_document
from app.services.token_budget import MeteredProvider
from app.storage.curriculum import confirm_draft, save_draft
from app.storage.database import init_db
from app.storage.jobs import EXECUTION_REVIEW
from app.tests.test_curriculum_models import inventory, roadmap


class _StubProvider:
    def __init__(self):
        self.calls = []

    async def generate_text(self, **kw):
        self.calls.append(kw)
        return GenerationResult(text="ok", usage={"total_tokens": 2})

    async def generate_structured(self, **kw):
        self.calls.append(kw)
        return StructuredResult(data={"ok": True}, usage={"total_tokens": 2})

    async def count_input_tokens(self, **kw):
        return 1


def _settings(tmp_path):
    return Settings(meta_api_key="test-placeholder-key", data_dir=tmp_path)


def _draft(tmp_path, owner="j"):
    init_db(tmp_path)
    conn = sqlite3.connect(tmp_path / "app.db")
    conn.execute(
        "INSERT INTO documents (document_id, filename, status, created_at) "
        "VALUES ('d', 'a.pdf', 'processing', 'now')"
    )
    conn.execute(
        "INSERT INTO jobs (job_id, document_id, status, stage, error, "
        "created_at, updated_at, execution_state) "
        "VALUES (?, 'd', 'planning', 'plan', NULL, 'now', 'now', ?)",
        (owner, EXECUTION_REVIEW),
    )
    conn.commit()
    conn.close()
    save_draft(tmp_path, roadmap(), inventory(), owner)


def test_roadmap_guard_absent(tmp_path):
    init_db(tmp_path)
    check = roadmap_guard(tmp_path, "d", "j")
    assert check.draft is None and not check.foreign and not check.usable


def test_roadmap_guard_unconfirmed(tmp_path):
    _draft(tmp_path)
    check = roadmap_guard(tmp_path, "d", "j")
    assert check.draft is not None and not check.foreign and not check.usable


def test_roadmap_guard_foreign(tmp_path):
    _draft(tmp_path, owner="other")
    check = roadmap_guard(tmp_path, "d", "j")
    assert check.draft is not None and check.foreign and not check.usable


def test_roadmap_guard_usable_after_confirm(tmp_path):
    _draft(tmp_path)
    confirm_draft(tmp_path, "d", revision=1)
    check = roadmap_guard(tmp_path, "d", "j")
    assert check.usable and not check.foreign


def test_context_wraps_injected_provider_once(tmp_path):
    init_db(tmp_path)
    stub = _StubProvider()
    ctx = StageContext(_settings(tmp_path), tmp_path, provider=stub)
    assert type(ctx.provider) is MeteredProvider
    asyncio.run(ctx.provider.generate_text(
        job_id="j", stage="smoke", system="s", user="u"))
    assert len(stub.calls) == 1


def test_services_default_to_real_implementations(tmp_path):
    ctx = StageContext(_settings(tmp_path), tmp_path)
    assert ctx.services.extract_document is extract_document
    assert StageServices().analyze_document is not None


def test_provider_recipe_lives_only_in_stage_context(tmp_path):
    source = inspect.getsource(nodes_module)
    assert "MeteredProvider(" not in source
    assert "MetaProvider(" not in source
    ctx = StageContext(_settings(tmp_path), tmp_path)
    assert type(ctx.provider) is MeteredProvider
