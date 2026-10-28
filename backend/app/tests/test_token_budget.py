import os
import sqlite3
from pathlib import Path

import pytest

from app.config import Settings
from app.pipeline.nodes import TRANSIENT_ERRORS
from app.services.model_provider import (
    GenerationResult,
    ModelProviderError,
    StructuredResult,
)
from app.services.token_budget import (
    MeteredProvider,
    TokenBudgetError,
    check_budget,
    job_usage,
    record_usage,
)
from app.storage.database import init_db


def _settings(**kw) -> Settings:
    os.environ["META_API_KEY"] = "test-key"
    return Settings(_env_file=None, **kw)


@pytest.fixture
def data_dir(tmp_path: Path) -> Path:
    init_db(tmp_path)
    return tmp_path


def _rows(data_dir: Path, job_id: str = "j1") -> list[sqlite3.Row]:
    conn = sqlite3.connect(data_dir / "app.db")
    conn.row_factory = sqlite3.Row
    try:
        return conn.execute(
            "SELECT * FROM token_usage WHERE job_id = ? ORDER BY usage_id",
            (job_id,),
        ).fetchall()
    finally:
        conn.close()


class StubProvider:
    def __init__(self, usage=None, count: int = 0, count_fails: bool = False):
        self.calls: list[dict] = []
        self.usage = usage or {
            "prompt_tokens": 10,
            "completion_tokens": 5,
            "total_tokens": 15,
        }
        self.count = count
        self.count_fails = count_fails

    async def generate_text(self, **kw) -> GenerationResult:
        self.calls.append(kw)
        return GenerationResult(text="ok", usage=self.usage)

    async def generate_structured(self, **kw) -> StructuredResult:
        self.calls.append(kw)
        return StructuredResult(data={"ok": True}, usage=self.usage)

    async def count_input_tokens(self, **kw) -> int:
        self.calls.append({"count": kw})
        if self.count_fails:
            raise ModelProviderError("HTTP_500", "count failed", retryable=True)
        return self.count


def test_record_usage_writes_row(data_dir):
    record_usage(
        data_dir,
        "j1",
        "analyze",
        {
            "prompt_tokens": 100,
            "completion_tokens": 40,
            "total_tokens": 140,
            "prompt_tokens_details": {"cached_tokens": 80},
        },
    )
    rows = _rows(data_dir)
    assert len(rows) == 1
    r = dict(rows[0])
    assert (r["job_id"], r["stage"]) == ("j1", "analyze")
    assert (r["prompt_tokens"], r["completion_tokens"], r["total_tokens"]) == (100, 40, 140)
    assert r["cached_tokens"] == 80
    assert r["created_at"]


def test_record_usage_missing_details_defaults_cached_zero(data_dir):
    record_usage(data_dir, "j1", "extract", {"prompt_tokens": 1, "total_tokens": 2})
    r = dict(_rows(data_dir)[0])
    assert r["cached_tokens"] == 0
    assert r["completion_tokens"] == 0


def test_reexecuted_call_appends_another_row(data_dir):
    usage = {"prompt_tokens": 5, "completion_tokens": 5, "total_tokens": 10}
    record_usage(data_dir, "j1", "analyze", usage)
    record_usage(data_dir, "j1", "analyze", usage)
    assert len(_rows(data_dir)) == 2


def test_budget_error_not_transient():
    assert not issubclass(TokenBudgetError, TRANSIENT_ERRORS)
    err = TokenBudgetError("analyze", "job", planned=10, spent=5, budget=12)
    assert "TOKEN_BUDGET_EXCEEDED" in str(err)
    assert "analyze" in str(err)


def test_job_usage_zero_and_multi_stage(data_dir):
    empty = job_usage(data_dir, "j1")
    assert empty["total_tokens"] == 0 and empty["by_stage"] == {}

    record_usage(data_dir, "j1", "analyze",
                 {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15,
                  "prompt_tokens_details": {"cached_tokens": 4}})
    record_usage(data_dir, "j1", "analyze",
                 {"prompt_tokens": 5, "completion_tokens": 5, "total_tokens": 10})
    record_usage(data_dir, "j1", "generate",
                 {"prompt_tokens": 20, "completion_tokens": 30, "total_tokens": 50})
    record_usage(data_dir, "j2", "analyze",
                 {"prompt_tokens": 7, "completion_tokens": 3, "total_tokens": 10})

    u = job_usage(data_dir, "j1")
    assert u["prompt_tokens"] == 35
    assert u["completion_tokens"] == 40
    assert u["cached_tokens"] == 4
    assert u["total_tokens"] == 75
    assert u["by_stage"] == {"analyze": 25, "generate": 50}


