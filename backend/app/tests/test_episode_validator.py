from pathlib import Path

import pytest

from app.config import Settings
from app.models.concept import Concept, Evidence, Objective
from app.models.curriculum import LessonContext, OrderedConcept
from app.models.episode import (
    AnswerOption,
    DialogueLine,
    EpisodeScene,
    EpisodeScript,
    EpisodeSourceRef,
    RecallQuestion,
    SemanticVerdict,
    ValidationReport,
)
from app.models.curriculum import EpisodeOutline, Roadmap
from app.services.episode_generator import generate_episode
from app.services.episode_validator import (
    ValidationFailed,
    build_report,
    deterministic_check,
    report_passing,
    semantic_review,
    validate_and_publish,
)
from app.services.model_provider import StructuredResult
from app.services.token_budget import MeteredProvider, job_usage
from app.storage.database import init_db
from app.storage.episodes import (
    publish_episode,
    read_episode_by_id,
    read_episode_state,
    record_validation,
    save_episode_draft,
)
import sqlite3

CHUNKS = {"doc-1-p0001-000": (1, 1)}
OBJECTIVES = {"obj-1"}


@pytest.fixture
def settings(monkeypatch):
    monkeypatch.setenv("META_API_KEY", "test-key")
    return Settings(_env_file=None)


@pytest.fixture
def data_dir(tmp_path: Path) -> Path:
    init_db(tmp_path)
    return tmp_path


class ReviewStub:
    def __init__(self, payloads, count=100):
        self.payloads = list(payloads)
        self.calls: list[dict] = []
        self.count = count
        self.usage = {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15}

    async def generate_structured(self, **kw) -> StructuredResult:
        self.calls.append(kw)
        return StructuredResult(data=self.payloads.pop(0), usage=self.usage)

    async def count_input_tokens(self, **kw) -> int:
        return self.count


def _lesson_context():
    return LessonContext(
        episode_id="ep-1",
        objectives=[
            Objective(
                id="obj-1",
                description="Learn cuneiform",
                concept_ids=["c1"],
                evidence=[Evidence(document_id="doc-1", page_start=1, page_end=1)],
            )
        ],
        concepts=[
            Concept(
                id="c1",
                title="Cuneiform",
                explanation="Wedge writing.",
                evidence=[Evidence(document_id="doc-1", page_start=1, page_end=1)],
            )
        ],
        teaching_order=[
            OrderedConcept(concept_id="c1", basis="source_order", explanation="first")
        ],
        relationships=[],
        supplements=[],
        uncertainty=[],
        excluded_concept_ids=["c2"],
    )


def _ref():
    return EpisodeSourceRef(
        chunkId="doc-1-p0001-000", documentId="doc-1", pageStart=1, pageEnd=1
    )


def _line(line_id="line-1", text="Hello learners.", **kwargs):
    return DialogueLine(
        lineId=line_id, speaker="mascot", text=text, emotion="happy", **kwargs
    )


def _question(question_id="q-1"):
    return RecallQuestion(
        questionId=question_id,
        prompt="What did we cover?",
        objectiveId="obj-1",
        options=[AnswerOption(optionId="a", label="A", mistakeResponse="Not A."),
                 AnswerOption(optionId="b", label="B", mistakeResponse="Not B."),
                 AnswerOption(optionId="c", label="C", mistakeResponse="Not C.")],
        correctOptionId="a",
        correctExplanation="Because.",
        incorrectExplanation="Try again.",
        feedback={"firstIncorrect": "Think about the lesson.", "correct": "Because.", "finalIncorrect": "The answer is A."},
        sourceRefs=[_ref()],
    )


def _script(scenes=None, **kwargs):
    scenes = scenes or [
        EpisodeScene(sceneId="s1", kind="dialogue", dialogue=[_line()], nextSceneId="s2"),
        EpisodeScene(sceneId="s2", kind="checkpoint", question=_question(), nextSceneId="s3"),
        EpisodeScene(sceneId="s3", kind="dialogue", dialogue=[_line("line-2")], nextSceneId="s4"),
        EpisodeScene(sceneId="s4", kind="checkpoint", question=_question("q-2"), nextSceneId="s5"),
        EpisodeScene(sceneId="s5", kind="ending", dialogue=[_line("line-3", "Done!")]),
    ]
    return EpisodeScript(
        episodeId="ep-1",
        documentId="doc-1",
        learningObjectives=["Learn things"],
        startSceneId="s1",
        scenes=scenes,
        **{"title": "T", "estimatedMinutes": 4.0, **kwargs},
    )


