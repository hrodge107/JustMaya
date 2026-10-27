import httpx
import pytest

from app.services.wiki_supplement import fetch_summary


@pytest.mark.anyio
async def test_summary_provenance_and_cap_persist_across_calls(tmp_path):
    requests = []
    def respond(request):
        requests.append(str(request.url))
        return httpx.Response(200, json={"type": "standard", "title": "Physics", "extract": "Study of matter."})
    transport = httpx.MockTransport(respond)
    result = await fetch_summary(tmp_path, "doc", "Physics", [1], 1, 2, transport)
    assert result.origin == "web" and result.page_numbers == [1]
    assert result.url == "https://en.wikipedia.org/wiki/Physics" and result.retrieved_at
    assert await fetch_summary(tmp_path, "doc", "Physics", [1], 1, 2, transport) is None
    assert len(requests) == 1


@pytest.mark.anyio
async def test_untrusted_title_and_unavailable_or_disambiguation(tmp_path):
    requests = []
    def respond(request):
        requests.append(request)
        return httpx.Response(200, json={"type": "disambiguation", "title": "Foo", "extract": "Choices"})
    transport = httpx.MockTransport(respond)
    assert await fetch_summary(tmp_path, "doc", "https://attacker.example", [1], 2, 1, transport) is None
    assert not requests
    assert await fetch_summary(tmp_path, "doc", "Foo", [1], 2, 1, transport) is None
    assert requests[0].url.host == "en.wikipedia.org"
    failure = httpx.MockTransport(lambda request: httpx.Response(503))
    assert await fetch_summary(tmp_path, "doc", "Bar", [1], 2, 1, failure) is None


@pytest.mark.anyio
async def test_timeout_and_oversized_response_are_unavailable(tmp_path):
    def timeout(request):
        raise httpx.ReadTimeout("timeout", request=request)
    assert await fetch_summary(tmp_path, "one", "Physics", [1], 1, 1, httpx.MockTransport(timeout)) is None
    huge = httpx.MockTransport(lambda request: httpx.Response(200, content=b"x" * 100001))
    assert await fetch_summary(tmp_path, "two", "Physics", [1], 1, 1, huge) is None
