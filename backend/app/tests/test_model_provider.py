import json
import os

import httpx
import pytest

from app.config import Settings
from app.services.model_provider import MetaProvider, ModelProviderError


def _settings(key: str = "secret-key-abc") -> Settings:
    os.environ["META_API_KEY"] = key
    return Settings(_env_file=None)


def _provider(handler, key: str = "secret-key-abc", **kw) -> MetaProvider:
    return MetaProvider(_settings(key), transport=httpx.MockTransport(handler), **kw)


def _ok_body(text: str = "hello", usage: dict | None = None) -> dict:
    return {
        "choices": [{"message": {"content": text}}],
        "usage": usage or {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15},
    }


def _resp(body: dict, status: int = 200) -> httpx.Response:
    return httpx.Response(status, json=body)


def test_provider_uses_configured_request_timeout():
    settings = _settings()
    settings.model_request_timeout_seconds = 123
    assert MetaProvider(settings)._timeout == 123


SCHEMA = {
    "type": "object",
    "required": ["title", "score"],
    "properties": {
        "title": {"type": "string"},
        "score": {"type": "integer"},
        "tags": {"type": "array", "items": {"type": "string"}},
    },
}


@pytest.mark.anyio
async def test_generate_text_returns_content_and_usage():
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["auth"] = request.headers["authorization"]
        seen["payload"] = json.loads(request.content)
        return _resp(_ok_body("answer text"))

    result = await _provider(handler).generate_text(system="s", user="u")
    assert result.text == "answer text"
    assert result.usage["total_tokens"] == 15
    assert seen["auth"] == "Bearer secret-key-abc"
    assert seen["payload"]["model"] == "muse-spark-1.3-contributor"


@pytest.mark.anyio
async def test_generate_structured_validates_against_schema():
    def handler(request: httpx.Request) -> httpx.Response:
        payload = json.loads(request.content)
        assert payload["response_format"]["type"] == "json_schema"
        return _resp(_ok_body(json.dumps({"title": "T", "score": 4, "tags": ["a"]})))

    result = await _provider(handler).generate_structured(system="s", user="u", schema=SCHEMA)
    assert result.data == {"title": "T", "score": 4, "tags": ["a"]}
    assert result.usage["total_tokens"] == 15


@pytest.mark.anyio
async def test_recursive_schema_rejected_without_http():
    calls = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        return _resp(_ok_body())

    schema = {"type": "object", "properties": {"next": {"$ref": "#/$defs/node"}},
              "$defs": {"node": {"type": "object"}}}
    with pytest.raises(ModelProviderError) as exc_info:
        await _provider(handler).generate_structured(system="s", user="u", schema=schema)
    assert exc_info.value.code == "SCHEMA_UNSUPPORTED"
    assert exc_info.value.retryable is False
    assert calls == []


@pytest.mark.anyio
async def test_malformed_json_output_fails():
    def handler(request: httpx.Request) -> httpx.Response:
        return _resp(_ok_body("not json at all"))

    with pytest.raises(ModelProviderError) as exc_info:
        await _provider(handler).generate_structured(system="s", user="u", schema=SCHEMA)
    assert exc_info.value.code == "BAD_JSON"


@pytest.mark.anyio
async def test_schema_mismatch_fails():
    def handler(request: httpx.Request) -> httpx.Response:
        return _resp(_ok_body(json.dumps({"title": "T"})))

    with pytest.raises(ModelProviderError) as exc_info:
        await _provider(handler).generate_structured(system="s", user="u", schema=SCHEMA)
    assert exc_info.value.code == "SCHEMA_MISMATCH"


@pytest.mark.anyio
async def test_timeout_then_success():
    calls = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        if len(calls) == 1:
            raise httpx.ReadTimeout("boom", request=request)
        return _resp(_ok_body("recovered"))

    result = await _provider(handler).generate_text(system="s", user="u")
    assert result.text == "recovered"
    assert len(calls) == 2


@pytest.mark.anyio
async def test_all_timeouts_raise_retryable():
    calls = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        raise httpx.ReadTimeout("boom", request=request)

    with pytest.raises(ModelProviderError) as exc_info:
        await _provider(handler).generate_text(system="s", user="u")
    assert exc_info.value.retryable is True
    assert exc_info.value.code == "UPSTREAM_TIMEOUT"
    assert len(calls) == 3


