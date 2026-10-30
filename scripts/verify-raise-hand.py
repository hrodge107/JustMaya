"""Exercise B03 raise-hand tutoring against a SQLite backup of the published
episode. The tutor model is a deterministic stub injected through
app.state.tutor_provider; retrieval is a fixed passage set. Original data
and the real provider are untouched."""

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
from app.config import Settings
from app.main import create_app
from app.models.document import SourcePassage, SourceRef
from app.services.model_provider import GenerationResult, StructuredResult
from app.services.token_budget import MeteredProvider


class StubProvider:
    def __init__(self):
        self.calls = 0

    async def generate_text(self, **kw):
        self.calls += 1
        return GenerationResult(text="ok", usage={"prompt_tokens": 1, "total_tokens": 1})

    async def generate_structured(self, **kw):
        self.calls += 1
        return StructuredResult(
            data={
                "lines": [
                    "Maya explains the verification topic.",
                    "A second beat keeps the pacing honest.",
                    "And a third closes the thought.",
                ],
                "cited_chunk_ids": ["chunk-a", "hallucinated"],
                "grounding_status": "partial",
                "learning_note": "verification topic",
                "move": "explain",
                "engagement": "engaged",
            },
            usage={"prompt_tokens": 12, "completion_tokens": 7, "total_tokens": 19},
        )

    async def count_input_tokens(self, **kw):
        return 25


PASSAGES = [
    SourcePassage(
        chunk_id="chunk-a",
        text="Verification passage",
        source=SourceRef(chunk_id="chunk-a", document_id="d", page_start=2, page_end=3),
    )
]


