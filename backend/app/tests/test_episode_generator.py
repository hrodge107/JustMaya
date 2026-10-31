import os
from pathlib import Path

import pytest

import app.services.episode_generator as gen
from app.config import Settings
from app.models.concept import Concept, Evidence, Objective, WebSupplement
from app.models.curriculum import EpisodeOutline, LessonContext, OrderedConcept, Roadmap
from app.models.episode import AnswerOption
from app.services.episode_generator import (
    GenerationError,
    generate_episode,
    passages_for_lesson,
)
from app.services.model_provider import StructuredResult
from app.services.token_budget import MeteredProvider
from app.storage.database import init_db


def _settings(**kw) -> Settings:
    os.environ["META_API_KEY"] = "test-key"
    return Settings(_env_file=None, **kw)


@pytest.fixture
def data_dir(tmp_path: Path) -> Path:
    init_db(tmp_path)
    return tmp_path


class FakeCollection:
    def __init__(self, rows):
        self._rows = rows

    def get(self, where=None, include=None):
        return {
            "ids": [r["id"] for r in self._rows],
            "documents": [r["text"] for r in self._rows],
            "metadatas": [r["meta"] for r in self._rows],
        }


def _chunk(chunk_id, page, text="text"):
    return {
        "id": chunk_id,
        "text": text,
        "meta": {
            "chunk_id": chunk_id,
            "document_id": "doc-1",
            "page_start": page,
            "page_end": page,
            "section_id": None,
        },
    }


def _concept(cid="c1", page=1):
    return Concept(
        id=cid, title=f"Concept {cid}", explanation="Expl.",
        evidence=[Evidence(document_id="doc-1", page_start=page, page_end=page)],
    )


def _lesson_context(supplements=None):
    return LessonContext(
        episode_id="ep-1",
        objectives=[Objective(id="obj-1", description="Learn cuneiform",
                              concept_ids=["c1"],
                              evidence=[Evidence(document_id="doc-1", page_start=1, page_end=1)])],
        concepts=[_concept("c1", 1)],
        teaching_order=[OrderedConcept(concept_id="c1", basis="source_order", explanation="first")],
        relationships=[],
        supplements=supplements or [],
        uncertainty=[],
        excluded_concept_ids=["c2"],
    )


def _roadmap(ctx: LessonContext) -> Roadmap:
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
                dialogue_words=30,
                words_per_minute=140.0,
                interaction_minutes=2.0,
                status="selected",
            )
        ],
        lesson_context=ctx,
    )


def _script_payload(chunk_id="doc-1-p0001-000", words_per_line=10):
    def line(lid, **kw):
        return {"lineId": lid, "speaker": "mascot", "text": "word " * words_per_line,
                "emotion": "happy", "sourceRefs": [], "webRefs": [], **kw}

    def question(qid):
        return {
            "questionId": qid, "prompt": "Which?", "objectiveId": "obj-1",
            "options": [{"optionId": "a", "label": "A", "mistakeResponse": "Not A."},
                        {"optionId": "b", "label": "B", "mistakeResponse": "Not B."},
                        {"optionId": "c", "label": "C", "mistakeResponse": "Not C."}],
            "correctOptionId": "a", "correctExplanation": "Because.",
            "incorrectExplanation": "Try again.",
            "sourceRefs": [{"chunkId": chunk_id, "documentId": "doc-1",
                            "pageStart": 1, "pageEnd": 1}],
            "webRefs": [],
        }

    return {
        "scenes": [
            {"sceneId": "s1", "kind": "dialogue", "dialogue": [line("l1")], "nextSceneId": "s2"},
            {"sceneId": "s2", "kind": "checkpoint", "dialogue": [], "question": question("q1"), "nextSceneId": "s3"},
            {"sceneId": "s3", "kind": "dialogue", "dialogue": [line("l2")], "nextSceneId": "s4"},
            {"sceneId": "s4", "kind": "checkpoint", "dialogue": [], "question": question("q2"), "nextSceneId": "s5"},
            {"sceneId": "s5", "kind": "ending", "dialogue": [line("l3")], "nextSceneId": None},
        ],
        "problems": [],
    }


class GenStub:
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


def _metered(stub: GenStub, data_dir: Path, settings: Settings) -> MeteredProvider:
    return MeteredProvider(stub, settings, data_dir)