@pytest.mark.anyio
async def test_5xx_and_429_retried_4xx_not():
    def h_500(request):
        return httpx.Response(500, text="err")

    with pytest.raises(ModelProviderError) as e500:
        await _provider(h_500).generate_text(system="s", user="u")
    assert e500.value.retryable is True

    calls = []

    def h_401(request):
        calls.append(request)
        return httpx.Response(401, text="unauthorized")

    with pytest.raises(ModelProviderError) as e401:
        await _provider(h_401).generate_text(system="s", user="u")
    assert e401.value.retryable is False
    assert len(calls) == 1


@pytest.mark.anyio
async def test_key_never_serialized():
    def handler(request):
        return httpx.Response(400, text="bad request")

    try:
        await _provider(handler, key="s3cr3t-XyZ").generate_text(system="s", user="u")
    except ModelProviderError as exc:
        assert "s3cr3t-XyZ" not in exc.message
        assert "s3cr3t-XyZ" not in str(exc)


@pytest.mark.anyio
async def test_count_input_tokens_shape_and_parse():
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["url"] = str(request.url)
        seen["payload"] = json.loads(request.content)
        return _resp({"object": "response.input_tokens", "input_tokens": 1234})

    n = await _provider(handler).count_input_tokens(system="sys prompt", user="user text")
    assert n == 1234
    assert seen["url"].endswith("/responses/input_tokens")
    assert seen["payload"] == {
        "model": "muse-spark-1.3-contributor",
        "instructions": "sys prompt",
        "input": "user text",
    }


@pytest.mark.anyio
async def test_count_input_tokens_retries_transient():
    calls = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        if len(calls) == 1:
            return httpx.Response(500, text="err")
        return _resp({"input_tokens": 7})

    assert await _provider(handler).count_input_tokens(system="s", user="u") == 7
    assert len(calls) == 2


@pytest.mark.anyio
async def test_count_input_tokens_bad_body():
    def handler(request: httpx.Request) -> httpx.Response:
        return _resp({"unexpected": True})

    with pytest.raises(ModelProviderError) as exc_info:
        await _provider(handler).count_input_tokens(system="s", user="u")
    assert exc_info.value.code == "BAD_RESPONSE"


@pytest.mark.anyio
async def test_prompt_cache_key_forwarded_only_when_set():
    payloads = []

    def handler(request: httpx.Request) -> httpx.Response:
        payloads.append(json.loads(request.content))
        return _resp(_ok_body())

    provider = _provider(handler)
    await provider.generate_text(system="s", user="u")
    await provider.generate_text(system="s", user="u", cache_key="analyze")
    assert "prompt_cache_key" not in payloads[0]
    assert payloads[1]["prompt_cache_key"] == "analyze"


@pytest.mark.anyio
async def test_cached_tokens_survive_in_usage():
    def handler(request: httpx.Request) -> httpx.Response:
        return _resp(_ok_body(usage={
            "prompt_tokens": 100,
            "completion_tokens": 5,
            "total_tokens": 105,
            "prompt_tokens_details": {"cached_tokens": 80},
        }))

    result = await _provider(handler).generate_text(system="s", user="u")
    assert result.usage["prompt_tokens_details"]["cached_tokens"] == 80
    assert result.usage["total_tokens"] == 105


@pytest.mark.anyio
async def test_live_capped_structured_call():
    if os.environ.get("JUSTMAYA_LIVE") != "1":
        pytest.skip("set JUSTMAYA_LIVE=1 to run the live endpoint check")
    saved = os.environ.pop("META_API_KEY", None)  # real .env key wins over the test placeholder
    try:
        provider = MetaProvider(Settings())
    finally:
        if saved is not None:
            os.environ["META_API_KEY"] = saved
    data = await provider.generate_structured(
        system="Ответь строго JSON.",
        user='Верни {"ok": true, "n": 1}',
        schema={"type": "object", "required": ["ok"],
                "properties": {"ok": {"type": "boolean"}, "n": {"type": "integer"}}},
        max_tokens=1024,  # reasoning model: needs ~400 tokens before content
    )
    assert isinstance(data.data.get("ok"), bool)

    result = await provider.generate_text(system="s", user="say hi", max_tokens=1024)
    assert result.text
    assert "total_tokens" in result.usage
