"""B04 contract checks at the HTTP and atomic storage boundaries.

Elimination semantics: every wrong pick is recorded permanently, its
dedicated response is released, and the checkpoint only completes on the
correct pick. Legacy episodes fall back through the structured-trio then
legacy-explanation chain; legacy sessions restore under the same rules.
"""
import json
import sqlite3
from concurrent.futures import ThreadPoolExecutor

import pytest
from pydantic import ValidationError

from app.models.episode import (
    AnswerOption,
    CheckpointFeedback,
    GeneratedEpisode,
    learner_view,
)
from app.models.session import AnswerRequest
from app.services.session_controller import InvalidSessionTransition
from app.services.episode_validator import _learner_texts, _script_view
from app.storage.sessions import apply_advance, apply_answer, create_session, get_session, SessionConflict
from app.tests.test_session import _client, _seed, _script
from app.tests.test_episode_generator import _script_payload
from app.services.episode_validator import deterministic_check
from app.config import Settings


def at_checkpoint(data_dir):
    session = create_session(data_dir, "ep")
    session = apply_advance(data_dir, session.sessionId, "step1", session.version)
    return apply_advance(data_dir, session.sessionId, "step2", session.version)


def parked(data_dir, structured=True, mistake=False, third=False):
    if not (data_dir / "app.db").exists():
        _seed(data_dir)
    script = _script()
    question = script.scenes[1].question
    if third:
        question.options.append(AnswerOption(optionId="c", label="C"))
    if mistake:
        for option in question.options:
            option.mistakeResponse = f"why-{option.optionId}-is-wrong"
    if structured:
        question.feedback = CheckpointFeedback(
            firstIncorrect="Think about what you learned.", correct="A is right because...",
            finalIncorrect="The correct option is A because...",
        )
    with sqlite3.connect(data_dir / "app.db") as conn:
        conn.execute("UPDATE episodes SET payload=?", (script.model_dump_json(),))
    return at_checkpoint(data_dir)


def submit(data_dir, session, option="b", rid="a1"):
    return apply_answer(data_dir, session.sessionId, AnswerRequest(
        questionId="q1", optionId=option, request_id=rid, expected_version=session.version))


@pytest.mark.parametrize("options", [("a",), ("b", "a"), ("b", "c", "a")])
def test_wrong_picks_eliminate_until_correct(tmp_path, options):
    session = parked(tmp_path, mistake=True, third="c" in options)
    assert session.checkpoint.attemptsUsed == 0
    assert session.checkpoint.feedback is None
    for i, option in enumerate(options, 1):
        before = session
        session = submit(tmp_path, session, option, f"a{i}")
        assert session.version == before.version + 1
        assert session.sceneId == "s2" and session.mode == "checkpoint"
        assert len(session.quizAttempts) == i
        assert session.checkpoint.attemptsUsed == i
        assert get_session(tmp_path, session.sessionId) == session
        if option != "a":
            assert session.checkpoint.feedback == f"why-{option}-is-wrong"
            assert session.checkpoint.correctOptionId is None
            assert not session.checkpoint.checkpointCompleted
            assert len(session.learningNotes) == 1
            with pytest.raises(InvalidSessionTransition):
                apply_advance(tmp_path, session.sessionId, f"skip{i}", session.version)
    assert session.checkpoint.checkpointCompleted
    assert session.checkpoint.isCorrect is True
    assert session.checkpoint.correctOptionId == "a"
    assert len(session.learningNotes) == (1 if len(options) > 1 else 0)
    with pytest.raises(InvalidSessionTransition):
        submit(tmp_path, session, "b", "extra")
    replay = submit(tmp_path, before, options[-1], f"a{len(options)}")
    assert replay == session
    next_session = apply_advance(tmp_path, session.sessionId, "continue", session.version)
    assert next_session.sceneId == "s3" and next_session.dialogueIndex == 0
    assert next_session.mode == "playing" and next_session.checkpoint is None
    assert submit(tmp_path, before, options[-1], f"a{len(options)}") == next_session


