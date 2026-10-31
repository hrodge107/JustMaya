"""Backlog rewind transition: controller gates, positional truncation,
storage dedup/conflict handling, append anchoring, and the HTTP route.

Fixture: s1 dialogue (2 lines) -> s2 checkpoint -> s3 dialogue (1 line)
-> s4 ending (1 line).
"""

import sqlite3

import pytest
from fastapi.testclient import TestClient

from app.main import create_app
from app.models.episode import (
    AnswerOption,
    DialogueLine,
    EpisodeScene,
    EpisodeScript,
    RecallQuestion,
)
from app.models.session import (
    AnswerRequest,
    LearnerSession,
    Position,
    QuestionRequest,
    QuizAttempt,
    RewindRequest,
    TutorInteraction,
)
from app.services.session_controller import (
    InvalidSessionTransition,
    advance,
    answer,
    new_session,
    raise_hand,
    rewind,
)
from app.storage.database import init_db
from app.storage.sessions import (
    SessionConflict,
    apply_advance,
    apply_answer,
    apply_raise_hand,
    apply_rewind,
    commit_question,
    create_session,
    get_session,
)


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
                kind="dialogue",
                dialogue=[
                    DialogueLine(lineId="l3", speaker="mascot", text="three", emotion="happy"),
                ],
                nextSceneId="s4",
            ),
            EpisodeScene(
                sceneId="s4",
                kind="ending",
                dialogue=[
                    DialogueLine(lineId="l4", speaker="mascot", text="done", emotion="happy"),
                ],
            ),
        ],
        status=status,
    )


def _interaction(position: Position | None, created="t") -> TutorInteraction:
    return TutorInteraction(
        interactionId="i1",
        kind="raise_hand",
        userMessage="q?",
        answer="a!",
        createdAt=created,
        position=position,
    )


def _req(scene, index, request_id="w1", version=1) -> RewindRequest:
    return RewindRequest(
        request_id=request_id,
        expected_version=version,
        scene_id=scene,
        dialogue_index=index,
    )


def _at_s3() -> LearnerSession:
    """Session at s3/0 with a completed checkpoint behind it."""
    script = _script()
    session = advance(advance(new_session(script), script), script)
    session = answer(
        session, script, AnswerRequest(questionId="q1", optionId="a",
                                       request_id="a1", expected_version=3)
    )
    return advance(session, script)


def _seed(tmp_path, status="ready"):
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
            "VALUES ('ep', 'd', NULL, ?, ?, NULL, 'now', 'now')",
            (_script(status).model_dump_json(), status),
        )
    conn.close()


def _client(tmp_path):
    _seed(tmp_path)
    return TestClient(create_app(data_dir=tmp_path))


# --- controller ---


def test_rewind_to_earlier_line_restores_position():
    session = _at_s3()
    back = rewind(session, _script(), _req("s1", 0))
    assert (back.sceneId, back.dialogueIndex, back.mode) == ("s1", 0, "playing")
    assert back.version == session.version + 1


def test_rewind_drops_attempts_and_interactions_at_or_after_target():
    session = _at_s3().model_copy(update={
        "interactions": [
            _interaction(Position(sceneId="s1", dialogueIndex=0, mode="playing")),
            _interaction(Position(sceneId="s3", dialogueIndex=0, mode="playing"),
                         created="t2"),
        ],
    })
    back = rewind(session, _script(), _req("s1", 1))
    # s2 checkpoint attempt is after the target; s3 interaction is after;
    # the s1/0 interaction survives.
    assert back.quizAttempts == []
    assert [i.createdAt for i in back.interactions] == ["t"]


def test_rewind_to_checkpoint_reopens_it_unanswered():
    session = _at_s3()
    assert session.quizAttempts  # answered behind us
    back = rewind(session, _script(), _req("s2", 0))
    assert back.mode == "checkpoint"
    assert back.checkpoint is not None
    assert back.checkpoint.checkpointCompleted is False
    assert back.checkpoint.attemptsUsed == 0
    assert back.checkpoint.correctOptionId is None