def test_passages_cover_selected_pages_only(monkeypatch):
    collection = FakeCollection([_chunk("doc-1-p0001-000", 1), _chunk("doc-1-p0004-001", 4)])
    monkeypatch.setattr(gen, "get_collection", lambda settings: collection)
    passages, known = passages_for_lesson("doc-1", _lesson_context(), _settings())
    assert [p.chunk_id for p in passages] == ["doc-1-p0001-000"]
    assert passages[0].source.page_start == 1
    assert known == {"doc-1-p0001-000": (1, 1), "doc-1-p0004-001": (4, 4)}


def test_passages_capped_and_ordered(monkeypatch):
    rows = [_chunk(f"doc-1-p{p:04d}-000", p) for p in (3, 1, 2)]
    monkeypatch.setattr(gen, "get_collection", lambda settings: FakeCollection(rows))
    ctx = _lesson_context()
    ctx.concepts[0].evidence[0].page_end = 3
    passages, _ = passages_for_lesson("doc-1", ctx, _settings(generation_max_passages=2))
    assert [p.source.page_start for p in passages] == [1, 2]


@pytest.mark.anyio
async def test_generates_and_recounts_minutes(data_dir):
    settings = _settings()
    stub = GenStub([_script_payload()])
    script = await generate_episode(
        _roadmap(_lesson_context()), _lesson_context(), [],
        {"doc-1-p0001-000": (1, 1)}, _metered(stub, data_dir, settings), "j1", settings,
    )
    assert script.episodeId == "ep-1"
    assert script.documentId == "doc-1"
    assert script.title == "Writing Before Paper"
    assert script.learningObjectives == ["Learn cuneiform"]
    assert script.status == "draft" and script.startSceneId == "s1"
    # 3 dialogue lines x 10 words = 30 words -> 30/140 + 2.0
    assert script.estimatedMinutes == pytest.approx(30 / 140.0 + 2.0)
    call = stub.calls[0]
    assert call["cache_key"] == "episode-generation-v4"
    assert call["max_tokens"] == settings.generation_max_tokens
    assert "# Episode direction" in call["system"] and "# Instructor voice" in call["system"]
    from app.services.token_budget import job_usage
    assert job_usage(data_dir, "j1")["by_stage"] == {"generation": 15}


@pytest.mark.anyio
async def test_prompt_carries_passages_and_context(data_dir, monkeypatch):
    settings = _settings()
    stub = GenStub([_script_payload()])
    ctx = _lesson_context()
    collection = FakeCollection([_chunk("doc-1-p0001-000", 1, "cuneiform chunk text")])
    monkeypatch.setattr(gen, "get_collection", lambda s: collection)
    passages, known = passages_for_lesson("doc-1", ctx, settings)
    await generate_episode(_roadmap(ctx), ctx, passages, known,
                           _metered(stub, data_dir, settings), "j1", settings)
    user = stub.calls[0]["user"]
    assert "doc-1-p0001-000" in user and "cuneiform chunk text" in user
    assert "Learn cuneiform" in user


@pytest.mark.anyio
async def test_refusal_channel_fails(data_dir):
    settings = _settings()
    payload = {"scenes": [], "problems": ["objective unsupported by evidence"]}
    payload["scenes"] = _script_payload()["scenes"]
    stub = GenStub([payload])
    with pytest.raises(GenerationError, match="insufficient lesson context"):
        await generate_episode(
            _roadmap(_lesson_context()), _lesson_context(), [], {},
            _metered(stub, data_dir, settings), "j1", settings,
        )


@pytest.mark.anyio
async def test_input_bound_refuses_before_call(data_dir):
    settings = _settings(generation_max_input_tokens=50)
    stub = GenStub([_script_payload()], count=999)
    with pytest.raises(GenerationError, match="GENERATION_INPUT_TOO_LARGE"):
        await generate_episode(
            _roadmap(_lesson_context()), _lesson_context(), [], {},
            _metered(stub, data_dir, settings), "j1", settings,
        )
    assert stub.calls == []


