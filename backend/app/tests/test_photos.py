import io
import json
import sqlite3

import httpx
import pytest
from fastapi.testclient import TestClient
from PIL import Image

from app.config import Settings
from app.main import create_app
from app.pipeline.nodes import STAGES
from app.pipeline.runner import run_job
from app.pipeline.stage import StageContext
from app.services.model_provider import MetaProvider, ModelProviderError, StructuredResult
from app.services.photo_extractor import normalize_photo
from app.services.pdf_extractor import ExtractionError
from app.services.token_budget import MeteredProvider, TokenBudgetError, check_budget, job_usage, record_usage
from app.storage.artifacts import ArtifactStore


def image_bytes(fmt="PNG", size=(24, 48), **kwargs):
    output = io.BytesIO()
    Image.new("RGB", size, "white").save(output, format=fmt, **kwargs)
    return output.getvalue()


@pytest.fixture
def client(tmp_path):
    app = create_app(data_dir=tmp_path)
    app.state.settings = Settings(_env_file=None, meta_api_key="test", data_dir=tmp_path,
                                  checkpoint_db_path=tmp_path / "checkpoints.db")
    with TestClient(app) as client:
        yield client


def upload(client, count=1):
    return client.post("/api/documents/photos", files=[
        ("files", (f"page-{i}.png", image_bytes(), "image/png")) for i in range(1, count + 1)
    ])


@pytest.mark.parametrize("fmt", ["JPEG", "PNG", "WEBP"])
def test_normalization_formats_orientation_and_size(fmt):
    settings = Settings(_env_file=None, meta_api_key="test", photo_long_edge=32)
    data = image_bytes(fmt)
    if fmt == "JPEG":
        exif = Image.Exif(); exif[274] = 6
        data = image_bytes(fmt, exif=exif)
    normalized = normalize_photo(data, settings)
    image = Image.open(io.BytesIO(normalized))
    assert image.format == "JPEG" and max(image.size) == 32
    assert image.size == ((32, 16) if fmt == "JPEG" else (16, 32))
    with pytest.raises(ExtractionError, match="megapixel"):
        normalize_photo(data, settings.model_copy(update={"photo_max_pixels": 100}))
    with pytest.raises(ExtractionError, match="sending limit"):
        normalize_photo(data, settings.model_copy(update={"photo_normalized_bytes": 1}))


def test_upload_limits_types_and_cleanup(client):
    assert upload(client, 6).status_code == 422
    for data in (b"not an image", image_bytes("GIF")):
        assert client.post("/api/documents/photos", files=[("files", ("spoof.jpg", data, "image/jpeg"))]).status_code == 422
    output = io.BytesIO()
    Image.new("RGB", (20, 20), "white").save(output, format="PNG", save_all=True,
        append_images=[Image.new("RGB", (20, 20), "black")], duration=100, loop=0)
    assert client.post("/api/documents/photos", files=[("files", ("animated.png", output.getvalue(), "image/png"))]).status_code == 422
    settings = client.app.state.settings
    settings.photo_max_bytes = len(image_bytes()) - 1
    assert upload(client).status_code == 422
    settings.photo_max_bytes = 10000
    settings.photo_total_bytes = len(image_bytes()) * 2 - 1
    assert upload(client, 2).status_code == 422
    assert list((settings.data_dir / "storage").iterdir()) == []
    with sqlite3.connect(settings.data_dir / "app.db") as conn:
        assert conn.execute("SELECT COUNT(*) FROM documents").fetchone()[0] == 0


class PhotoProvider:
    def __init__(self, results):
        self.results = iter(results)
        self.calls = 0

    async def count_input_tokens(self, **kwargs):
        assert kwargs["images"][0].startswith("data:image/jpeg;base64,")
        return 1500

    async def generate_structured(self, **kwargs):
        self.calls += 1
        assert kwargs["max_tokens"] == 48000
        result = next(self.results)
        if isinstance(result, Exception):
            raise result
        return StructuredResult(result, {"prompt_tokens": 1500, "completion_tokens": 100, "total_tokens": 1600})


def readable(text="First line\nSecond line"):
    return {"status": "readable", "text": text, "omissions": []}


def test_pipeline_resume_omissions_pages_and_metering(client):
    job = upload(client, 3).json()
    settings = client.app.state.settings
    provider = PhotoProvider([readable(), ModelProviderError("HTTP_503", "retry"),
        {"status": "unreadable", "text": "discard this", "omissions": []},
        {"status": "partial", "text": "Reliable final page", "omissions": [{"line_number": 2, "reason": "blur"}]}])
    context = StageContext(settings, settings.data_dir, provider=provider)
    first = run_job(job["job_id"], settings, settings.data_dir, ctx=context, stages=STAGES[:1])
    assert first["job"]["status"] == "failed"
    second = run_job(job["job_id"], settings, settings.data_dir, ctx=context, stages=STAGES[:1])
    assert "error" not in second and provider.calls == 4
    extracted = json.loads(ArtifactStore(settings.data_dir / "storage").path(job["document_id"], "extracted").read_text())
    assert extracted["source_kind"] == "photos"
    assert [page["page_number"] for page in extracted["pages"]] == [1, 2, 3]
    assert [page["text"] for page in extracted["pages"]] == ["First line\nSecond line", "", "Reliable final page"]
    warnings = client.get(f"/api/jobs/{job['job_id']}").json()["warnings"]
    assert len(warnings) == 2 and "Photo 2" in warnings[0] and "Photo 3" in warnings[1]
    assert job_usage(settings.data_dir, job["job_id"])["by_stage"] == {"extract": 4800}