def test_rewind_to_ending_scene_enters_playing_mode():
    session = advance(_at_s3(), _script())  # s4/0 playing
    back = rewind(session, _script(), _req("s3", 0))
    assert (back.sceneId, back.mode) == ("s3", "playing")


def test_rewind_to_current_position_is_noop():
    session = _at_s3()
    assert rewind(session, _script(), _req("s3", 0)) == session


def test_rewind_forward_or_equal_later_index_rejected():
    session = _at_s3()
    with pytest.raises(InvalidSessionTransition, match="ahead"):
        rewind(session, _script(), _req("s4", 0))
    earlier = new_session(_script())
    with pytest.raises(InvalidSessionTransition, match="ahead"):
        rewind(earlier, _script(), _req("s1", 1))


def test_rewind_unknown_scene_or_bad_index_rejected():
    session = _at_s3()
    with pytest.raises(InvalidSessionTransition, match="not part"):
        rewind(session, _script(), _req("nope", 0))
    with pytest.raises(InvalidSessionTransition, match="not a valid line"):
        rewind(session, _script(), _req("s1", 5))
    with pytest.raises(InvalidSessionTransition, match="not a valid line"):
        rewind(session, _script(), _req("s2", 1))


@pytest.mark.parametrize("mode", ["question", "completed", "discussion", "error"])
def test_rewind_rejected_in_locked_modes(mode):
    session = _at_s3().model_copy(update={"mode": mode})
    with pytest.raises(InvalidSessionTransition):
        rewind(session, _script(), _req("s1", 0))


def test_rewind_from_checkpoint_mode_allowed():
    script = _script()
    session = advance(advance(new_session(script), script), script)
    assert session.mode == "checkpoint"
    back = rewind(session, script, _req("s1", 1))
    assert (back.sceneId, back.dialogueIndex, back.mode) == ("s1", 1, "playing")


def test_rewind_clears_snapshot_and_thread_and_keeps_unanchored():
    legacy = _interaction(None)
    session = _at_s3().model_copy(update={
        "resumeSnapshot": Position(sceneId="s2", dialogueIndex=0, mode="checkpoint"),
        "tutorThreadId": "t:1",
        "interactions": [legacy],
    })
    back = rewind(session, _script(), _req("s1", 0))
    assert back.resumeSnapshot is None
    assert back.tutorThreadId is None
    assert back.interactions == [legacy]


def test_answer_records_served_feedback_on_attempt():
    script = _script()
    session = advance(advance(new_session(script), script), script)
    wrong = answer(
        session, script, AnswerRequest(questionId="q1", optionId="b",
                                       request_id="a1", expected_version=3)
    )
    assert wrong.quizAttempts[-1].feedback == "no"
    right = answer(
        wrong, script, AnswerRequest(questionId="q1", optionId="a",
                                     request_id="a2", expected_version=4)
    )
    assert right.quizAttempts[-1].feedback == "yes"


# --- storage ---


def _to_s3(tmp_path):
    session = create_session(tmp_path, "ep")
    apply_advance(tmp_path, session.sessionId, "r1", 1)
    apply_advance(tmp_path, session.sessionId, "r2", 2)
    apply_answer(tmp_path, session.sessionId,
                 AnswerRequest(questionId="q1", optionId="a",
                               request_id="r3", expected_version=3))
    return session


def test_apply_rewind_commits(tmp_path):
    _seed(tmp_path)
    session = _to_s3(tmp_path)
    apply_advance(tmp_path, session.sessionId, "r4", 4)
    back = apply_rewind(tmp_path, session.sessionId, _req("s1", 1, "w1", 5))
    assert (back.sceneId, back.dialogueIndex, back.version) == ("s1", 1, 6)
    stored = get_session(tmp_path, session.sessionId)
    assert stored.quizAttempts == []
    assert stored.sceneId == "s1"


def test_apply_rewind_replay_returns_current_state(tmp_path):
    _seed(tmp_path)
    session = _to_s3(tmp_path)
    apply_advance(tmp_path, session.sessionId, "r4", 4)
    apply_rewind(tmp_path, session.sessionId, _req("s1", 0, "w1", 5))
    apply_advance(tmp_path, session.sessionId, "r5", 6)
    replayed = apply_rewind(tmp_path, session.sessionId, _req("s1", 0, "w1", 5))
    # Dedup wins over the stale version and does NOT rewind a second time.
    assert (replayed.sceneId, replayed.dialogueIndex) == ("s1", 1)
    assert replayed.version == 7