def test_validation_settings_defaults_and_overrides(monkeypatch):
    monkeypatch.setenv("META_API_KEY", "test-key")
    defaults = Settings(_env_file=None)
    assert defaults.validation_max_scenes == 24
    assert defaults.validation_max_dialogue_words == 2200
    assert defaults.validation_checkpoint_count == 2
    assert defaults.validation_max_minutes == 15.0
    assert defaults.validation_max_input_tokens == 48_000
    assert defaults.validation_max_tokens == 20_000

    monkeypatch.setenv("VALIDATION_MAX_SCENES", "10")
    monkeypatch.setenv("VALIDATION_CHECKPOINT_COUNT", "3")
    monkeypatch.setenv("VALIDATION_MAX_MINUTES", "8.5")
    overridden = Settings(_env_file=None)
    assert overridden.validation_max_scenes == 10
    assert overridden.validation_checkpoint_count == 3
    assert overridden.validation_max_minutes == 8.5


def test_validation_report_round_trip():
    report = ValidationReport(
        checked_at="2026-10-28T00:00:00+00:00",
        deterministic_violations=["v1"],
        semantic=SemanticVerdict(
            verdict="fail",
            violations=[{"check": "coverage", "detail": "obj-1 not taught"}],
        ),
        regenerated=True,
        bounds={"max_scenes": 24},
    )
    parsed = ValidationReport.model_validate_json(report.model_dump_json())
    assert parsed.semantic.verdict == "fail"
    assert parsed.semantic.violations[0].check == "coverage"
    assert parsed.regenerated is True


def test_clean_script_passes_deterministic(settings):
    assert deterministic_check(_script(), CHUNKS, OBJECTIVES, set(), settings) == []


def test_corrupted_script_lists_violations(settings):
    scenes = _script().scenes
    scenes[0].nextSceneId = "nope"
    bad = _line("line-bad", sourceRefs=[_ref()])
    bad.sourceRefs[0].chunkId = "doc-1-p9999-000"
    scenes[0].dialogue.append(bad)
    violations = deterministic_check(_script(scenes), CHUNKS, OBJECTIVES, set(), settings)
    assert any("nextSceneId does not resolve" in v for v in violations)
    assert any("chunkId does not resolve" in v for v in violations)


def test_bounds_violations_named(settings):
    settings.validation_max_scenes = 3
    settings.validation_max_minutes = 2.0
    violations = deterministic_check(_script(), CHUNKS, OBJECTIVES, set(), settings)
    assert any("Scene count 5 exceeds max 3" in v for v in violations)
    assert any("Estimated minutes" in v and "exceeds max" in v for v in violations)


def test_dialogue_word_bound(settings):
    settings.validation_max_dialogue_words = 2
    violations = deterministic_check(_script(), CHUNKS, OBJECTIVES, set(), settings)
    assert any("Dialogue words" in v for v in violations)


def test_short_episode_not_failed_for_duration(settings):
    settings.validation_max_minutes = 15.0
    assert (
        deterministic_check(
            _script(estimatedMinutes=1.5), CHUNKS, OBJECTIVES, set(), settings
        )
        == []
    )


def test_dialogue_minimum_relative_to_target(settings):
    # _script() carries 5 dialogue words.
    violations = deterministic_check(
        _script(), CHUNKS, OBJECTIVES, set(), settings, target_dialogue_words=8
    )
    assert any("Dialogue words 5 below minimum 6" in v for v in violations)
    assert deterministic_check(
        _script(), CHUNKS, OBJECTIVES, set(), settings, target_dialogue_words=7
    ) == []


def test_small_target_keeps_small_floor(settings):
    # A thin outline (target 5) floors at 4 — the 5-word script stays legal.
    assert deterministic_check(
        _script(), CHUNKS, OBJECTIVES, set(), settings, target_dialogue_words=5
    ) == []
    violations = deterministic_check(
        _script(), CHUNKS, OBJECTIVES, set(), settings
    )
    assert not any("below minimum" in v for v in violations)


def test_citation_leak_flagged(settings):
    scenes = _script().scenes
    scenes[0].dialogue[0].text = "See doc-1-p0001-000 for details."
    scenes[2].dialogue[0].text = "According to sourceRef chunkId, it works."
    violations = deterministic_check(_script(scenes), CHUNKS, OBJECTIVES, set(), settings)
    assert any("line-1" in v and "chunk reference" in v for v in violations)
    assert any("line-2" in v and "citation artifact" in v for v in violations)


