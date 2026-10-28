"""Live check for the B02 session state controller (task 4.2).

Runs against the staged live Pipeline A output in backend/data (episode
87116250-3f68-5f27-bcbe-4e2914249de4): creates a session, advances
deterministically to the first checkpoint, verifies rejection, reload,
idempotent replay, stale-version conflict, and the stripped episode read.
No model calls. Writes only learner_sessions/session_requests rows.

    ./.venv/Scripts/python.exe scripts/live_session_check.py
"""

import sqlite3
import sys
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fastapi.testclient import TestClient

from app.main import create_app

EPISODE_ID = "87116250-3f68-5f27-bcbe-4e2914249de4"
HIDDEN = ("correctOptionId", "correctExplanation", "incorrectExplanation", "feedback")


def main() -> int:
    with TestClient(create_app()) as client:  # default data_dir = backend/data
        response = client.get(f"/api/episodes/{EPISODE_ID}")
        response.raise_for_status()
        script = response.json()
        print(f"episode '{script['title']}' status={script['status']} scenes={len(script['scenes'])}")
        for scene in script["scenes"]:
            question = scene.get("question")
            if question:
                for field in HIDDEN:
                    assert field not in question, f"{scene['sceneId']} leaks {field}"
                assert question["prompt"] and question["options"]
        print("learner episode read: no grading fields in", 
              sum(1 for s in script["scenes"] if s.get("question")), "checkpoint questions")

        inspection = client.get(f"/api/documents/{script['documentId']}/inspection/episode").json()
        keyed = [s for s in inspection["scenes"] if s.get("question")]
        assert keyed and all("correctOptionId" in s["question"] for s in keyed)
        print("inspection read keeps answer keys:", [s["sceneId"] for s in keyed])

        response = client.post(f"/api/episodes/{EPISODE_ID}/sessions")
        response.raise_for_status()
        session = response.json()
        sid = session["sessionId"]
        print(f"session {sid}: scene={session['sceneId']} idx={session['dialogueIndex']} "
              f"mode={session['mode']} status={session['status']} v={session['version']}")
        assert session["sceneId"] == script["startSceneId"]
        assert session["mode"] == "playing" and session["status"] == "active"
        assert session["version"] == 1 and session["dialogueIndex"] == 0

        first_request = None
        steps = 0
        while session["mode"] == "playing" and steps < 50:
            request_id = uuid.uuid4().hex
            first_request = first_request or (request_id, session["version"])
            response = client.post(
                f"/api/sessions/{sid}/advance",
                json={"request_id": request_id, "expected_version": session["version"]},
            )
            response.raise_for_status()
            session = response.json()
            steps += 1
        print(f"{steps} advances -> scene={session['sceneId']} mode={session['mode']} v={session['version']}")
        assert session["sceneId"] == "scene-03-checkpoint-1"
        assert session["mode"] == "checkpoint"

        response = client.post(
            f"/api/sessions/{sid}/advance",
            json={"request_id": uuid.uuid4().hex, "expected_version": session["version"]},
        )
        assert response.status_code == 409
        assert response.json()["error"]["code"] == "INVALID_SESSION_TRANSITION"
        print("advance at unanswered checkpoint -> 409 INVALID_SESSION_TRANSITION")

        response = client.post(
            f"/api/sessions/{sid}/advance",
            json={"request_id": first_request[0], "expected_version": first_request[1]},
        )
        response.raise_for_status()
        assert response.json()["version"] == session["version"]
        print("replayed first request_id -> idempotent, version unchanged")

        response = client.post(
            f"/api/sessions/{sid}/advance",
            json={"request_id": uuid.uuid4().hex, "expected_version": 1},
        )
        assert response.status_code == 409
        assert response.json()["error"]["code"] == "SESSION_CONFLICT"
        print("stale expected_version -> 409 SESSION_CONFLICT")

        restored = client.get(f"/api/sessions/{sid}").json()
        assert restored["sceneId"] == "scene-03-checkpoint-1"
        assert restored["mode"] == "checkpoint"
        assert restored["version"] == session["version"]
        print(f"GET restore: scene={restored['sceneId']} mode={restored['mode']} v={restored['version']}")

        conn = sqlite3.connect("data/app.db")
        row = conn.execute(
            "SELECT episode_id, mode, status, version FROM learner_sessions WHERE session_id = ?",
            (sid,),
        ).fetchone()
        requests = conn.execute(
            "SELECT COUNT(*) FROM session_requests WHERE session_id = ?", (sid,)
        ).fetchone()[0]
        conn.close()
        assert row == (EPISODE_ID, "checkpoint", "active", session["version"])
        print(f"db row: {row}, request tombstones: {requests}")
    print("LIVE CHECK PASSED")
    return 0


if __name__ == "__main__":
    sys.exit(main())
