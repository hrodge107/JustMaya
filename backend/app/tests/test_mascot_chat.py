"""Lobby mascot chat — session-free sibling of the raise-hand contract.

Service tests stub the provider; endpoint tests inject it through
app.state.mascot_provider, the same seam the sessions router uses for
tutor_provider.
"""

import os
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app
from app.services.mascot_chat import (
    _FALLBACK_LINE,
    _LESSON_REDIRECTS,
    answer_chat,
)
from app.services.model_provider import (
    GenerationResult,
    ModelProviderError,
    StructuredResult,
)
from app.services.token_budget import MeteredProvider
from app.storage.database import init_db


def _settings(**kw) -> Settings:
    os.environ["META_API_KEY"] = "test-key"
    return Settings(_env_file=None, **kw)


class StubProvider:
    def __init__(self, data=None, error=None):
        self.data = data or {
            "lines": ["Upload a PDF and I spin it into a lesson."],
            "relation": "app",
        }
        self.error = error
        self.calls: list[dict] = []

    async def generate_text(self, **kw) -> GenerationResult:
        self.calls.append(kw)
        return GenerationResult(text="ok", usage={"total_tokens": 1})

    async def generate_structured(self, **kw) -> StructuredResult:
        self.calls.append(kw)
        if self.error:
            raise self.error
        return StructuredResult(
            data=self.data,
            usage={"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15},
        )

    async def count_input_tokens(self, **kw) -> int:
        return 10


def _provider(stub: StubProvider, tmp_path: Path) -> MeteredProvider:
    init_db(tmp_path)
    return MeteredProvider(stub, _settings(), tmp_path)


def _client(tmp_path):
    os.environ["META_API_KEY"] = "test-key"
    return TestClient(create_app(data_dir=tmp_path))


@pytest.mark.anyio
async def test_answer_chat_serves_model_lines(tmp_path):
    stub = StubProvider(data={"lines": ["One.", "Two."], "relation": "general"})
    answer = await answer_chat(
        provider=_provider(stub, tmp_path),
        question="how are you?",
        request_id="r1",
        settings=_settings(),
    )
    assert answer.lines == ["One.", "Two."]
    assert answer.relation == "general"
    assert stub.calls[0]["cache_key"] == "mascot"
    assert stub.calls[0]["max_tokens"] == _settings().mascot_max_tokens


@pytest.mark.anyio
async def test_answer_chat_lesson_relation_gets_canned_redirect(tmp_path):
    stub = StubProvider(data={
        "lines": ["A charming question!"],
        "relation": "lesson",
    })
    answer = await answer_chat(
        provider=_provider(stub, tmp_path),
        question="what does chapter 3 say about ziggurats?",
        request_id="r-lesson",
        settings=_settings(),
    )
    assert answer.relation == "lesson"
    assert answer.lines == [
        _LESSON_REDIRECTS[
            int(__import__("hashlib").sha256(b"r-lesson").hexdigest(), 16)
            % len(_LESSON_REDIRECTS)
        ]
    ]


@pytest.mark.anyio
async def test_answer_chat_empty_lines_fall_back(tmp_path):
    stub = StubProvider(data={"lines": ["  ", ""], "relation": "app"})
    answer = await answer_chat(
        provider=_provider(stub, tmp_path),
        question="?",
        request_id="r2",
        settings=_settings(),
    )
    assert answer.lines == [_FALLBACK_LINE]


@pytest.mark.anyio
async def test_answer_chat_unknown_relation_normalizes_to_general(tmp_path):
    stub = StubProvider(data={"lines": ["Sure."], "relation": "weird"})
    answer = await answer_chat(
        provider=_provider(stub, tmp_path),
        question="?",
        request_id="r3",
        settings=_settings(),
    )
    assert answer.relation == "general"
    assert answer.lines == ["Sure."]


def test_mascot_endpoint_happy_path(tmp_path):
    with _client(tmp_path) as client:
        stub = StubProvider()
        client.app.state.mascot_provider = _provider(stub, tmp_path)
        resp = client.post(
            "/api/mascot/chat",
            json={"question": "what can you do?", "request_id": "rq-1"},
        )
        assert resp.status_code == 200
        interaction = resp.json()["interaction"]
        assert interaction["kind"] == "mascot"
        assert interaction["lines"] == [
            "Upload a PDF and I spin it into a lesson."
        ]
        assert interaction["answer"] == "Upload a PDF and I spin it into a lesson."
        assert interaction["userMessage"] == "what can you do?"
        assert interaction["requestId"] == "rq-1"
        assert len(stub.calls) == 1


def test_mascot_endpoint_validates_question(tmp_path):
    with _client(tmp_path) as client:
        blank = client.post(
            "/api/mascot/chat", json={"question": "   ", "request_id": "r"}
        )
        assert blank.status_code == 422
        long = client.post(
            "/api/mascot/chat",
            json={"question": "x" * 501, "request_id": "r"},
        )
        assert long.status_code == 422


def test_mascot_endpoint_provider_error_is_503_envelope(tmp_path):
    with _client(tmp_path) as client:
        stub = StubProvider(
            error=ModelProviderError("UPSTREAM_TIMEOUT", "Upstream slow", retryable=True)
        )
        client.app.state.mascot_provider = _provider(stub, tmp_path)
        resp = client.post(
            "/api/mascot/chat", json={"question": "hi", "request_id": "r"}
        )
        assert resp.status_code == 503
        assert resp.json()["error"]["code"] == "UPSTREAM_TIMEOUT"
        assert resp.json()["error"]["retryable"] is True


def test_mascot_endpoint_rate_limits_per_ip(tmp_path):
    from app.api.mascot import _hits

    _hits.clear()
    with _client(tmp_path) as client:
        stub = StubProvider()
        client.app.state.mascot_provider = _provider(stub, tmp_path)
        client.app.state.settings = _settings(mascot_rate_limit_per_minute=2)
        for _ in range(2):
            ok = client.post(
                "/api/mascot/chat", json={"question": "hi", "request_id": "r"}
            )
            assert ok.status_code == 200
        blocked = client.post(
            "/api/mascot/chat", json={"question": "hi", "request_id": "r"}
        )
        assert blocked.status_code == 429
        assert blocked.json()["error"]["code"] == "RATE_LIMITED"
        assert len(stub.calls) == 2  # the limited call never reached the model


def test_mascot_rate_window_recovers(tmp_path):
    from app.api.mascot import _hits, _rate_limited

    _hits.clear()
    ip = "test-host"
    assert _rate_limited(ip, 1) is False
    assert _rate_limited(ip, 1) is True
    _hits[ip][0] = time.monotonic() - 61
    assert _rate_limited(ip, 1) is False