def test_apply_rewind_stale_version_leaves_state(tmp_path):
    _seed(tmp_path)
    session = _to_s3(tmp_path)
    apply_advance(tmp_path, session.sessionId, "r4", 4)
    with pytest.raises(SessionConflict):
        apply_rewind(tmp_path, session.sessionId, _req("s1", 0, "w1", 3))
    assert get_session(tmp_path, session.sessionId).version == 5


def test_apply_rewind_cross_kind_request_id_conflicts(tmp_path):
    _seed(tmp_path)
    session = _to_s3(tmp_path)
    apply_advance(tmp_path, session.sessionId, "r4", 4)
    with pytest.raises(SessionConflict, match="another operation"):
        apply_rewind(tmp_path, session.sessionId, _req("s1", 0, "r4", 5))


def test_commit_question_stamps_position_from_snapshot(tmp_path):
    _seed(tmp_path)
    session = create_session(tmp_path, "ep")
    apply_advance(tmp_path, session.sessionId, "r1", 1)
    apply_raise_hand(tmp_path, session.sessionId, "rh1", 2)
    question = QuestionRequest(question="why?", request_id="q1",
                               expected_version=3)
    _, stored = commit_question(
        tmp_path, session.sessionId, question, _interaction(None), "note"
    )
    assert stored.position == Position(
        sceneId="s1", dialogueIndex=1, mode="playing")


# --- model compatibility ---


def test_legacy_payloads_without_anchor_fields_deserialize():
    attempt = QuizAttempt.model_validate({
        "questionId": "q1", "selectedOptionId": "a", "correct": True,
        "attemptNumber": 1, "timestamp": "t",
    })
    assert attempt.feedback is None
    interaction = TutorInteraction.model_validate({
        "interactionId": "i1", "kind": "raise_hand", "userMessage": "q",
        "answer": "a", "createdAt": "t",
    })
    assert interaction.position is None


# --- route ---


def test_rewind_endpoint_happy_and_error_paths(tmp_path):
    with _client(tmp_path) as client:
        created = client.post("/api/episodes/ep/sessions").json()
        sid = created["sessionId"]
        # r1 -> s1/1, r2 -> s2/0 checkpoint (version 3, rewind-eligible).
        for i, rid in enumerate(("r1", "r2"), start=1):
            step = client.post(
                f"/api/sessions/{sid}/advance",
                json={"request_id": rid, "expected_version": i},
            )
            assert step.status_code == 200

        missing = client.post(
            "/api/sessions/nope/rewind",
            json={"request_id": "w", "expected_version": 3,
                  "scene_id": "s1", "dialogue_index": 0},
        )
        assert missing.status_code == 404

        stale = client.post(
            f"/api/sessions/{sid}/rewind",
            json={"request_id": "w1", "expected_version": 1,
                  "scene_id": "s1", "dialogue_index": 0},
        )
        assert stale.status_code == 409
        assert stale.json()["error"]["code"] == "SESSION_CONFLICT"

        forward = client.post(
            f"/api/sessions/{sid}/rewind",
            json={"request_id": "w2", "expected_version": 3,
                  "scene_id": "s4", "dialogue_index": 0},
        )
        assert forward.status_code == 409
        assert forward.json()["error"]["code"] == "INVALID_SESSION_TRANSITION"

        malformed = client.post(
            f"/api/sessions/{sid}/rewind",
            json={"request_id": "w3", "expected_version": 3},
        )
        assert malformed.status_code == 422

        ok = client.post(
            f"/api/sessions/{sid}/rewind",
            json={"request_id": "w4", "expected_version": 3,
                  "scene_id": "s1", "dialogue_index": 1},
        )
        assert ok.status_code == 200
        body = ok.json()
        assert (body["sceneId"], body["dialogueIndex"]) == ("s1", 1)
        assert body["version"] == 4