def test_unreadable_never_indexes_or_generates(client):
    job = upload(client).json()
    settings = client.app.state.settings
    provider = PhotoProvider([{"status": "unreadable", "text": "", "omissions": []}])
    result = run_job(job["job_id"], settings, settings.data_dir,
                     ctx=StageContext(settings, settings.data_dir, provider=provider))
    assert result["job"]["status"] == "failed" and "clearer photos" in result["error"]
    assert result["job"]["stage"] == "extract"
    assert not ArtifactStore(settings.data_dir / "storage").path(job["document_id"], "extracted").exists()


def test_five_photos_and_atomic_enqueue_failure(client, monkeypatch):
    from app.storage import documents
    settings = client.app.state.settings
    response = upload(client, 5)
    assert response.status_code == 201
    source = json.loads(ArtifactStore(settings.data_dir / "storage").path(response.json()["document_id"], "photos").read_text())
    assert [page["filename"] for page in source["pages"]] == [f"page-{i}.png" for i in range(1, 6)]
    before = set((settings.data_dir / "storage").iterdir())
    def fail(*args):
        raise RuntimeError("enqueue failed")
    monkeypatch.setattr(documents, "enqueue", fail)
    with pytest.raises(RuntimeError, match="enqueue failed"):
        upload(client, 2)
    assert set((settings.data_dir / "storage").iterdir()) == before
    with sqlite3.connect(settings.data_dir / "app.db") as conn:
        assert conn.execute("SELECT COUNT(*) FROM documents").fetchone()[0] == 1
        assert conn.execute("SELECT COUNT(*) FROM jobs").fetchone()[0] == 1


def test_photo_and_pdf_budget_separation(client):
    settings = client.app.state.settings
    job = upload(client).json()["job_id"]
    assert settings.photo_extract_budget == 300000 and settings.photo_job_budget == 900000
    check_budget(settings.data_dir, settings, job, "extract", 300000)
    with pytest.raises(TokenBudgetError):
        check_budget(settings.data_dir, settings, job, "extract", 300001)
    record_usage(settings.data_dir, job, "extract", {"total_tokens": 300000})
    check_budget(settings.data_dir, settings, job, "generate", 200000)
    record_usage(settings.data_dir, job, "generate", {"total_tokens": 600000})
    with pytest.raises(TokenBudgetError) as error:
        check_budget(settings.data_dir, settings, job, "validate", 1)
    assert error.value.scope == "job"
    with pytest.raises(TokenBudgetError):
        check_budget(settings.data_dir, settings, "non-photo", "extract", 200001)
    with pytest.raises(TokenBudgetError):
        check_budget(settings.data_dir, settings, "non-photo", "generate", 600001)


@pytest.mark.anyio
@pytest.mark.parametrize("choices", [
    [{"finish_reason": "length", "message": {"content": "{}"}}],
    [],
    [{"finish_reason": "stop", "message": {"content": "not JSON"}}],
])
async def test_vision_wire_count_truncation_and_failed_usage(client, choices):
    settings = client.app.state.settings
    job = upload(client).json()["job_id"]
    calls = []
    def handler(request):
        payload = json.loads(request.content)
        calls.append(payload)
        if request.url.path.endswith("input_tokens"):
            assert payload["input"][0]["content"][1] == {"type": "input_image", "image_url": "data:image/jpeg;base64,abc"}
            return httpx.Response(200, json={"input_tokens": 1500})
        assert payload["messages"][1]["content"][1]["image_url"]["url"] == "data:image/jpeg;base64,abc"
        return httpx.Response(200, json={"choices": choices,
            "usage": {"total_tokens": 2000}})
    provider = MeteredProvider(MetaProvider(settings, transport=httpx.MockTransport(handler)), settings, settings.data_dir)
    with pytest.raises(ModelProviderError):
        await provider.generate_structured(job_id=job, stage="extract", system="s", user="u",
            images=["data:image/jpeg;base64,abc"], schema={"type": "object"}, max_tokens=48000)
    assert job_usage(settings.data_dir, job)["total_tokens"] == 2000
    assert len(calls) == 2


@pytest.mark.anyio
async def test_vision_count_fails_closed_and_input_bound(client):
    settings = client.app.state.settings
    class CountProvider(PhotoProvider):
        async def count_input_tokens(self, **kwargs):
            if settings.photo_input_tokens == 8000:
                raise ModelProviderError("HTTP_500", "count failed")
            return 8001
    provider = CountProvider([])
    metered = MeteredProvider(provider, settings, settings.data_dir)
    for limit in (8000, 7999):
        settings.photo_input_tokens = limit
        with pytest.raises(ModelProviderError):
            await metered.generate_structured(job_id="job", stage="extract", system="s", user="u",
                images=["data:image/jpeg;base64,abc"], schema={}, max_tokens=48000)
    assert provider.calls == 0