def test_check_budget_stage_and_job_caps(data_dir):
    settings = _settings(token_stage_budget=50, token_job_budget=40)
    record_usage(data_dir, "j1", "analyze",
                 {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15})

    with pytest.raises(TokenBudgetError) as stage_err:
        check_budget(data_dir, settings, "j1", "analyze", planned=40)
    assert stage_err.value.scope == "stage"  # 15 + 40 > 50

    # different stage passes stage cap but trips the job cap (15 + 30 > 40)
    with pytest.raises(TokenBudgetError) as job_err:
        check_budget(data_dir, settings, "j1", "generate", planned=30)
    assert job_err.value.scope == "job"

    check_budget(data_dir, settings, "j1", "generate", planned=20)
    assert _rows(data_dir) and len(_rows(data_dir)) == 1  # refusal wrote nothing


def test_check_budget_per_stage_override_and_disabled(data_dir):
    settings = _settings(
        token_stage_budget=5,
        token_stage_budgets={"analyze": 100},
        token_job_budget=None,
    )
    check_budget(data_dir, settings, "j1", "analyze", planned=99)  # override applies
    with pytest.raises(TokenBudgetError):
        check_budget(data_dir, settings, "j1", "generate", planned=6)  # default 5
    with pytest.raises(TokenBudgetError):
        check_budget(data_dir, settings, "j1", "analyze", planned=101)


def test_check_budget_disabled_caps_never_refuse(data_dir):
    settings = _settings(token_stage_budget=None, token_job_budget=None)
    record_usage(data_dir, "j1", "analyze",
                 {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 999999})
    check_budget(data_dir, settings, "j1", "analyze", planned=999999)


@pytest.mark.anyio
async def test_metered_records_real_usage(data_dir):
    stub = StubProvider(usage={
        "prompt_tokens": 50, "completion_tokens": 20, "total_tokens": 70,
        "prompt_tokens_details": {"cached_tokens": 30},
    })
    metered = MeteredProvider(stub, _settings(), data_dir)
    result = await metered.generate_text(
        job_id="j1", stage="analyze", system="s", user="u", max_tokens=100
    )
    assert result.text == "ok"
    r = dict(_rows(data_dir)[0])
    assert (r["total_tokens"], r["cached_tokens"]) == (70, 30)
    assert stub.calls[0]["cache_key"] == "analyze"  # defaults to stage


@pytest.mark.anyio
async def test_metered_preflight_uses_estimate(data_dir):
    stub = StubProvider(count=500, usage={
        "prompt_tokens": 50, "completion_tokens": 20, "total_tokens": 70,
    })
    settings = _settings(token_job_budget=750)
    metered = MeteredProvider(stub, settings, data_dir)
    await metered.generate_text(
        job_id="j1", stage="analyze", system="s", user="u",
        max_tokens=200, preflight=True,
    )
    assert stub.calls[0]["count"] == {"system": "s", "user": "u"}
    assert _rows(data_dir)[0]["stage"] == "analyze"

    with pytest.raises(TokenBudgetError):
        await metered.generate_text(
            job_id="j1", stage="analyze", system="s", user="u",
            max_tokens=200, preflight=True,
        )  # 70 spent + 500 est + 200 out > 750


@pytest.mark.anyio
async def test_metered_refusal_skips_provider_call(data_dir):
    stub = StubProvider()
    settings = _settings(token_stage_budget=10)
    metered = MeteredProvider(stub, settings, data_dir)
    with pytest.raises(TokenBudgetError):
        await metered.generate_text(
            job_id="j1", stage="analyze", system="s", user="u", max_tokens=50
        )
    assert stub.calls == []
    assert _rows(data_dir) == []


@pytest.mark.anyio
async def test_metered_count_outage_degrades_open(data_dir):
    stub = StubProvider(count_fails=True)
    metered = MeteredProvider(stub, _settings(), data_dir)
    result = await metered.generate_text(
        job_id="j1", stage="analyze", system="s", user="u",
        max_tokens=100, preflight=True,
    )
    assert result.text == "ok"
    assert len(_rows(data_dir)) == 1  # actuals still recorded


def _seed_doc_job(data_dir: Path, doc_id: str, job_id: str) -> None:
    conn = sqlite3.connect(data_dir / "app.db")
    try:
        with conn:
            conn.execute(
                "INSERT INTO documents (document_id, filename, status, "
                "storage_path, created_at) VALUES (?, 'd.pdf', 'uploaded', ?, 't')",
                (doc_id, f"{doc_id}.pdf"),
            )
            conn.execute(
                "INSERT INTO jobs (job_id, document_id, status, stage, error, "
                "created_at, updated_at) VALUES (?, ?, 'queued', NULL, NULL, 't', 't')",
                (job_id, doc_id),
            )
    finally:
        conn.close()


