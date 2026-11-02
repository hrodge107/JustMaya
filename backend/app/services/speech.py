"""Optional, bounded native Kokoro synthesis; never loads a model at app startup."""

import asyncio
import io
import logging
import time
from collections import deque
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

log = logging.getLogger(__name__)
MAX_AUDIO_BYTES = 4 * 1024 * 1024
SPEECH_TIMEOUT = 30


class SpeechError(Exception):
    def __init__(self, code: str, message: str, status: int = 503):
        super().__init__(message)
        self.code, self.status = code, status


class SpeechService:
    def __init__(self, model_dir: Path, *, render=None):
        self.model_dir = model_dir
        self.model = None
        self.render = render or self._render
        self.executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="mita-voice")
        self.running: set[asyncio.Future] = set()
        # ponytail: one process, one inference thread, two admitted calls; use a
        # hosted inference endpoint if measured multi-user demand outgrows this.
        self.hits: dict[str, deque[float]] = {}

    async def close(self):
        self.executor.shutdown(wait=False, cancel_futures=True)
        if self.running:
            await asyncio.gather(*self.running, return_exceptions=True)

    def admit(self, ip: str):
        now = time.monotonic()
        for key in list(self.hits):
            if self.hits[key][-1] <= now - 60:
                del self.hits[key]
        if ip not in self.hits and len(self.hits) >= 4096:
            raise SpeechError("SPEECH_BUSY", "Voice is busy. Try again shortly.", 429)
        hits = self.hits.get(ip, deque())
        while hits and hits[0] <= now - 60:
            hits.popleft()
        if len(hits) >= 120 or len(self.running) >= 2:
            raise SpeechError("SPEECH_BUSY", "Voice is busy. Try again shortly.", 429)
        hits.append(now)
        self.hits[ip] = hits

    def _render(self, text: str) -> bytes:
        import onnxruntime as rt
        import soundfile as sf
        from kokoro_onnx import Kokoro

        if self.model is None:
            options = rt.SessionOptions()
            options.intra_op_num_threads = 2
            options.inter_op_num_threads = 1
            session = rt.InferenceSession(
                str(self.model_dir / "kokoro-v1.0.int8.onnx"), sess_options=options,
                providers=["CPUExecutionProvider"],
            )
            self.model = Kokoro.from_session(session, str(self.model_dir / "voices-v1.0.bin"))
        samples, sample_rate = self.model.create(text, voice="af_heart", speed=1.0, lang="en-us")
        audio = io.BytesIO()
        sf.write(audio, samples, sample_rate, format="MP3")
        return audio.getvalue()

    async def synthesize(self, text: str, ip: str) -> bytes:
        self.admit(ip)
        started = time.monotonic()
        future = asyncio.get_running_loop().run_in_executor(self.executor, self.render, text)
        self.running.add(future)

        def finished(task):
            self.running.discard(task)
            # Retrieve failures even when the HTTP caller already timed out.
            if not task.cancelled():
                task.exception()

        future.add_done_callback(finished)
        try:
            # CPU inference cannot be interrupted safely. Keep its admission
            # slot until the thread finishes, including after timeout/cancel.
            async with asyncio.timeout(SPEECH_TIMEOUT):
                audio = await asyncio.shield(future)
            if not audio or len(audio) > MAX_AUDIO_BYTES:
                raise SpeechError("SPEECH_UNAVAILABLE", "Voice returned invalid audio.")
            return audio
        except TimeoutError as exc:
            raise SpeechError("SPEECH_TIMEOUT", "Voice took too long. Continue reading or retry.") from exc
        except SpeechError:
            raise
        except Exception as exc:
            log.warning("speech unavailable (%s)", type(exc).__name__)
            raise SpeechError("SPEECH_UNAVAILABLE", "Voice is unavailable. Continue reading or retry.") from exc
        finally:
            log.info("speech finished in %.2fs", time.monotonic() - started)
