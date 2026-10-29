"""B03 Raise Hand tutoring — question-mode interrupt, grounded answers,
exact resume, dedup/replay, and the learner-safe interaction projection.

Same fixture shape as test_session.py: s1 dialogue -> s2 checkpoint ->
s3 ending. Service tests stub the provider and retriever; API tests inject
both through app.state.
"""

import os
import sqlite3
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app
from app.models.document import SourcePassage, SourceRef
from app.models.episode import (
    AnswerOption,
    DialogueLine,
    EpisodeScene,
    EpisodeScript,
    RecallQuestion,
)
from app.models.session import (
    AnswerRequest,
    QuestionRequest,
    TutorInteraction,
)
from app.services.model_provider import (
    GenerationResult,
    ModelProviderError,
    StructuredResult,
)
from app.services.session_controller import (
    InvalidSessionTransition,
    answer,
    new_session,
    raise_hand,
    resume,
)
from app.services.token_budget import MeteredProvider
from app.services.tutor import answer_question
from app.storage.database import init_db
from app.storage.sessions import (
    SessionConflict,
    apply_advance,
    apply_answer,
    apply_raise_hand,
    apply_resume,
    commit_question,
    create_session,
    get_session,
    prepare_question,
)


def _settings(**kw) -> Settings:
    os.environ["META_API_KEY"] = "test-key"
    return Settings(_env_file=None, **kw)


def _script(status="ready") -> EpisodeScript:
    return EpisodeScript(
        episodeId="ep",
        documentId="d",
        title="T",
        learningObjectives=["obj"],
        estimatedMinutes=3,
        startSceneId="s1",
        scenes=[
            EpisodeScene(
                sceneId="s1",
                kind="dialogue",
                dialogue=[
                    DialogueLine(lineId="l1", speaker="mascot", text="one", emotion="happy"),
                    DialogueLine(lineId="l2", speaker="mascot", text="two", emotion="talking"),
                ],
                nextSceneId="s2",
            ),
            EpisodeScene(
                sceneId="s2",
                kind="checkpoint",
                question=RecallQuestion(
                    questionId="q1",
                    prompt="P?",
                    objectiveId="o1",
                    options=[
                        AnswerOption(optionId="a", label="A"),
                        AnswerOption(optionId="b", label="B"),
                    ],
                    correctOptionId="a",
                    correctExplanation="yes",
                    incorrectExplanation="no",
                ),
                nextSceneId="s3",
            ),
            EpisodeScene(
                sceneId="s3",
                kind="ending",
                dialogue=[
                    DialogueLine(lineId="l3", speaker="mascot", text="done", emotion="happy"),
                ],
            ),
        ],
        status=status,
    )


def _seed(tmp_path):
    init_db(tmp_path)
    conn = sqlite3.connect(tmp_path / "app.db")
    with conn:
        conn.execute(
            "INSERT INTO documents (document_id, filename, status, created_at) "
            "VALUES ('d', 'a.pdf', 'ready', 'now')"
        )
        conn.execute(
            "INSERT INTO episodes (episode_id, document_id, curriculum_id, "
            "payload, status, validation, created_at, updated_at) "
            "VALUES ('ep', 'd', NULL, ?, 'ready', NULL, 'now', 'now')",
            (_script().model_dump_json(),),
        )
    conn.close()


def _client(tmp_path):
    _seed(tmp_path)
    return TestClient(create_app(data_dir=tmp_path))