@pytest.mark.anyio
async def test_repair_pass_fixes_dangling_id(data_dir):
    settings = _settings()
    bad = _script_payload()
    bad["scenes"][0]["nextSceneId"] = "ghost"
    stub = GenStub([bad, _script_payload()])
    script = await generate_episode(
        _roadmap(_lesson_context()), _lesson_context(), [],
        {"doc-1-p0001-000": (1, 1)}, _metered(stub, data_dir, settings), "j1", settings,
    )
    assert len(stub.calls) == 2
    assert "nextSceneId does not resolve" in stub.calls[1]["user"]
    assert script.startSceneId == "s1"


@pytest.mark.anyio
async def test_undersized_output_is_repaired(data_dir):
    settings = _settings()
    roadmap = _roadmap(_lesson_context())
    roadmap.episodes[0].dialogue_words = 700
    stub = GenStub([_script_payload(), _script_payload(words_per_line=200)])
    script = await generate_episode(
        roadmap, _lesson_context(), [],
        {"doc-1-p0001-000": (1, 1)}, _metered(stub, data_dir, settings), "j1", settings,
    )
    assert len(stub.calls) == 2
    assert "below minimum 560" in stub.calls[1]["user"]
    assert script.startSceneId == "s1"


@pytest.mark.anyio
async def test_undersized_twice_fails_with_violations(data_dir):
    settings = _settings()
    roadmap = _roadmap(_lesson_context())
    roadmap.episodes[0].dialogue_words = 700
    stub = GenStub([_script_payload(), _script_payload()])
    with pytest.raises(GenerationError, match="below minimum 560"):
        await generate_episode(
            roadmap, _lesson_context(), [], {},
            _metered(stub, data_dir, settings), "j1", settings,
        )
    assert len(stub.calls) == 2


@pytest.mark.anyio
async def test_twice_invalid_fails_with_violations(data_dir):
    settings = _settings()
    bad = _script_payload()
    bad["scenes"][0]["nextSceneId"] = "ghost"
    stub = GenStub([bad, dict(bad)])
    with pytest.raises(GenerationError, match="structural checks"):
        await generate_episode(
            _roadmap(_lesson_context()), _lesson_context(), [], {},
            _metered(stub, data_dir, settings), "j1", settings,
        )
    assert len(stub.calls) == 2


@pytest.mark.anyio
async def test_option_response_required_and_prompted(data_dir):
    settings = _settings()
    payload = _script_payload()
    del payload["scenes"][1]["question"]["options"][0]["mistakeResponse"]
    stub = GenStub([payload, _script_payload()])
    script = await generate_episode(
        _roadmap(_lesson_context()), _lesson_context(), [],
        {"doc-1-p0001-000": (1, 1)}, _metered(stub, data_dir, settings), "j1", settings,
    )
    assert len(stub.calls) == 2
    assert "did not conform to schema" in stub.calls[1]["user"]
    assert "mistakeResponse" in stub.calls[1]["user"]
    assert script.startSceneId == "s1"


def test_system_prompt_instructs_per_option_responses():
    system = gen._system()
    assert "mistakeResponse" in system
    assert "selected idea and its mistaken inference" in system
    assert "one concrete next reasoning action" in system
    assert "firstIncorrect" not in system and "maxAttempts" not in system


def test_system_prompt_instructs_teaching_beats():
    system = gen._system()
    assert "at least three distinct teaching or application beats" in system
    assert "substantive teaching" in system and "not longer lines" in system


@pytest.mark.anyio
async def test_unconfirmed_roadmap_fails(data_dir):
    settings = _settings()
    roadmap = _roadmap(_lesson_context())
    roadmap.confirmed = False
    stub = GenStub([_script_payload()])
    with pytest.raises(GenerationError, match="ROADMAP_NOT_CONFIRMED"):
        await generate_episode(
            roadmap, _lesson_context(), [], {},
            _metered(stub, data_dir, settings), "j1", settings,
        )
    assert stub.calls == []


def test_generation_settings_env_override(monkeypatch):
    monkeypatch.setenv("GENERATION_MAX_TOKENS", "45000")
    monkeypatch.setenv("GENERATION_MAX_INPUT_TOKENS", "12000")
    monkeypatch.setenv("GENERATION_MAX_PASSAGES", "5")
    settings = _settings()
    assert settings.generation_max_tokens == 45000
    assert settings.generation_max_input_tokens == 12000
    assert settings.generation_max_passages == 5