def test_option_responses_reviewed_and_in_view(settings):
    script = _script()
    scene = next(s for s in script.scenes if s.question)
    scene.question.options[0].mistakeResponse = "per chunkId doc-1-p0001-000"
    violations = deterministic_check(script, CHUNKS, OBJECTIVES, set(), settings)
    assert any("q-1.a.mistake" in v and "citation artifact" in v for v in violations)
    from app.services.episode_validator import _script_view
    view = _script_view(_script())
    option = next(s for s in view["scenes"] if s.get("question"))["question"]["options"][0]
    assert option["mistakeResponse"] == "Not A."


def test_configurable_checkpoint_count(settings):
    settings.validation_checkpoint_count = 1
    violations = deterministic_check(_script(), CHUNKS, OBJECTIVES, set(), settings)
    assert any("exactly 1 checkpoints" in v for v in violations)


def test_build_report_bounds(settings):
    report = build_report(["v"], settings=settings)
    assert report.bounds["checkpoint_count"] == 2
    assert report.bounds["min_target_fraction"] == 0.8
    assert report.deterministic_violations == ["v"]


@pytest.mark.anyio
async def test_semantic_review_meters_and_parses(settings, data_dir):
    stub = ReviewStub([{"verdict": "pass", "violations": []}])
    verdict = await semantic_review(
        _script(), _lesson_context(), [],
        MeteredProvider(stub, settings, data_dir), "j1", settings,
    )
    assert verdict.verdict == "pass" and verdict.violations == []
    call = stub.calls[0]
    assert call["cache_key"] == "episode-validation-v4"
    assert "every wrong option separately" in call["system"]
    assert call["max_tokens"] == settings.validation_max_tokens
    assert call["schema"]["properties"]["verdict"]["enum"] == ["pass", "fail"]
    assert "untrusted_script" in call["user"] and "Cuneiform" in call["user"]
    assert job_usage(data_dir, "j1")["by_stage"] == {"validation": 15}


@pytest.mark.anyio
async def test_semantic_review_fail_verdict(settings, data_dir):
    stub = ReviewStub([
        {"verdict": "fail",
         "violations": [{"check": "coverage", "detail": "obj-1 not taught"}]}
    ])
    verdict = await semantic_review(
        _script(), _lesson_context(), [],
        MeteredProvider(stub, settings, data_dir), "j1", settings,
    )
    assert verdict.verdict == "fail"
    assert verdict.violations[0].check == "coverage"


@pytest.mark.anyio
async def test_semantic_review_input_bound_refuses(settings, data_dir):
    settings.validation_max_input_tokens = 50
    stub = ReviewStub([{"verdict": "pass", "violations": []}], count=999)
    with pytest.raises(ValidationFailed, match="VALIDATION_INPUT_TOO_LARGE"):
        await semantic_review(
            _script(), _lesson_context(), [],
            MeteredProvider(stub, settings, data_dir), "j1", settings,
        )
    assert stub.calls == []


@pytest.mark.anyio
async def test_semantic_review_malformed_verdict_fails(settings, data_dir):
    stub = ReviewStub([{"unexpected": "shape"}])
    with pytest.raises(ValidationFailed, match="unusable verdict"):
        await semantic_review(
            _script(), _lesson_context(), [],
            MeteredProvider(stub, settings, data_dir), "j1", settings,
        )


def _roadmap(ctx) -> Roadmap:
    return Roadmap(
        curriculum_id="cur-1",
        document_id="doc-1",
        revision=1,
        confirmed=True,
        episodes=[
            EpisodeOutline(
                episode_id="ep-1",
                title="Writing Before Paper",
                objective_ids=["obj-1"],
                concepts=[OrderedConcept(concept_id="c1", basis="source_order", explanation="first")],
                dialogue_words=5,
                words_per_minute=140.0,
                interaction_minutes=2.0,
                status="selected",
            )
        ],
        lesson_context=ctx,
    )


def _generated_payload():
    def line(lid):
        return {"lineId": lid, "speaker": "mascot", "text": "word " * 10,
                "emotion": "happy", "sourceRefs": [], "webRefs": []}

    def question(qid):
        return {"questionId": qid, "prompt": "Which?", "objectiveId": "obj-1",
                "options": [{"optionId": "a", "label": "A", "mistakeResponse": "Not A."},
                            {"optionId": "b", "label": "B", "mistakeResponse": "Not B."},
                            {"optionId": "c", "label": "C", "mistakeResponse": "Not C."}],
                "correctOptionId": "a", "correctExplanation": "Because.",
                "incorrectExplanation": "Try again.",
                "sourceRefs": [{"chunkId": "doc-1-p0001-000", "documentId": "doc-1",
                                "pageStart": 1, "pageEnd": 1}],
                "webRefs": []}

    return {"scenes": [
        {"sceneId": "s1", "kind": "dialogue", "dialogue": [line("l1")], "nextSceneId": "s2"},
        {"sceneId": "s2", "kind": "checkpoint", "dialogue": [], "question": question("q1"), "nextSceneId": "s3"},
        {"sceneId": "s3", "kind": "dialogue", "dialogue": [line("l2")], "nextSceneId": "s4"},
        {"sceneId": "s4", "kind": "checkpoint", "dialogue": [], "question": question("q2"), "nextSceneId": "s5"},
        {"sceneId": "s5", "kind": "ending", "dialogue": [line("l3")], "nextSceneId": None},
    ], "problems": []}