class StubProvider:
    def __init__(self, data=None, error=None, count: int = 10):
        self.data = data or {
            "answer": "Because reasons.",
            "cited_chunk_ids": ["c1"],
            "grounding_status": "supported",
            "learning_note": "reasons",
        }
        self.error = error
        self.count = count
        self.calls: list[dict] = []

    async def generate_text(self, **kw) -> GenerationResult:
        self.calls.append(kw)
        return GenerationResult(text="ok", usage={"prompt_tokens": 1, "total_tokens": 1})

    async def generate_structured(self, **kw) -> StructuredResult:
        self.calls.append(kw)
        if self.error:
            raise self.error
        return StructuredResult(
            data=self.data,
            usage={"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15},
        )

    async def count_input_tokens(self, **kw) -> int:
        return self.count


def _passages(*chunk_ids: str) -> list[SourcePassage]:
    return [
        SourcePassage(
            chunk_id=cid,
            text=f"passage {cid}",
            source=SourceRef(
                chunk_id=cid, document_id="d", page_start=1, page_end=1
            ),
        )
        for cid in chunk_ids
    ]


def _stub_retriever(passages):
    return lambda document_id, query, **kw: passages


def _interaction(request_id="q1") -> TutorInteraction:
    return TutorInteraction(
        interactionId="i1",
        kind="raise_hand",
        userMessage="why?",
        answer="because",
        createdAt="now",
        groundingStatus="supported",
        requestId=request_id,
    )


# --- controller transitions ---


def test_raise_hand_snapshots_position_once():
    session = new_session(_script()).model_copy(
        update={"sceneId": "s1", "dialogueIndex": 1}
    )
    raised = raise_hand(session)
    assert raised.mode == "question"
    assert raised.resumeSnapshot is not None
    assert (raised.resumeSnapshot.sceneId, raised.resumeSnapshot.dialogueIndex,
            raised.resumeSnapshot.mode) == ("s1", 1, "playing")
    assert raised.version == session.version + 1


@pytest.mark.parametrize("mode", ["question", "completed", "discussion", "error"])
def test_raise_hand_rejected_outside_playing_and_checkpoint(mode):
    session = new_session(_script()).model_copy(update={"mode": mode})
    with pytest.raises(InvalidSessionTransition):
        raise_hand(session)


def test_resume_restores_exact_position():
    episode = _script()
    session = raise_hand(
        new_session(episode).model_copy(update={"dialogueIndex": 1})
    )
    restored = resume(session, episode)
    assert (restored.sceneId, restored.dialogueIndex, restored.mode) == ("s1", 1, "playing")
    assert restored.resumeSnapshot is None


def test_resume_rejected_without_question_mode():
    with pytest.raises(InvalidSessionTransition):
        resume(new_session(_script()), _script())


def test_answer_rejected_in_question_mode():
    session = raise_hand(new_session(_script()))
    request = AnswerRequest(
        questionId="q1", optionId="a", request_id="r", expected_version=2
    )
    with pytest.raises(InvalidSessionTransition):
        answer(session, _script(), request)


# --- storage owner ---


def test_question_mode_survives_reload(tmp_path):
    _seed(tmp_path)
    session = create_session(tmp_path, "ep")
    apply_advance(tmp_path, session.sessionId, "a1", 1)
    raised = apply_raise_hand(tmp_path, session.sessionId, "h1", 2)
    assert raised.mode == "question"
    reloaded = get_session(tmp_path, session.sessionId)
    assert reloaded.mode == "question"
    assert reloaded.resumeSnapshot.dialogueIndex == 1
    assert reloaded.checkpoint is None


def test_nested_raise_hand_rejected(tmp_path):
    _seed(tmp_path)
    session = create_session(tmp_path, "ep")
    apply_raise_hand(tmp_path, session.sessionId, "h1", 1)
    with pytest.raises(InvalidSessionTransition):
        apply_raise_hand(tmp_path, session.sessionId, "h2", 2)
    assert get_session(tmp_path, session.sessionId).resumeSnapshot.dialogueIndex == 0
    # replay of the original request id still returns the interrupted session
    replayed = apply_raise_hand(tmp_path, session.sessionId, "h1", 1)
    assert replayed.mode == "question"


def test_checkpoint_progress_survives_question_round(tmp_path):
    _seed(tmp_path)
    session = create_session(tmp_path, "ep")
    apply_advance(tmp_path, session.sessionId, "a1", 1)
    apply_advance(tmp_path, session.sessionId, "a2", 2)
    answered = apply_answer(
        tmp_path, session.sessionId,
        AnswerRequest(questionId="q1", optionId="b", request_id="an1", expected_version=3),
    )
    assert answered.checkpoint.attemptsUsed == 1
    apply_raise_hand(tmp_path, session.sessionId, "h1", 4)
    restored = apply_resume(tmp_path, session.sessionId, "rs1", 5)
    assert (restored.mode, restored.sceneId) == ("checkpoint", "s2")
    assert restored.checkpoint.attemptsUsed == 1
    assert restored.checkpoint.feedback == "no"
    assert get_session(tmp_path, session.sessionId).checkpoint.attemptsUsed == 1


def test_prepare_and_commit_question(tmp_path):
    _seed(tmp_path)
    session = create_session(tmp_path, "ep")
    apply_raise_hand(tmp_path, session.sessionId, "h1", 1)
    request = QuestionRequest(question="why?", request_id="q1", expected_version=2)

    prepared, episode, recorded = prepare_question(tmp_path, session.sessionId, request)
    assert recorded is None and episode.episodeId == "ep"
    assert prepared.mode == "question"

    updated, interaction = commit_question(
        tmp_path, session.sessionId, request, _interaction("q1"), "asked why"
    )
    assert updated.version == 3
    assert updated.interactions[-1].requestId == "q1"
    assert updated.learningNotes == ["asked why"]
    assert interaction.answer == "because"

    # replay: recorded answer returned, no model call needed
    replayed_session, _, recorded = prepare_question(tmp_path, session.sessionId, request)
    assert recorded.interactionId == "i1"
    assert replayed_session.interactions[-1].answer == "because"


def test_prepare_question_rejects_outside_question_mode(tmp_path):
    _seed(tmp_path)
    session = create_session(tmp_path, "ep")
    request = QuestionRequest(question="why?", request_id="q1", expected_version=1)
    with pytest.raises(InvalidSessionTransition):
        prepare_question(tmp_path, session.sessionId, request)
    with pytest.raises(SessionConflict):
        prepare_question(
            tmp_path, session.sessionId,
            QuestionRequest(question="why?", request_id="q2", expected_version=9),
        )


def test_commit_question_rechecks_state_after_resume_race(tmp_path):
    _seed(tmp_path)
    session = create_session(tmp_path, "ep")
    apply_raise_hand(tmp_path, session.sessionId, "h1", 1)
    request = QuestionRequest(question="why?", request_id="q1", expected_version=2)
    prepare_question(tmp_path, session.sessionId, request)
    apply_resume(tmp_path, session.sessionId, "rs1", 2)
    # resume bumped the version — the commit-time re-check rejects the write
    with pytest.raises(SessionConflict):
        commit_question(tmp_path, session.sessionId, request, _interaction(), None)
    persisted = get_session(tmp_path, session.sessionId)
    assert persisted.mode == "playing"
    assert persisted.interactions == []


def test_request_id_kind_conflict_across_operations(tmp_path):
    _seed(tmp_path)
    session = create_session(tmp_path, "ep")
    apply_raise_hand(tmp_path, session.sessionId, "h1", 1)
    with pytest.raises(SessionConflict, match="another operation"):
        prepare_question(
            tmp_path, session.sessionId,
            QuestionRequest(question="why?", request_id="h1", expected_version=2),
        )
    request = QuestionRequest(question="why?", request_id="q1", expected_version=2)
    commit_question(tmp_path, session.sessionId, request, _interaction(), None)
    with pytest.raises(SessionConflict, match="another operation"):
        apply_advance(tmp_path, session.sessionId, "q1", 3)


# --- tutor service ---


@pytest.mark.anyio
async def test_answer_question_verifies_citations(tmp_path):
    init_db(tmp_path)
    settings = _settings()
    stub = StubProvider(data={
        "answer": "grounded",
        "cited_chunk_ids": ["c1", "hallucinated", "c1"],
        "grounding_status": "supported",
        "learning_note": "topic x",
    })
    provider = MeteredProvider(stub, settings, tmp_path)
    session = new_session(_script()).model_copy(update={"mode": "question"})

    result = await answer_question(
        provider=provider,
        session=session,
        episode=_script(),
        question="why?",
        request_id="q1",
        settings=settings,
        retriever=_stub_retriever(_passages("c1", "c2")),
    )
    assert [r.chunkId for r in result.interaction.sourceRefs] == ["c1"]
    assert result.interaction.groundingStatus == "supported"
    assert result.interaction.kind == "raise_hand"
    assert result.interaction.requestId == "q1"
    assert result.learning_note == "topic x"

    conn = sqlite3.connect(tmp_path / "app.db")
    row = conn.execute(
        "SELECT job_id, stage, total_tokens FROM token_usage"
    ).fetchone()
    conn.close()
    assert row == (f"session:{session.sessionId}", "tutor", 15)


@pytest.mark.anyio
async def test_answer_question_unsupported_when_retrieval_empty(tmp_path):
    init_db(tmp_path)
    settings = _settings()
    stub = StubProvider(data={
        "answer": "The PDF does not cover that.",
        "cited_chunk_ids": ["c9"],
        "grounding_status": "unsupported",
        "learning_note": "",
    })
    provider = MeteredProvider(stub, settings, tmp_path)
    session = new_session(_script())
    result = await answer_question(
        provider=provider,
        session=session,
        episode=_script(),
        question="unrelated?",
        request_id="q1",
        settings=settings,
        retriever=_stub_retriever([]),
    )
    assert result.interaction.sourceRefs == []
    assert result.interaction.groundingStatus == "unsupported"
    assert "unrelated?" in result.learning_note


# --- API routes ---


def _raise_hand(client, sid, version=1):
    return client.post(
        f"/api/sessions/{sid}/raise-hand",
        json={"request_id": "h1", "expected_version": version},
    )


def test_raise_hand_and_resume_round_trip(tmp_path):
    with _client(tmp_path) as client:
        created = client.post("/api/episodes/ep/sessions").json()
        sid = created["sessionId"]
        client.post(
            f"/api/sessions/{sid}/advance",
            json={"request_id": "a1", "expected_version": 1},
        )

        raised = _raise_hand(client, sid, version=2)
        assert raised.status_code == 200
        body = raised.json()
        assert body["mode"] == "question"
        assert body["resumeSnapshot"] == {
            "sceneId": "s1", "dialogueIndex": 1, "mode": "playing"
        }

        # reload keeps question mode + snapshot
        assert client.get(f"/api/sessions/{sid}").json()["mode"] == "question"

        nested = client.post(
            f"/api/sessions/{sid}/raise-hand",
            json={"request_id": "h2", "expected_version": 3},
        )
        assert nested.status_code == 409
        assert nested.json()["error"]["code"] == "INVALID_SESSION_TRANSITION"

        for path in ("advance", "answers"):
            blocked = client.post(
                f"/api/sessions/{sid}/{path}",
                json={
                    "request_id": f"x-{path}",
                    "expected_version": 3,
                    **({"questionId": "q1", "optionId": "a"} if path == "answers" else {}),
                },
            )
            assert blocked.status_code == 409, path
            assert blocked.json()["error"]["code"] == "INVALID_SESSION_TRANSITION"

        resumed = client.post(
            f"/api/sessions/{sid}/resume",
            json={"request_id": "r1", "expected_version": 3},
        )
        assert resumed.status_code == 200
        body = resumed.json()
        assert (body["mode"], body["sceneId"], body["dialogueIndex"]) == ("playing", "s1", 1)
        assert body["resumeSnapshot"] is None

        # replay of the resume request returns current state
        replay = client.post(
            f"/api/sessions/{sid}/resume",
            json={"request_id": "r1", "expected_version": 3},
        )
        assert replay.status_code == 200
        assert replay.json()["version"] == 4


def test_question_endpoint_answers_and_replays(tmp_path):
    with _client(tmp_path) as client:
        stub = StubProvider()
        client.app.state.tutor_provider = MeteredProvider(
            stub, _settings(), tmp_path
        )
        client.app.state.retriever = _stub_retriever(_passages("c1"))

        sid = client.post("/api/episodes/ep/sessions").json()["sessionId"]
        _raise_hand(client, sid)

        asked = client.post(
            f"/api/sessions/{sid}/questions",
            json={"question": "why?", "request_id": "q1", "expected_version": 2},
        )
        assert asked.status_code == 200
        body = asked.json()
        assert body["interaction"]["answer"] == "Because reasons."
        assert body["interaction"]["groundingStatus"] == "supported"
        assert body["interaction"]["sourceRefs"][0]["chunkId"] == "c1"
        assert body["session"]["interactions"][-1]["userMessage"] == "why?"
        assert body["session"]["learningNotes"] == ["reasons"]
        assert len(stub.calls) == 1

        replayed = client.post(
            f"/api/sessions/{sid}/questions",
            json={"question": "why?", "request_id": "q1", "expected_version": 2},
        )
        assert replayed.status_code == 200
        assert replayed.json()["interaction"]["answer"] == "Because reasons."
        assert len(stub.calls) == 1  # replay skips the model

        # answer survives reload
        restored = client.get(f"/api/sessions/{sid}").json()
        assert restored["interactions"][-1]["groundingStatus"] == "supported"


def test_question_provider_failure_preserves_state_and_retries(tmp_path):
    with _client(tmp_path) as client:
        stub = StubProvider(
            error=ModelProviderError("HTTP_500", "upstream", retryable=True)
        )
        client.app.state.tutor_provider = MeteredProvider(
            stub, _settings(), tmp_path
        )
        client.app.state.retriever = _stub_retriever(_passages("c1"))

        sid = client.post("/api/episodes/ep/sessions").json()["sessionId"]
        _raise_hand(client, sid)

        failed = client.post(
            f"/api/sessions/{sid}/questions",
            json={"question": "why?", "request_id": "q1", "expected_version": 2},
        )
        assert failed.status_code == 503
        assert failed.json()["error"]["retryable"] is True
        persisted = client.get(f"/api/sessions/{sid}").json()
        assert persisted["mode"] == "question"
        assert persisted["interactions"] == []

        # same request id retries cleanly — no tombstone was written
        stub.error = None
        retried = client.post(
            f"/api/sessions/{sid}/questions",
            json={"question": "why?", "request_id": "q1", "expected_version": 2},
        )
        assert retried.status_code == 200
        assert retried.json()["interaction"]["answer"] == "Because reasons."


def test_question_budget_exceeded_returns_503(tmp_path):
    with _client(tmp_path) as client:
        client.app.state.tutor_provider = MeteredProvider(
            StubProvider(), _settings(token_stage_budgets={"tutor": 1}), tmp_path
        )
        client.app.state.retriever = _stub_retriever(_passages("c1"))
        sid = client.post("/api/episodes/ep/sessions").json()["sessionId"]
        _raise_hand(client, sid)
        refused = client.post(
            f"/api/sessions/{sid}/questions",
            json={"question": "why?", "request_id": "q1", "expected_version": 2},
        )
        assert refused.status_code == 503
        assert refused.json()["error"]["code"] == "TOKEN_BUDGET_EXCEEDED"
        assert client.get(f"/api/sessions/{sid}").json()["interactions"] == []


def test_question_request_validation(tmp_path):
    with _client(tmp_path) as client:
        sid = client.post("/api/episodes/ep/sessions").json()["sessionId"]

        # while playing the endpoint refuses before validation concerns
        out_of_mode = client.post(
            f"/api/sessions/{sid}/questions",
            json={"question": "why?", "request_id": "q1", "expected_version": 1},
        )
        assert out_of_mode.status_code == 409

        _raise_hand(client, sid)
        for bad in ("", "   ", "x" * 501):
            response = client.post(
                f"/api/sessions/{sid}/questions",
                json={"question": bad, "request_id": f"v{len(bad)}", "expected_version": 2},
            )
            assert response.status_code == 422, bad[:10]