def test_eliminated_option_repick_rejected_and_rollback(tmp_path):
    session = parked(tmp_path, mistake=True, third=True)
    first = submit(tmp_path, session, "b", "a1")
    assert first.checkpoint.feedback == "why-b-is-wrong"
    with pytest.raises(ValueError, match="already attempted"):
        submit(tmp_path, first, "b", "again")
    assert get_session(tmp_path, session.sessionId) == first
    # the rejected request's tombstone rolled back: the same id retries validly
    second = submit(tmp_path, first, "c", "again")
    assert second.checkpoint.feedback == "why-c-is-wrong"
    assert len(second.learningNotes) == 1  # only the first miss notes
    third = submit(tmp_path, second, "a", "finish")
    assert third.checkpoint.checkpointCompleted and third.checkpoint.isCorrect


def test_feedback_fallback_chain(tmp_path):
    # per-option response beats the structured trio; the trio beats legacy text
    session = parked(tmp_path, mistake=True, structured=True)
    miss = submit(tmp_path, session, "b", "m1")
    assert miss.checkpoint.feedback == "why-b-is-wrong"
    hit = submit(tmp_path, miss, "a", "m2")
    assert hit.checkpoint.feedback == "A is right because..."

    parked(tmp_path, mistake=False, structured=True)
    session = at_checkpoint(tmp_path)
    assert submit(tmp_path, session, "b", "m1").checkpoint.feedback == "Think about what you learned."

    parked(tmp_path, mistake=False, structured=False)
    session = at_checkpoint(tmp_path)
    miss = submit(tmp_path, session, "b", "m1")
    assert miss.checkpoint.feedback == "no"
    assert submit(tmp_path, miss, "a", "m2").checkpoint.feedback == "yes"


def test_legacy_feedback_and_history_without_checkpoint_field(tmp_path):
    session = parked(tmp_path, structured=False)
    first = submit(tmp_path, session)
    assert first.checkpoint.feedback == "no"
    payload = first.model_dump()
    payload.pop("checkpoint")
    with sqlite3.connect(tmp_path / "app.db") as conn:
        conn.execute("UPDATE learner_sessions SET payload=?", (json.dumps(payload),))
    restored = get_session(tmp_path, session.sessionId)
    assert restored.checkpoint.attemptsUsed == 1
    second = submit(tmp_path, restored, "a", "second")
    assert second.checkpoint.checkpointCompleted
    assert len(second.learningNotes) == 1


def test_old_double_miss_session_restores_in_progress(tmp_path):
    session = parked(tmp_path, mistake=True)
    first = submit(tmp_path, session, "b", "a1")
    payload = first.model_dump()
    payload["quizAttempts"].append({
        "questionId": "q1", "selectedOptionId": "b", "correct": False,
        "attemptNumber": 2, "timestamp": first.updatedAt,
    })
    payload.pop("checkpoint")
    with sqlite3.connect(tmp_path / "app.db") as conn:
        conn.execute("UPDATE learner_sessions SET payload=?", (json.dumps(payload),))
    restored = get_session(tmp_path, session.sessionId)
    assert restored.checkpoint.attemptsUsed == 2
    assert not restored.checkpoint.checkpointCompleted
    assert restored.checkpoint.feedback == "why-b-is-wrong"
    with pytest.raises(ValueError, match="already attempted"):
        submit(tmp_path, restored, "b", "repick")
    done = submit(tmp_path, restored, "a", "finish")
    assert done.checkpoint.checkpointCompleted and done.checkpoint.correctOptionId == "a"


