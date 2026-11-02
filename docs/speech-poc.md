# Mita voice POC

Mita's voice is off until enabled in Menu. The same switch applies to Home,
lessons, and tutor replies for the current page visit. Reloading resets it.
Learner messages, answer options, citations, and gallery/backlog browsing are silent.

## Setup (Windows)

From the project root, with the normal backend venv and `.env` already configured:

```powershell
uv pip install --python backend/.venv/Scripts/python.exe -r backend/requirements-speech.txt
.\backend\.venv\Scripts\python.exe backend/scripts/setup_speech.py
npm run dev
```

The setup downloads approximately 121 MB of pinned model/voice files into
`backend/data/speech`, verifies SHA-256, and skips already verified files. Weights
are local, generated audio is not saved by the service, and the app never
downloads a model on startup. `SPEECH_MODEL_DIR` optionally overrides the model
directory (use an absolute path). Normal app startup remains usable without the
optional packages or models; voice then offers retry while text keeps working.

Use Menu → Mita’s voice, then close Menu. If the browser requires another user
gesture, select **Play voice**. **Retry voice** retries the current line after a
failure. Turning voice off stops playback and releases all cached audio.

## Runtime and bounds

- Native `kokoro-onnx==0.6.1`, Kokoro v1.0 int8, `af_heart`, English, speed 1.0.
  Fixed settings; existing emotion metadata still controls animation only.
- `POST /api/speech` accepts `{ "text": "..." }`, trimmed, 1–4,000 characters.
  Success returns `audio/mpeg`, `Cache-Control: no-store`. Failures use the normal
  error envelope: 422 invalid input, 429 busy/rate limit, 503 unavailable/timeout.
- One inference thread, two admitted calls, 120 accepted calls/minute/IP,
  30-second response deadline, and 4 MiB output limit. CPU work cannot be killed
  safely inside ONNX: timed-out/disconnected calls retain their admission slots
  until inference finishes, preventing an unbounded background queue.
- The browser prioritizes the current line, then prepares three known lines
  sequentially. It keeps at most four Blob URLs, deduplicates requests, and
  revokes URLs on eviction, mute, or teardown. No audio uses IndexedDB,
  localStorage, or a service worker.
- Automatic progression waits for both the existing reading timer and speech.
  A reveal click preserves speech; an advance cancels it. Dialogs and hidden
  tabs pause playback/progression. Navigation and rewind invalidate old audio.

## Runtime decision and limits

The initially planned Kokoro-FastAPI CPU Docker image v0.9.2 was tested here.
This host's Docker VM has 2 CPUs and 1.2 GiB RAM: a normal lesson line required
about 52 seconds and exceeded the app's 30-second limit. Limiting math-library
threads did not make that runtime suitable here.

Native int8 ONNX avoids that VM. Initial direct measurements on this host:
model load 5.8s, short line 1.9s, 34-word lesson line 11.2s. These are local
measurements, not latency guarantees. First use loads the model; long lines or
contended hosts may hit the response deadline and continue text-only. Kokoro
provides neutral speech, not expressive whisper/shout performance or cloning.

Ponytail choice: keep one inference implementation and no cloud account,
deployment, or API credentials. If hosted inference becomes necessary,
[Cloudflare MeloTTS](https://developers.cloudflare.com/workers-ai/models/melotts/)
has a [free daily allowance](https://developers.cloudflare.com/workers-ai/platform/pricing/),
but requires a voice audition and credentials. No cloud provider is wired in.
Hugging Face's current [Space documentation](https://huggingface.co/docs/hub/spaces-overview)
requires a paid plan to create compute Spaces; CPU Basic has no hourly cost.

## Verification

```powershell
.\backend\.venv\Scripts\python.exe -m pytest backend/app/tests/test_speech.py -q
node scripts/verify-speech-controller.cjs
# Playwright/Edge must be available, as with the existing browser verifiers.
node scripts/verify-speech.cjs
# Requires the live backend and VRM asset; uses native HTMLAudio.
node scripts/verify-speech-live.cjs
.\backend\.venv\Scripts\python.exe backend/scripts/verify_speech_live.py
npm run lint
npm run build
```

The controller check uses Node 24's built-in TypeScript stripping (which prints
an experimental-feature warning). The browser verifier accepts
`PLAYER_VERIFY_URL`. The live check calls the actual app route, writes audition
clips/measurements under TEMP, and checks decoding, duration, and signal level.
Subjective pronunciation/voice quality needs listening to those clips.

Verified on this host: cold short line 7.9s (including model load), normal
lesson 17.5s under simultaneous browser/inference load, names/numbers 10.4s.
The long sample hit the 30.0s response deadline; its bounded background render
finished in 36.3s, producing a complete 34.7s clip for audition. A real avatar
browser run received MP3 successfully and emitted native `playing` and `ended`
events. After avoiding discarded Menu-toggle synthesis, a warm greeting took
4.1s with the real avatar visible. These measurements include contention and
are not an isolated benchmark.