def main():
    staged = Path(tempfile.mkdtemp(prefix="justmaya-raise-hand-"))
    with sqlite3.connect(ROOT / "backend/data/app.db") as source, sqlite3.connect(staged / "app.db") as target:
        source.backup(target)
    with sqlite3.connect(staged / "app.db") as conn:
        episodes = [json.loads(r[0]) for r in conn.execute("SELECT payload FROM episodes WHERE status='ready'")]
    episode = next(e for e in episodes if "scene-03-checkpoint-1" in {s["sceneId"] for s in e["scenes"]})

    settings = Settings(_env_file=None, data_dir=staged)
    app = create_app(data_dir=staged)
    stub = StubProvider()
    app.state.tutor_provider = MeteredProvider(stub, settings, staged)
    app.state.retriever = lambda document_id, query, **kw: PASSAGES

    evidence = []
    with TestClient(app) as client:
        def post(path, body=None):
            result = client.post(path, json=body)
            assert result.status_code == 200, result.text
            return result.json()

        session = post(f"/api/episodes/{episode['episodeId']}/sessions")
        sid = session["sessionId"]
        while session["sceneId"] != "scene-03-checkpoint-1":
            session = post(f"/api/sessions/{sid}/advance", {"request_id": uuid.uuid4().hex, "expected_version": session["version"]})

        # raise hand from the checkpoint -> snapshot + question mode
        raised = post(f"/api/sessions/{sid}/raise-hand", {"request_id": uuid.uuid4().hex, "expected_version": session["version"]})
        assert raised["mode"] == "question"
        assert raised["resumeSnapshot"] == {"sceneId": "scene-03-checkpoint-1", "dialogueIndex": 0, "mode": "checkpoint"}
        assert raised["tutorThreadId"] == f"{sid}:{raised['version']}"
        nested = client.post(f"/api/sessions/{sid}/raise-hand", json={"request_id": uuid.uuid4().hex, "expected_version": raised["version"]})
        assert nested.status_code == 409 and nested.json()["error"]["code"] == "INVALID_SESSION_TRANSITION"
        evidence.append({"check": "raise-hand from checkpoint snapshots once; nested raise rejected; thread identity assigned", "result": "PASS"})

        # grounded question -> verified citations, persisted interaction, session-scoped usage
        asked = post(f"/api/sessions/{sid}/questions", {"question": "What does the source say?", "request_id": "verify-q1", "expected_version": raised["version"]})
        assert asked["interaction"]["lines"] == [
            "Maya explains the verification topic.",
            "A second beat keeps the pacing honest.",
            "And a third closes the thought.",
        ]
        assert asked["interaction"]["answer"] == "\n".join(asked["interaction"]["lines"])
        assert asked["interaction"]["groundingStatus"] == "partial"
        assert [r["chunkId"] for r in asked["interaction"]["sourceRefs"]] == ["chunk-a"]
        assert asked["interaction"]["sourceRefs"][0]["pageStart"] == 2
        assert asked["session"]["learningNotes"] == ["verification topic"]
        flow = asked["interaction"]["flow"]
        assert flow["threadId"] == raised["tutorThreadId"] and flow["move"] == "explain"
        assert flow["helpMode"] == "explain" and flow["awaiting"] == "none"
        assert flow["topicQuestion"] == "What does the source say?"
        replayed = post(f"/api/sessions/{sid}/questions", {"question": "What does the source say?", "request_id": "verify-q1", "expected_version": raised["version"]})
        assert replayed["interaction"]["interactionId"] == asked["interaction"]["interactionId"]
        assert stub.calls == 1
        restored = client.get(f"/api/sessions/{sid}").json()
        assert restored["mode"] == "question" and restored["interactions"][-1]["requestId"] == "verify-q1"
        evidence.append({"check": "grounded answer verifies citations, persists with flow metadata, replays without a second call", "result": "PASS"})

        # anchored follow-up inherits the topic; a foreign anchor 422s pre-spend
        iid = asked["interaction"]["interactionId"]
        version = asked["session"]["version"]
        bad_anchor = client.post(f"/api/sessions/{sid}/questions", json={"question": "next?", "request_id": "verify-anchor-422", "expected_version": version, "reply_to_interaction_id": "ghost"})
        assert bad_anchor.status_code == 422 and stub.calls == 1
        anchored = post(f"/api/sessions/{sid}/questions", {"question": "and the second part?", "request_id": "verify-q2", "expected_version": version, "reply_to_interaction_id": iid})
        flow2 = anchored["interaction"]["flow"]
        assert flow2["replyToInteractionId"] == iid and flow2["topicQuestion"] == "What does the source say?"
        assert stub.calls == 2
        evidence.append({"check": "anchored follow-up inherits topic and parent; foreign anchor 422 before spend", "result": "PASS"})

        conn = sqlite3.connect(staged / "app.db")
        row = conn.execute("SELECT job_id, stage, total_tokens FROM token_usage ORDER BY usage_id DESC").fetchone()
        conn.close()
        assert row == (f"session:{sid}", "tutor", 19)
        evidence.append({"check": "tutor usage records under session:{id} scope at stage tutor", "result": "PASS"})

        # resume restores the checkpoint exactly
        resumed = post(f"/api/sessions/{sid}/resume", {"request_id": uuid.uuid4().hex, "expected_version": anchored["session"]["version"]})
        assert resumed["mode"] == "checkpoint" and resumed["sceneId"] == "scene-03-checkpoint-1"
        assert resumed["resumeSnapshot"] is None and resumed["checkpoint"]["attemptsUsed"] == 0
        assert "attemptsRemaining" not in resumed["checkpoint"]
        evidence.append({"check": "resume restores checkpoint position and clears the snapshot", "result": "PASS"})

        # failure surfaces leave clean state; validation rejects bad bodies
        raised2 = post(f"/api/sessions/{sid}/raise-hand", {"request_id": "h", "expected_version": resumed["version"]})
        assert raised2["mode"] == "question"
        for body in ({"question": "   ", "request_id": "b1", "expected_version": raised2["version"]},
                     {"question": "x" * 501, "request_id": "b2", "expected_version": raised2["version"]}):
            result = client.post(f"/api/sessions/{sid}/questions", json=body)
            assert result.status_code == 422
        conflict = client.post(f"/api/sessions/{sid}/questions", json={"question": "ok?", "request_id": "h", "expected_version": raised2["version"]})
        assert conflict.status_code == 409 and conflict.json()["error"]["code"] == "SESSION_CONFLICT"
        evidence.append({"check": "blank/overlong questions 422; cross-kind request id conflicts", "result": "PASS"})

        # a second session parked in question mode with a real persisted,
        # beat-structured answer lets the browser script verify reload restore
        parked_session = post(f"/api/episodes/{episode['episodeId']}/sessions")
        parked_sid = parked_session["sessionId"]
        post(f"/api/sessions/{parked_sid}/raise-hand", {"request_id": "verify-park-h", "expected_version": parked_session["version"]})
        parked_asked = post(f"/api/sessions/{parked_sid}/questions", {"question": "Parked question?", "request_id": "verify-park-q", "expected_version": parked_session["version"] + 1})
        assert parked_asked["session"]["mode"] == "question"
        assert len(parked_asked["interaction"]["lines"]) == 3
        evidence.append({"check": "persisted beat answer parked in question mode for browser reload checks", "result": "PASS"})

    manifest = {"dataDir": str(staged), "episode": episode, "evidence": evidence, "modelCalls": stub.calls, "questionSessionId": parked_sid, "questionInteraction": parked_asked["interaction"]}
    (staged / "verification.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    print(json.dumps({"dataDir": str(staged), "episodeId": episode["episodeId"], "checks": len(evidence), "modelCalls": stub.calls}))


if __name__ == "__main__":
    main()
