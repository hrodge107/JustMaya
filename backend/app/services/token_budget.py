"""Token governance: per-call usage records and per-stage/per-job caps.

Pipeline stages call the model through MeteredProvider so spend is recorded
and budget-checked by construction. token_usage rows are append-only facts —
a re-executed node genuinely re-spends, so it appends another row.
"""

import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from app.config import Settings
from app.services.model_provider import (
    GenerationProvider,
    GenerationResult,
    ModelProviderError,
)


class TokenBudgetError(Exception):
    code = "TOKEN_BUDGET_EXCEEDED"

    def __init__(self, stage: str, scope: str, planned: int, spent: int, budget: int):
        super().__init__(
            f"{self.code}: stage '{stage}' planned {planned} + spent {spent} "
            f"exceeds {scope} budget {budget}"
        )
        self.stage = stage
        self.scope = scope


def _connect(data_dir: Path) -> sqlite3.Connection:
    conn = sqlite3.connect(data_dir / "app.db", timeout=10)
    conn.row_factory = sqlite3.Row
    return conn


def record_usage(
    data_dir: Path, job_id: str, stage: str, usage: dict[str, Any]
) -> None:
    details = usage.get("prompt_tokens_details") or {}
    conn = _connect(data_dir)
    try:
        with conn:
            conn.execute(
                "INSERT INTO token_usage "
                "(job_id, stage, prompt_tokens, completion_tokens, "
                " cached_tokens, total_tokens, created_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?)",
                (
                    job_id,
                    stage,
                    int(usage.get("prompt_tokens", 0)),
                    int(usage.get("completion_tokens", 0)),
                    int(details.get("cached_tokens", 0) or 0),
                    int(usage.get("total_tokens", 0)),
                    datetime.now(timezone.utc).isoformat(),
                ),
            )
    finally:
        conn.close()


def job_usage(data_dir: Path, job_id: str) -> dict[str, Any]:
    conn = _connect(data_dir)
    try:
        rows = conn.execute(
            "SELECT stage, SUM(prompt_tokens) AS p, SUM(completion_tokens) AS c, "
            "SUM(cached_tokens) AS cached, SUM(total_tokens) AS t "
            "FROM token_usage WHERE job_id = ? GROUP BY stage",
            (job_id,),
        ).fetchall()
    finally:
        conn.close()
    by_stage = {r["stage"]: r["t"] for r in rows}
    return {
        "prompt_tokens": sum(r["p"] for r in rows),
        "completion_tokens": sum(r["c"] for r in rows),
        "cached_tokens": sum(r["cached"] for r in rows),
        "total_tokens": sum(r["t"] for r in rows),
        "by_stage": by_stage,
    }


def _spent(conn: sqlite3.Connection, job_id: str, stage: str | None) -> int:
    if stage is None:
        row = conn.execute(
            "SELECT COALESCE(SUM(total_tokens), 0) FROM token_usage WHERE job_id = ?",
            (job_id,),
        ).fetchone()
    else:
        row = conn.execute(
            "SELECT COALESCE(SUM(total_tokens), 0) FROM token_usage "
            "WHERE job_id = ? AND stage = ?",
            (job_id, stage),
        ).fetchone()
    return int(row[0])


def check_budget(
    data_dir: Path, settings: Settings, job_id: str, stage: str, planned: int
) -> None:
    """Raise TokenBudgetError if `planned` tokens would exceed a configured cap."""
    stage_cap = settings.token_stage_budgets.get(stage, settings.token_stage_budget)
    job_cap = settings.token_job_budget
    conn = _connect(data_dir)
    try:
        if stage_cap is not None:
            spent = _spent(conn, job_id, stage)
            if spent + planned > stage_cap:
                raise TokenBudgetError(stage, "stage", planned, spent, stage_cap)
        if job_cap is not None:
            spent = _spent(conn, job_id, None)
            if spent + planned > job_cap:
                raise TokenBudgetError(stage, "job", planned, spent, job_cap)
    finally:
        conn.close()


class MeteredProvider:
    """Budget-enforcing wrapper around a GenerationProvider.

    Every successful call records its real usage; preflight=True adds a
    server-side input-token estimate to the budget check before the call.
    """

    def __init__(
        self, provider: GenerationProvider, settings: Settings, data_dir: Path
    ):
        self._provider = provider
        self._settings = settings
        self._data_dir = data_dir

    async def count_input_tokens(self, *, system: str, user: str) -> int:
        return await self._provider.count_input_tokens(system=system, user=user)

    async def generate_text(
        self,
        *,
        job_id: str,
        stage: str,
        system: str,
        user: str,
        max_tokens: int | None = None,
        preflight: bool = False,
        cache_key: str | None = None,
    ) -> GenerationResult:
        await self._gate(job_id, stage, system, user, max_tokens, preflight)
        result = await self._provider.generate_text(
            system=system,
            user=user,
            max_tokens=max_tokens,
            cache_key=cache_key if cache_key is not None else stage,
        )
        record_usage(self._data_dir, job_id, stage, result.usage)
        return result

    async def generate_structured(
        self,
        *,
        job_id: str,
        stage: str,
        system: str,
        user: str,
        schema: dict[str, Any],
        max_tokens: int | None = None,
        preflight: bool = False,
        cache_key: str | None = None,
    ) -> dict[str, Any]:
        await self._gate(job_id, stage, system, user, max_tokens, preflight)
        result = await self._provider.generate_structured(
            system=system,
            user=user,
            schema=schema,
            max_tokens=max_tokens,
            cache_key=cache_key if cache_key is not None else stage,
        )
        record_usage(self._data_dir, job_id, stage, result.usage)
        return result.data

    async def _gate(
        self,
        job_id: str,
        stage: str,
        system: str,
        user: str,
        max_tokens: int | None,
        preflight: bool,
    ) -> None:
        estimate = 0
        if preflight:
            try:
                estimate = await self._provider.count_input_tokens(
                    system=system, user=user
                )
            except ModelProviderError:
                estimate = 0  # degrade open: static bound + post-call actuals
        check_budget(
            self._data_dir,
            self._settings,
            job_id,
            stage,
            planned=estimate + (max_tokens or 0),
        )
