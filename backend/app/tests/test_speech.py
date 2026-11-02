import asyncio
import sys
import threading
import time
from collections import deque
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from app.main import create_app
from app.services.speech import MAX_AUDIO_BYTES, SpeechError, SpeechService


def test_speech_boundary(tmp_path):
    calls = []
    with TestClient(create_app(data_dir=tmp_path)) as client:
        client.app.state.speech.render = lambda text: calls.append(text) or b"ID3audio"
        for body in ({"text": "  "}, {"text": "x" * 4001}, {"text": 7}, {"text": "Hi", "voice": "other"}, {}):
            assert client.post("/api/speech", json=body).status_code == 422
        assert calls == []
        response = client.post("/api/speech", json={"text": "  Hello Mita.  "})
        assert response.status_code == 200
        assert response.content == b"ID3audio"
        assert response.headers["content-type"] == "audio/mpeg"
        assert response.headers["cache-control"] == "no-store"
        assert calls == ["Hello Mita."]


def test_speech_fixed_voice_and_encoding(tmp_path, monkeypatch):
    calls = []
    model = SimpleNamespace(create=lambda *args, **kwargs: (calls.append((args, kwargs)) or ([1], 24000)))
    monkeypatch.setitem(sys.modules, "onnxruntime", SimpleNamespace())
    monkeypatch.setitem(sys.modules, "kokoro_onnx", SimpleNamespace(Kokoro=object))
    def encode(output, samples, rate, **kwargs):
        assert samples == [1] and rate == 24000 and kwargs == {"format": "MP3"}
        output.write(b"ID3")
    monkeypatch.setitem(sys.modules, "soundfile", SimpleNamespace(write=encode))
    service = SpeechService(tmp_path)
    service.model = model
    try:
        assert service._render("Hello.") == b"ID3"
        assert calls == [(("Hello.",), {"voice": "af_heart", "speed": 1.0, "lang": "en-us"})]
    finally:
        service.executor.shutdown()


@pytest.mark.anyio
@pytest.mark.parametrize("failure", ["runtime", "empty", "large"])
async def test_speech_render_failures(tmp_path, failure):
    def render(text):
        if failure == "runtime":
            raise ImportError("optional speech package unavailable")
        return b"" if failure == "empty" else b"x" * (MAX_AUDIO_BYTES + 1)
    service = SpeechService(tmp_path, render=render)
    try:
        with pytest.raises(SpeechError) as exc:
            await service.synthesize("Hi.", "test")
        assert exc.value.code == "SPEECH_UNAVAILABLE"
        assert not service.running
    finally:
        await service.close()


@pytest.mark.anyio
async def test_speech_admission_and_cancellation(tmp_path):
    gate = threading.Event()
    service = SpeechService(tmp_path, render=lambda text: gate.wait(5) and b"ID3")
    first = asyncio.create_task(service.synthesize("one", "one"))
    second = asyncio.create_task(service.synthesize("two", "two"))
    try:
        await asyncio.sleep(.01)
        assert len(service.running) == 2
        with pytest.raises(SpeechError) as exc:
            await service.synthesize("three", "three")
        assert exc.value.status == 429
        first.cancel()
        with pytest.raises(asyncio.CancelledError):
            await first
        assert len(service.running) == 2, "canceled HTTP callers cannot grow the CPU work queue"
        gate.set()
        assert await second == b"ID3"
        assert not service.running
        for _ in range(120):
            service.admit("busy")
        with pytest.raises(SpeechError):
            service.admit("busy")
        service.hits["busy"] = deque([time.monotonic() - 61])
        service.admit("busy")
        assert len(service.hits["busy"]) == 1
    finally:
        gate.set()
        await service.close()


@pytest.mark.anyio
async def test_speech_timeout_keeps_inference_bounded(tmp_path, monkeypatch):
    import app.services.speech as speech
    monkeypatch.setattr(speech, "SPEECH_TIMEOUT", .01)
    gate = threading.Event()
    service = SpeechService(tmp_path, render=lambda text: gate.wait(5) and b"ID3")
    try:
        with pytest.raises(SpeechError) as exc:
            await service.synthesize("slow", "test")
        assert exc.value.code == "SPEECH_TIMEOUT"
        assert len(service.running) == 1
        gate.set()
    finally:
        gate.set()
        await service.close()
    assert not service.running


def test_speech_optional_startup_and_error_envelope(tmp_path):
    with TestClient(create_app(data_dir=tmp_path)) as client:
        service = client.app.state.speech
        assert client.get("/health").status_code == 200
        assert service.model is None
        def render(text):
            raise FileNotFoundError("models not installed")
        service.render = render
        response = client.post("/api/speech", json={"text": "Hi"})
        assert response.status_code == 503
        assert response.json()["error"]["code"] == "SPEECH_UNAVAILABLE"
        assert response.json()["error"]["retryable"] is True
        assert response.headers["cache-control"] == "no-store"
