"""Exercise B04 against a SQLite backup of the published Episode 1, zero model calls."""
import json
import os
from pathlib import Path
import sqlite3
import sys
import tempfile
import uuid

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))
os.environ["META_API_KEY"] = "verification-dummy-key"

from fastapi.testclient import TestClient
from app.main import create_app
from app.services.token_budget import MeteredProvider


async def forbidden(*args, **kwargs):
    raise AssertionError("Checkpoint playback must never call the model")


def main():
    MeteredProvider.generate_structured = forbidden
    staged = Path(tempfile.mkdtemp(prefix="justmaya-recall-"))
    with sqlite3.connect(ROOT / "backend/data/app.db") as source, sqlite3.connect(staged / "app.db") as target:
        source.backup(target)
    with sqlite3.connect(staged / "app.db") as conn:
        episodes = [json.loads(r[0]) for r in conn.execute("SELECT payload FROM episodes WHERE status='ready'")]
    required = ["scene-03-checkpoint-1", "scene-05-checkpoint-2"]
    episode = next(e for e in episodes if all(s in {s['sceneId'] for s in e['scenes']} for s in required))
    evidence = []
    with TestClient(create_app(data_dir=staged)) as client:
        def post(path, body=None):
            result = client.post(path, json=body)
            assert result.status_code == 200, result.text
            return result.json()
        for outcome in ["correct-first", "wrong-correct", "wrong-wrong"]:
            session = post(f"/api/episodes/{episode['episodeId']}/sessions")
            for scene_id in required:
                while session['sceneId'] != scene_id:
                    session = post(f"/api/sessions/{session['sessionId']}/advance", {"request_id": uuid.uuid4().hex, "expected_version": session['version']})
                question = next(s['question'] for s in episode['scenes'] if s['sceneId'] == scene_id)
                wrong = next(o['optionId'] for o in question['options'] if o['optionId'] != question['correctOptionId'])
                options = [question['correctOptionId']] if outcome == 'correct-first' else [wrong, question['correctOptionId'] if outcome == 'wrong-correct' else wrong]
                for option in options:
                    body = {"request_id": uuid.uuid4().hex, "expected_version": session['version'], "questionId": question['questionId'], "optionId": option}
                    session = post(f"/api/sessions/{session['sessionId']}/answers", body)
                    assert post(f"/api/sessions/{session['sessionId']}/answers", body) == session
                    assert client.get(f"/api/sessions/{session['sessionId']}").json() == session
                    if not session['checkpoint']['checkpointCompleted']:
                        assert 'correctOptionId' not in session['checkpoint']
                        assert session['checkpoint']['attemptsRemaining'] == 1
                assert session['checkpoint']['checkpointCompleted']
                assert session['checkpoint']['isCorrect'] == (outcome != 'wrong-wrong')
                assert session['checkpoint']['attemptsUsed'] == len(options)
                evidence.append({"checkpoint": scene_id, "prompt": question['prompt'], "outcome": outcome, "result": "PASS"})
                session = post(f"/api/sessions/{session['sessionId']}/advance", {"request_id": uuid.uuid4().hex, "expected_version": session['version']})
            assert len(session['learningNotes']) == (2 if outcome == 'wrong-wrong' else 0)
    manifest = {"dataDir": str(staged), "episode": episode, "evidence": evidence, "modelCalls": 0}
    (staged / "verification.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    print(json.dumps({"dataDir": str(staged), "episodeId": episode['episodeId'], "checks": len(evidence), "modelCalls": 0}))


if __name__ == '__main__':
    main()
