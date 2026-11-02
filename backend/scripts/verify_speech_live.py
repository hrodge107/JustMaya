"""Real CPU Kokoro check through the app route; writes audition clips to TEMP."""
import asyncio
import io
import json
import sys
import tempfile
import time
from pathlib import Path

import numpy as np
import soundfile as sf
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app.main import create_app

samples = {
    "short": "Okay.",
    "lesson": "Rivers helped early farmers grow food. With a more reliable harvest, people could settle together and share their work. What do you think changed when families could store grain for the next season?",
    "names": "In Sumer, near the Tigris and Euphrates rivers, farmers stored 24 baskets of grain in 3000 BCE.",
    "long": " ".join([
        "A river gave people water for crops, but it also brought uncertainty.",
        "Floods could enrich the soil or damage a field, depending on their timing.",
        "Families learned to cooperate by building channels and sharing the work of maintaining them.",
        "A steady food supply helped communities grow, and some people could spend more time making tools or trading goods.",
        "These changes connected farming to the growth of towns, although no single cause explains every settlement.",
        "As you think about the evidence, separate what the passage states directly from what you can reasonably infer.",
    ]),
}


def main():
    output = Path(tempfile.mkdtemp(prefix="mita-speech-live-"))
    results = []
    with TestClient(create_app(data_dir=output / "data")) as client:
        for name, text in samples.items():
            started = time.perf_counter()
            response = client.post("/api/speech", json={"text": text})
            elapsed = time.perf_counter() - started
            outcome = "spoken"
            if name == "long" and response.status_code == 503:
                assert response.json()["error"]["code"] == "SPEECH_TIMEOUT"
                assert response.json()["error"]["retryable"] is True
                outcome = "text_only_timeout"
                # Collect the still-bounded CPU result for the pronunciation
                # audition; this does not change the production HTTP deadline.
                async def remaining_audio():
                    return await asyncio.shield(next(iter(client.app.state.speech.running)))
                audio = client.portal.call(remaining_audio)
            else:
                assert response.status_code == 200, (name, response.status_code, response.text)
                audio = response.content
            assert response.headers["cache-control"] == "no-store"
            clip = output / f"{name}.mp3"
            clip.write_bytes(audio)
            decoded, rate = sf.read(io.BytesIO(audio))
            duration = len(decoded) / rate
            rms = float(np.sqrt(np.mean(decoded * decoded))) * 32768
            assert rate == 24000
            assert duration > .2 and rms > 20, (name, duration, rms)
            results.append({"sample": name, "outcome": outcome, "seconds": round(elapsed, 3), "render_seconds": round(time.perf_counter() - started, 3), "audio_seconds": round(duration, 3), "bytes": len(audio), "rms": round(rms, 1), "file": str(clip)})
            (output / "results.json").write_text(json.dumps(results, indent=2), encoding="utf-8")
            print(json.dumps(results[-1]), flush=True)
    (output / "results.json").write_text(json.dumps(results, indent=2), encoding="utf-8")
    print(f"Audio/evidence: {output}")


if __name__ == "__main__":
    main()
