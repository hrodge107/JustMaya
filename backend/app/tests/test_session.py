"""B02 learner session state machine — contract, transitions, persistence,
endpoints, and the learner-safe episode projection.

The episode payload fixture is a minimal valid EpisodeScript: s1 dialogue
(2 lines) -> s2 checkpoint -> s3 ending. Storage tests seed the episodes row
directly; API tests go through TestClient.
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
from app.models.session import SESSION_MODES, SESSION_STATUSES
from app.services.session_controller import (
    InvalidSessionTransition,
    advance,
    new_session,
)
from app.storage.database import init_db
from app.storage.sessions import (
    EpisodeNotReady,
    SessionConflict,
    apply_advance,
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
                kind="ending",
                dialogue=[
                    DialogueLine(lineId="l3", speaker="mascot", text="done", emotion="happy"),
                ],
            ),
        ],
        status=status,
    )


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


def _client(tmp_path, status="ready"):
    _seed(tmp_path, status)
    return TestClient(create_app(data_dir=tmp_path))


# --- schema + contract (tasks 1.1, 1.2) ---


def test_session_tables_carry_declared_vocabulary(tmp_path):
    init_db(tmp_path)
    conn = sqlite3.connect(tmp_path / "app.db")
    sql = conn.execute(
        "SELECT sql FROM sqlite_master WHERE name = 'learner_sessions'"
    ).fetchone()[0]
    requests = conn.execute(
        "SELECT sql FROM sqlite_master WHERE name = 'session_requests'"
    ).fetchone()[0]
    conn.close()
    for mode in SESSION_MODES:
        assert f"'{mode}'" in sql
    for status in SESSION_STATUSES:
        assert f"'{status}'" in sql
    assert "PRIMARY KEY (session_id, request_id)" in requests


def test_session_model_serializes_spec_field_names():
    session = new_session(_script())
    keys = set(session.model_dump())
    assert {
        "sessionId",
        "episodeId",
        "mode",
        "sceneId",
        "dialogueIndex",
        "resumeSnapshot",
        "quizAttempts",
        "interactions",
        "learningNotes",
        "version",
        "status",
        "updatedAt",
    } == keys


# --- controller transitions (task 2.1) ---


def test_new_session_starts_at_episode_start():
    session = new_session(_script())
    assert session.sceneId == "s1"
    assert session.dialogueIndex == 0
    assert session.mode == "playing"
    assert session.status == "active"
    assert session.version == 1
    assert session.resumeSnapshot is None
    assert session.quizAttempts == session.interactions == session.learningNotes == []


def test_advance_increments_line_within_scene():
    session = advance(new_session(_script()), _script())
    assert session.sceneId == "s1"
    assert session.dialogueIndex == 1
    assert session.mode == "playing"
    assert session.version == 2


def test_advance_scene_boundary_enters_checkpoint_mode():
    session = advance(advance(new_session(_script()), _script()), _script())
    assert session.sceneId == "s2"
    assert session.dialogueIndex == 0
    assert session.mode == "checkpoint"


def test_advance_last_line_of_ending_completes_session():
    session = new_session(_script()).model_copy(update={"sceneId": "s3"})
    done = advance(session, _script())
    assert done.mode == "completed"
    assert done.status == "completed"


@pytest.mark.parametrize(
    "mode", ["checkpoint", "question", "completed", "discussion", "error"]
)
def test_advance_rejected_outside_playing(mode):
    session = new_session(_script()).model_copy(update={"mode": mode})
    with pytest.raises(InvalidSessionTransition):
        advance(session, _script())


def test_unanswered_checkpoint_cannot_be_skipped():
    session = advance(advance(new_session(_script()), _script()), _script())
    with pytest.raises(InvalidSessionTransition):
        advance(session, _script())
    assert session.sceneId == "s2"
    assert session.mode == "checkpoint"


# --- storage owner (task 2.2) ---


def test_create_session_persists_initial_state(tmp_path):
    _seed(tmp_path)
    session = create_session(tmp_path, "ep")
    stored = get_session(tmp_path, session.sessionId)
    assert stored == session
    conn = sqlite3.connect(tmp_path / "app.db")
    row = conn.execute(
        "SELECT episode_id, mode, status, version FROM learner_sessions "
        "WHERE session_id = ?",
        (session.sessionId,),
    ).fetchone()
    conn.close()
    assert row == ("ep", "playing", "active", 1)


def test_create_session_rejects_draft_and_unknown(tmp_path):
    _seed(tmp_path, status="draft")
    with pytest.raises(EpisodeNotReady):
        create_session(tmp_path, "ep")
    with pytest.raises(LookupError):
        create_session(tmp_path, "nope")


def test_get_session_unknown_raises(tmp_path):
    init_db(tmp_path)
    with pytest.raises(LookupError):
        get_session(tmp_path, "nope")


def test_apply_advance_commits_transition(tmp_path):
    _seed(tmp_path)
    session = create_session(tmp_path, "ep")
    updated = apply_advance(tmp_path, session.sessionId, "r1", 1)
    assert updated.dialogueIndex == 1
    assert updated.version == 2
    assert get_session(tmp_path, session.sessionId).dialogueIndex == 1


def test_apply_advance_duplicate_request_id_is_noop(tmp_path):
    _seed(tmp_path)
    session = create_session(tmp_path, "ep")
    apply_advance(tmp_path, session.sessionId, "r1", 1)
    # replay carries the ORIGINAL (now stale) version — dedup wins over conflict
    replayed = apply_advance(tmp_path, session.sessionId, "r1", 1)
    assert replayed.version == 2
    assert replayed.dialogueIndex == 1


def test_apply_advance_stale_version_conflict(tmp_path):
    _seed(tmp_path)
    session = create_session(tmp_path, "ep")
    with pytest.raises(SessionConflict):
        apply_advance(tmp_path, session.sessionId, "r1", 5)
    assert get_session(tmp_path, session.sessionId).version == 1


def test_apply_advance_rejects_checkpoint_and_leaves_state(tmp_path):
    _seed(tmp_path)
    session = create_session(tmp_path, "ep")
    apply_advance(tmp_path, session.sessionId, "r1", 1)
    at_gate = apply_advance(tmp_path, session.sessionId, "r2", 2)
    assert at_gate.mode == "checkpoint"
    with pytest.raises(InvalidSessionTransition):
        apply_advance(tmp_path, session.sessionId, "r3", 3)
    assert get_session(tmp_path, session.sessionId).version == 3


# --- API + learner projection (task 3) ---


def test_session_endpoints_happy_path(tmp_path):
    with _client(tmp_path) as client:
        created = client.post("/api/episodes/ep/sessions").json()
        assert created["sceneId"] == "s1"
        assert created["mode"] == "playing"
        assert created["status"] == "active"
        assert created["version"] == 1
        sid = created["sessionId"]

        restored = client.get(f"/api/sessions/{sid}").json()
        assert restored == created

        step = client.post(
            f"/api/sessions/{sid}/advance",
            json={"request_id": "r1", "expected_version": 1},
        ).json()
        assert step["dialogueIndex"] == step["version"] - 1 == 1

        gate = client.post(
            f"/api/sessions/{sid}/advance",
            json={"request_id": "r2", "expected_version": 2},
        ).json()
        assert (gate["sceneId"], gate["mode"], gate["dialogueIndex"]) == ("s2", "checkpoint", 0)

        blocked = client.post(
            f"/api/sessions/{sid}/advance",
            json={"request_id": "r3", "expected_version": 3},
        )
        assert blocked.status_code == 409
        assert blocked.json()["error"]["code"] == "INVALID_SESSION_TRANSITION"

        replay = client.post(
            f"/api/sessions/{sid}/advance",
            json={"request_id": "r1", "expected_version": 1},
        )
        assert replay.status_code == 200
        assert replay.json()["version"] == 3

        stale = client.post(
            f"/api/sessions/{sid}/advance",
            json={"request_id": "r4", "expected_version": 1},
        )
        assert stale.status_code == 409
        assert stale.json()["error"]["code"] == "SESSION_CONFLICT"


def test_session_endpoints_error_paths(tmp_path):
    with _client(tmp_path) as client:
        missing = client.post("/api/episodes/nope/sessions")
        assert missing.status_code == 404
        assert missing.json()["error"]["code"] == "NOT_FOUND"
        assert client.get("/api/sessions/nope").status_code == 404
        advance = client.post(
            "/api/sessions/nope/advance",
            json={"request_id": "r", "expected_version": 1},
        )
        assert advance.status_code == 404


def test_session_create_rejects_draft_episode(tmp_path):
    init_db(tmp_path)
    conn = sqlite3.connect(tmp_path / "app.db")
    with conn:
        conn.execute(
            "INSERT INTO documents (document_id, filename, status, created_at) "
            "VALUES ('d', 'a.pdf', 'processing', 'now')"
        )
        conn.execute(
            "INSERT INTO episodes (episode_id, document_id, curriculum_id, "
            "payload, status, validation, created_at, updated_at) "
            "VALUES ('ep', 'd', NULL, ?, 'draft', NULL, 'now', 'now')",
            (_script("draft").model_dump_json(),),
        )
    conn.close()
    with TestClient(create_app(data_dir=tmp_path)) as client:
        response = client.post("/api/episodes/ep/sessions")
        assert response.status_code == 409
        assert response.json()["error"]["code"] == "EPISODE_NOT_READY"


def test_episode_get_strips_grading_fields_inspection_keeps_them(tmp_path):
    with _client(tmp_path) as client:
        episode = client.get("/api/episodes/ep").json()
        assert episode["title"] == "T"
        assert episode["status"] == "ready"
        question = episode["scenes"][1]["question"]
        assert question["prompt"] == "P?"
        assert {o["optionId"] for o in question["options"]} == {"a", "b"}
        for field in (
            "correctOptionId",
            "correctExplanation",
            "incorrectExplanation",
            "feedback",
        ):
            assert field not in question

        inspection = client.get("/api/documents/d/inspection/episode").json()
        assert inspection["scenes"][1]["question"]["correctOptionId"] == "a"