def test_job_status_reports_token_usage(data_dir):
    from fastapi.testclient import TestClient

    from app.main import create_app

    _seed_doc_job(data_dir, "d1", "j1")
    _seed_doc_job(data_dir, "d2", "j2")
    record_usage(data_dir, "j1", "analyze",
                 {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15,
                  "prompt_tokens_details": {"cached_tokens": 4}})
    record_usage(data_dir, "j1", "generate",
                 {"prompt_tokens": 20, "completion_tokens": 30, "total_tokens": 50})

    with TestClient(create_app(data_dir=data_dir)) as client:
        body = client.get("/api/jobs/j1").json()
        assert body["token_usage"]["total_tokens"] == 65
        assert body["token_usage"]["prompt_tokens"] == 30
        assert body["token_usage"]["cached_tokens"] == 4
        assert body["token_usage"]["by_stage"] == {"analyze": 15, "generate": 50}

        fresh = client.get("/api/jobs/j2").json()
        assert fresh["token_usage"]["total_tokens"] == 0
        assert fresh["token_usage"]["by_stage"] == {}


@pytest.mark.anyio
async def test_require_input_budget_under_limit_returns_count(data_dir):
    stub = StubProvider(count=42)
    metered = MeteredProvider(stub, _settings(), data_dir)
    n = await metered.require_input_budget(
        system="s", user="u", limit=100,
        exc=lambda c, lim: ValueError("TOO_BIG"),
    )
    assert n == 42
    assert stub.calls == [{"count": {"system": "s", "user": "u"}}]


@pytest.mark.anyio
async def test_require_input_budget_over_limit_raises_caller_exc(data_dir):
    stub = StubProvider(count=101)
    metered = MeteredProvider(stub, _settings(), data_dir)
    with pytest.raises(ValueError, match="TOO_BIG: 101 of 100"):
        await metered.require_input_budget(
            system="s", user="u", limit=100,
            exc=lambda c, lim: ValueError(f"TOO_BIG: {c} of {lim}"),
        )
    assert stub.calls == [{"count": {"system": "s", "user": "u"}}]


def test_budget_error_inside_node_fails_job_once(data_dir):
    from app.pipeline.runner import run_job
    from app.pipeline.stage import StageContext, StageServices
    from app.storage.documents import init_storage

    init_storage(data_dir)
    _seed_doc_job(data_dir, "d1", "j1")
    settings = _settings(
        data_dir=data_dir,
        checkpoint_db_path=data_dir / "checkpoints.db",
        chroma_dir=data_dir / "chroma",
    )
    calls = []

    def boom(*args, **kwargs):
        calls.append(1)
        raise TokenBudgetError("extract", "job", planned=999, spent=1, budget=1000)

    ctx = StageContext(
        settings, data_dir, services=StageServices(extract_document=boom)
    )
    result = run_job("j1", settings, data_dir, ctx=ctx)

    job = result["job"]
    assert job["execution_state"] == "failed"
    assert job["status"] == "failed"
    assert "TOKEN_BUDGET_EXCEEDED" in job["error"]
    assert len(calls) == 1  # domain error — no retry


@pytest.mark.anyio
async def test_live_count_and_metered_generation(data_dir):
    if os.environ.get("JUSTMAYA_LIVE") != "1":
        pytest.skip("set JUSTMAYA_LIVE=1 to run the live endpoint check")
    saved = os.environ.pop("META_API_KEY", None)  # real .env key wins over placeholder
    try:
        from app.services.model_provider import MetaProvider

        settings = Settings()
    finally:
        if saved is not None:
            os.environ["META_API_KEY"] = saved

    provider = MetaProvider(settings)
    n = await provider.count_input_tokens(system="You are terse.", user="say hi")
    assert isinstance(n, int) and n > 0

    metered = MeteredProvider(provider, settings, data_dir)
    result = await metered.generate_text(
        job_id="live-1", stage="smoke", system="You are terse.",
        user="say hi", max_tokens=1024, preflight=True,
    )
    assert result.text
    u = job_usage(data_dir, "live-1")
    assert u["total_tokens"] > 0
    assert u["cached_tokens"] >= 0
    assert u["by_stage"] == {"smoke": u["total_tokens"]}


@pytest.mark.anyio
async def test_metered_structured_records_usage(data_dir):
    stub = StubProvider()
    metered = MeteredProvider(stub, _settings(), data_dir)
    data = await metered.generate_structured(
        job_id="j1", stage="analyze", system="s", user="u",
        schema={"type": "object"}, cache_key="custom-key",
    )
    assert data == {"ok": True}
    assert stub.calls[0]["cache_key"] == "custom-key"
    assert _rows(data_dir)[0]["total_tokens"] == 15