def test_rejections_rollback_and_cross_kind_ids(tmp_path):
    session = parked(tmp_path)
    for fields, error in [({"optionId": "outside"}, ValueError),
                          ({"questionId": "other"}, ValueError),
                          ({"expected_version": 1}, SessionConflict),
                          ({"request_id": "step1"}, SessionConflict)]:
        request = {"questionId": "q1", "optionId": "b", "request_id": "retryable", "expected_version": session.version, **fields}
        with pytest.raises(error):
            apply_answer(tmp_path, session.sessionId, AnswerRequest(**request))
        assert get_session(tmp_path, session.sessionId) == session
    accepted = submit(tmp_path, session, rid="retryable")
    with pytest.raises(SessionConflict):
        apply_advance(tmp_path, session.sessionId, "retryable", accepted.version)
    with sqlite3.connect(tmp_path / "app.db") as conn:
        assert conn.execute("SELECT count(*) FROM session_requests").fetchone()[0] == 3


def test_concurrent_answers_and_advance_do_not_burn_attempts(tmp_path):
    session = parked(tmp_path)
    def answer(rid):
        try:
            return submit(tmp_path, session, rid=rid)
        except SessionConflict:
            return None
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(answer, ["race1", "race2"]))
    assert sum(r is not None for r in results) == 1
    first = get_session(tmp_path, session.sessionId)
    assert len(first.quizAttempts) == 1
    def mutation(kind):
        try:
            return (submit(tmp_path, first, "a", "race3") if kind == "answer" else
                    apply_advance(tmp_path, first.sessionId, "race4", first.version))
        except (SessionConflict, InvalidSessionTransition):
            return None
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(mutation, ["answer", "advance"]))
    assert sum(r is not None for r in results) == 1
    final = get_session(tmp_path, session.sessionId)
    assert final.version == first.version+1 and len(final.quizAttempts) == 2


def test_api_privacy_validation_and_replay(tmp_path):
    with _client(tmp_path) as client:
        session = client.post("/api/episodes/ep/sessions").json()
        sid = session['sessionId']
        for i in range(2):
            session = client.post(f"/api/sessions/{sid}/advance", json={"request_id": f"s{i}", "expected_version": session['version']}).json()
        assert "correctOptionId" not in session['checkpoint']
        assert client.get(f"/api/sessions/{sid}").json() == session
        body = {"request_id": "a", "expected_version": session['version'], "questionId": "q1", "optionId": "outside"}
        assert client.post(f"/api/sessions/{sid}/answers", json=body).status_code == 422
        assert client.post(f"/api/sessions/{sid}/answers", json={}).status_code == 422
        assert client.post("/api/sessions/missing/answers", json={**body, "optionId": "a"}).status_code == 404
        first = client.post(f"/api/sessions/{sid}/answers", json={**body, "optionId": "b"}).json()
        assert 'correctOptionId' not in first['checkpoint']
        assert first['checkpoint']['feedback'] == 'no'
        repick = client.post(f"/api/sessions/{sid}/answers", json={**body, "optionId": "b", "expected_version": first['version'], "request_id": "b"})
        assert repick.status_code == 422
        second = client.post(f"/api/sessions/{sid}/answers", json={**body, "optionId": "a", "expected_version": first['version'], "request_id": "b"}).json()
        assert second['checkpoint']['correctOptionId'] == 'a'
        assert len(second['learningNotes']) == 1
        question = client.get('/api/episodes/ep').json()['scenes'][1]['question']
        assert not {'feedback', 'correctOptionId', 'correctExplanation', 'incorrectExplanation', 'maxAttempts'} & question.keys()
        assert not {'mistakeResponse', 'correctOptionId'} & {k for o in question['options'] for k in o}


def test_grading_never_calls_a_provider(tmp_path, monkeypatch):
    from app.services.token_budget import MeteredProvider
    async def forbidden(*args, **kwargs):
        raise AssertionError("Checkpoint playback must never call the model")
    monkeypatch.setattr(MeteredProvider, "generate_structured", forbidden)
    session = parked(tmp_path, mistake=True)
    miss = submit(tmp_path, session, "b", "m1")
    done = submit(tmp_path, miss, "a", "m2")
    assert get_session(tmp_path, session.sessionId) == done
    apply_advance(tmp_path, session.sessionId, "go", done.version)


