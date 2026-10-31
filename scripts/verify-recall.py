"""Exercise the recall-checkpoint contract against a SQLite backup of the
published Episode 1 — elimination grading, per-option released feedback via
the compatibility fallback chain, zero model calls."""
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
    staged = Path(tempfile.mkdtemp(prefix="meet-mita-recall-"))
    with sqlite3.connect(ROOT / "backend/data/app.db") as source, sqlite3.connect(staged / "app.db") as target:
        source.backup(target)
    with sqlite3.connect(staged / "app.db") as conn:
        episodes = [json.loads(r[0]) for r in conn.execute("SELECT payload FROM episodes WHERE status='ready'")]
    required = ["s3-check1", "s5-check2"]
    episode = next(e for e in episodes if all(s in {s['sceneId'] for s in e['scenes']} for s in required))
    evidence = []
    with TestClient(create_app(data_dir=staged)) as client:
        def post(path, body=None):
            result = client.post(path, json=body)
            assert result.status_code == 200, result.text
            return result.json()
        for outcome in ["correct-first", "wrong-correct", "all-wrong"]:
            session = post(f"/api/episodes/{episode['episodeId']}/sessions")
            missed = 0
            for scene_id in required:
                while session['sceneId'] != scene_id:
                    session = post(f"/api/sessions/{session['sessionId']}/advance", {"request_id": uuid.uuid4().hex, "expected_version": session['version']})
                question = next(s['question'] for s in episode['scenes'] if s['sceneId'] == scene_id)
                right = question['correctOptionId']
                wrongs = [o['optionId'] for o in question['options'] if o['optionId'] != right]
                if outcome == 'correct-first':
                    answers = [right]
                elif outcome == 'wrong-correct':
                    answers = [wrongs[0], right]
                else:
                    answers = [*wrongs, right]
                missed += bool(wrongs and outcome != 'correct-first')
                for option in answers:
                    body = {"request_id": uuid.uuid4().hex, "expected_version": session['version'], "questionId": question['questionId'], "optionId": option}
                    session = post(f"/api/sessions/{session['sessionId']}/answers", body)
                    assert post(f"/api/sessions/{session['sessionId']}/answers", body) == session
                    assert client.get(f"/api/sessions/{session['sessionId']}").json() == session
                    if option != right:
                        checkpoint = session['checkpoint']
                        assert not checkpoint['checkpointCompleted']
                        assert 'correctOptionId' not in checkpoint
                        assert checkpoint['feedback']
                        # an eliminated option is rejected without burning state
                        repick = client.post(f"/api/sessions/{session['sessionId']}/answers", json={**body, "request_id": uuid.uuid4().hex, "expected_version": session['version']})
                        assert repick.status_code == 422, repick.text
                        assert client.get(f"/api/sessions/{session['sessionId']}").json() == session
                checkpoint = session['checkpoint']
                assert checkpoint['checkpointCompleted'] and checkpoint['isCorrect'] is True
                assert checkpoint['correctOptionId'] == right
                assert checkpoint['attemptsUsed'] == len(answers)
                evidence.append({"checkpoint": scene_id, "prompt": question['prompt'], "outcome": outcome, "result": "PASS"})
                session = post(f"/api/sessions/{session['sessionId']}/advance", {"request_id": uuid.uuid4().hex, "expected_version": session['version']})
            assert len(session['learningNotes']) == missed  # one note per checkpoint missed on
    manifest = {"dataDir": str(staged), "episode": episode, "evidence": evidence, "modelCalls": 0}
    (staged / "verification.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    print(json.dumps({"dataDir": str(staged), "episodeId": episode['episodeId'], "checks": len(evidence), "modelCalls": 0}))


if __name__ == '__main__':
    main()