def _seed_document(data_dir: Path):
    conn = sqlite3.connect(data_dir / "app.db")
    try:
        with conn:
            conn.execute(
                "INSERT INTO documents (document_id, filename, status, created_at) "
                "VALUES ('doc-1', 'f.pdf', 'processing', 'now')"
            )
    finally:
        conn.close()


@pytest.mark.anyio
async def test_repair_seed_reaches_request(settings, data_dir):
    stub = ReviewStub([_generated_payload()])
    await generate_episode(
        _roadmap(_lesson_context()), _lesson_context(), [], CHUNKS,
        MeteredProvider(stub, settings, data_dir), "j1", settings,
        repair=["coverage: obj-1 not taught"],
    )
    assert "coverage: obj-1 not taught" in stub.calls[0]["user"]
    assert "failed verification" in stub.calls[0]["user"]


@pytest.mark.anyio
async def test_validate_and_publish_pass_first_try(settings, data_dir):
    _seed_document(data_dir)
    ctx = _lesson_context()
    save_episode_draft(data_dir, _script(), "cur-1")
    stub = ReviewStub([{"verdict": "pass", "violations": []}])
    script, report = await validate_and_publish(
        data_dir, _script(), _roadmap(ctx), ctx, [], CHUNKS,
        MeteredProvider(stub, settings, data_dir), "j1", settings,
    )
    assert report_passing(report) and not report.regenerated
    assert len(stub.calls) == 1
    state = read_episode_state(data_dir, "doc-1")
    assert state["status"] == "ready"
    assert "pass" in state["validation"]
    conn = sqlite3.connect(data_dir / "app.db")
    try:
        assert conn.execute(
            "SELECT status FROM documents WHERE document_id='doc-1'"
        ).fetchone()[0] == "ready"
    finally:
        conn.close()


@pytest.mark.anyio
async def test_validate_and_publish_regen_fixes(settings, data_dir):
    _seed_document(data_dir)
    ctx = _lesson_context()
    save_episode_draft(data_dir, _script(), "cur-1")
    stub = ReviewStub([
        {"verdict": "fail",
         "violations": [{"check": "coverage", "detail": "obj-1 not taught"}]},
        _generated_payload(),
        {"verdict": "pass", "violations": []},
    ])
    script, report = await validate_and_publish(
        data_dir, _script(), _roadmap(ctx), ctx, [], CHUNKS,
        MeteredProvider(stub, settings, data_dir), "j1", settings,
    )
    assert report_passing(report) and report.regenerated
    assert len(stub.calls) == 3  # review + regen + re-review
    assert "obj-1 not taught" in stub.calls[1]["user"]
    assert read_episode_state(data_dir, "doc-1")["status"] == "ready"


@pytest.mark.anyio
async def test_validate_and_publish_regen_exhausted_fails(settings, data_dir):
    _seed_document(data_dir)
    ctx = _lesson_context()
    save_episode_draft(data_dir, _script(), "cur-1")
    stub = ReviewStub([
        {"verdict": "fail", "violations": [{"check": "feedback", "detail": "s2.q1.b: generic praise; no next step"}]},
        _generated_payload(),
        {"verdict": "fail", "violations": [{"check": "feedback", "detail": "s2.q1.b: keyed answer leaked"}]},
    ])
    _, report = await validate_and_publish(
        data_dir, _script(), _roadmap(ctx), ctx, [], CHUNKS,
        MeteredProvider(stub, settings, data_dir), "j1", settings,
    )
    assert not report_passing(report) and report.regenerated
    assert len(stub.calls) == 3
    assert read_episode_state(data_dir, "doc-1")["status"] == "draft"
    assert "s2.q1.b: keyed answer leaked" in read_episode_state(data_dir, "doc-1")["validation"]