@pytest.mark.parametrize('field', ['firstIncorrect', 'correct', 'finalIncorrect'])
def test_feedback_nonblank_and_all_texts_reviewed(field):
    values = {'firstIncorrect': 'Hint', 'correct': 'Explanation', 'finalIncorrect': 'Review'}
    with pytest.raises(ValidationError):
        CheckpointFeedback(**{**values, field: '  '})
    script = _script()
    script.scenes[1].question.feedback = CheckpointFeedback(**values)
    texts = dict(_learner_texts(script))
    assert texts[f'q1.{field}'] == values[field]
    assert _script_view(script)['scenes'][1]['question']['feedback'] == values
    assert 'feedback' not in learner_view(script)['scenes'][1]['question']


def test_option_response_required_reviewed_and_stripped():
    raw = _script_payload()
    options = raw['scenes'][1]['question']['options']
    generated = GeneratedEpisode.model_validate(raw)
    assert all(o.mistakeResponse for o in generated.scenes[1].question.options)
    options[0].pop('mistakeResponse')
    with pytest.raises(ValidationError):
        GeneratedEpisode.model_validate(raw)
    options[0]['mistakeResponse'] = '  '
    with pytest.raises(ValidationError):
        GeneratedEpisode.model_validate(raw)

    script = _script()
    for option in script.scenes[1].question.options:
        option.mistakeResponse = f"why-{option.optionId}"
    texts = dict(_learner_texts(script))
    assert texts['q1.a.mistake'] == 'why-a'
    view = _script_view(script)['scenes'][1]['question']
    assert view['options'][0]['mistakeResponse'] == 'why-a'
    projected = learner_view(script)['scenes'][1]['question']
    assert all('mistakeResponse' not in o for o in projected['options'])


def test_answer_write_failure_rolls_back_attempt_and_request(tmp_path, monkeypatch):
    import app.storage.sessions as storage
    session = parked(tmp_path)
    def fail(*args):
        raise sqlite3.OperationalError("Injected write failure")
    with monkeypatch.context() as patch:
        patch.setattr(storage, "_write", fail)
        with pytest.raises(sqlite3.OperationalError):
            submit(tmp_path, session)
    assert get_session(tmp_path, session.sessionId) == session
    assert submit(tmp_path, session).checkpoint.attemptsUsed == 1


@pytest.mark.parametrize("stored_limit", [1, 3])
def test_stored_max_attempts_never_bounds_elimination(tmp_path, stored_limit):
    session = parked(tmp_path)
    script = _script()
    script.scenes[1].question.maxAttempts = stored_limit
    with sqlite3.connect(tmp_path / "app.db") as conn:
        conn.execute("UPDATE episodes SET payload=?", (script.model_dump_json(),))
    first = submit(tmp_path, session)
    assert not first.checkpoint.checkpointCompleted and first.checkpoint.attemptsUsed == 1
    second = submit(tmp_path, first, "a", "second")
    assert second.checkpoint.checkpointCompleted and second.checkpoint.isCorrect


@pytest.mark.parametrize("field", ["firstIncorrect", "correct", "finalIncorrect", "a.mistake", "b.mistake"])
def test_all_released_texts_are_checked_for_citation_artifacts(field):
    from app.tests.test_episode_validator import _script as validation_script
    script = validation_script()
    if field.endswith('.mistake'):
        option = next(o for o in script.scenes[1].question.options if o.optionId == field.split('.')[0])
        option.mistakeResponse = "chunkId: doc-p0001-000"
    else:
        setattr(script.scenes[1].question.feedback, field, "chunkId: doc-p0001-000")
    violations = deterministic_check(script, {"doc-1-p0001-000": (1, 1)}, {"obj-1"}, set(), Settings())
    assert any(f"q-1.{field}" in v for v in violations)