@pytest.mark.anyio
async def test_deterministic_failure_spends_no_tokens(settings, data_dir):
    _seed_document(data_dir)
    ctx = _lesson_context()
    broken = _script()
    broken.scenes[0].nextSceneId = "ghost"
    save_episode_draft(data_dir, broken, "cur-1")
    stub = ReviewStub([])
    _, report = await validate_and_publish(
        data_dir, broken, _roadmap(ctx), ctx, [], CHUNKS,
        MeteredProvider(stub, settings, data_dir), "j1", settings,
    )
    assert not report_passing(report)
    assert stub.calls == []
    assert any("nextSceneId" in v for v in report.deterministic_violations)
    assert job_usage(data_dir, "j1")["total_tokens"] == 0


@pytest.mark.anyio
async def test_undersized_draft_fails_without_tokens(settings, data_dir):
    _seed_document(data_dir)
    ctx = _lesson_context()
    save_episode_draft(data_dir, _script(), "cur-1")
    roadmap = _roadmap(ctx)
    roadmap.episodes[0].dialogue_words = 100
    stub = ReviewStub([])
    _, report = await validate_and_publish(
        data_dir, _script(), roadmap, ctx, [], CHUNKS,
        MeteredProvider(stub, settings, data_dir), "j1", settings,
    )
    assert not report_passing(report)
    assert stub.calls == []
    assert any("below minimum 80" in v for v in report.deterministic_violations)
    assert job_usage(data_dir, "j1")["total_tokens"] == 0


@pytest.mark.anyio
async def test_ready_row_survives_failed_regeneration(settings, data_dir):
    _seed_document(data_dir)
    ctx = _lesson_context()
    good_report = build_report([], SemanticVerdict(verdict="pass"), settings=settings)
    assert publish_episode(data_dir, _script(), good_report, "cur-1") is True
    stub = ReviewStub([
        {"verdict": "fail", "violations": [{"check": "coverage", "detail": "x"}]},
        _generated_payload(),
        {"verdict": "fail", "violations": [{"check": "coverage", "detail": "still"}]},
    ])
    await validate_and_publish(
        data_dir, _script(), _roadmap(ctx), ctx, [], CHUNKS,
        MeteredProvider(stub, settings, data_dir), "j1", settings,
    )
    state = read_episode_state(data_dir, "doc-1")
    assert state["status"] == "ready"
    assert '"verdict":"pass"' in state["validation"]


def test_publish_and_read_by_id(settings, data_dir):
    _seed_document(data_dir)
    report = build_report([], SemanticVerdict(verdict="pass"), settings=settings)
    assert publish_episode(data_dir, _script(), report, "cur-1") is True
    assert read_episode_by_id(data_dir, "ep-1").status == "ready"
    # frozen: a second publish does not overwrite
    again = build_report([], SemanticVerdict(verdict="fail"), settings=settings)
    assert publish_episode(data_dir, _script(title="Replaced"), again, "cur-1") is False
    assert read_episode_by_id(data_dir, "ep-1").title == "T"


def test_record_validation_freezes_ready(settings, data_dir):
    _seed_document(data_dir)
    report = build_report([], SemanticVerdict(verdict="pass"), settings=settings)
    publish_episode(data_dir, _script(), report, "cur-1")
    record_validation(data_dir, "ep-1", build_report(["new-fail"], settings=settings))
    state = read_episode_state(data_dir, "doc-1")
    assert state["status"] == "ready" and "new-fail" not in state["validation"]


def test_read_episode_by_id_unknown(data_dir):
    with pytest.raises(LookupError):
        read_episode_by_id(data_dir, "nope")


def test_get_episode_endpoint(settings, data_dir):
    from fastapi.testclient import TestClient

    from app.main import create_app

    _seed_document(data_dir)
    report = build_report([], SemanticVerdict(verdict="pass"), settings=settings)
    publish_episode(data_dir, _script(), report, "cur-1")
    with TestClient(create_app(data_dir=data_dir)) as client:
        response = client.get("/api/episodes/ep-1")
        assert response.status_code == 200
        body = response.json()
        assert body["episodeId"] == "ep-1" and body["status"] == "ready"
        assert body["scenes"][0]["sceneId"] == "s1"
        missing = client.get("/api/episodes/nope")
        assert missing.status_code == 404
        assert missing.json()["error"]["code"] == "NOT_FOUND"


def test_get_episode_returns_draft_verbatim(settings, data_dir):
    from fastapi.testclient import TestClient

    from app.main import create_app

    _seed_document(data_dir)
    save_episode_draft(data_dir, _script(), "cur-1")
    with TestClient(create_app(data_dir=data_dir)) as client:
        body = client.get("/api/episodes/ep-1").json()
        assert body["status"] == "draft"
