import pytest
from pydantic import ValidationError

from app.models.episode import (
    AnswerOption,
    DialogueLine,
    EpisodeScene,
    EpisodeScript,
    EpisodeSourceRef,
    GeneratedEpisode,
    RecallQuestion,
    WebRef,
)
from app.models.episode import validate_script
from app.services.concept_analyzer import _inline_schema
from app.services.model_provider import _strictify

CHUNKS = {"doc-p0001-000": (1, 1), "doc-p0004-001": (4, 4)}
OBJECTIVES = {"obj-1"}
WEB_URLS = {"https://en.wikipedia.org/wiki/Cuneiform"}


def _ref(chunk_id="doc-p0001-000", document_id="doc-1"):
    pages = CHUNKS.get(chunk_id, (1, 1))
    return EpisodeSourceRef(
        chunkId=chunk_id, documentId=document_id, pageStart=pages[0], pageEnd=pages[1]
    )


def _line(line_id="line-1", **kwargs):
    return DialogueLine(
        **{"lineId": line_id, "speaker": "mascot", "text": "Hello",
           "emotion": "happy", **kwargs}
    )


def _question(question_id="q-1", **kwargs):
    return RecallQuestion(
        **{"questionId": question_id,
           "prompt": "Which?",
           "objectiveId": "obj-1",
           "options": [AnswerOption(optionId="a", label="A"), AnswerOption(optionId="b", label="B")],
           "correctOptionId": "a",
           "correctExplanation": "Because.",
           "incorrectExplanation": "Try again.",
           "sourceRefs": [_ref()],
           **kwargs}
    )


def _scene(scene_id, kind="dialogue", next_id=None, **kwargs):
    return EpisodeScene(sceneId=scene_id, kind=kind, nextSceneId=next_id, **kwargs)


def _script(scenes, **kwargs):
    return EpisodeScript(
        **{"episodeId": "ep-1",
           "documentId": "doc-1",
           "title": "T",
           "learningObjectives": ["Learn things"],
           "estimatedMinutes": 6.0,
           "startSceneId": "s1",
           "scenes": scenes,
           **kwargs}
    )


def _valid_scenes():
    return [
        _scene("s1", dialogue=[_line()], next_id="s2"),
        _scene("s2", kind="checkpoint", question=_question(), next_id="s3"),
        _scene("s3", dialogue=[_line("line-2")], next_id="s4"),
        _scene("s4", kind="checkpoint", question=_question("q-2"), next_id="s5"),
        _scene("s5", kind="ending", dialogue=[_line("line-3")]),
    ]


def test_schema_has_no_defs_and_strictifies():
    raw = GeneratedEpisode.model_json_schema()
    assert "$defs" not in raw or isinstance(raw.get("$defs"), dict)
    inlined = _inline_schema(GeneratedEpisode)
    assert "$defs" not in inlined and "$ref" not in str(inlined)
    strict = _strictify(inlined)
    assert strict["additionalProperties"] is False
    assert set(strict["required"]) == {"scenes", "problems"}


def test_valid_script_passes():
    assert validate_script(_script(_valid_scenes()), CHUNKS, OBJECTIVES, WEB_URLS) == []


def test_enum_and_shape_enforced_by_schema():
    with pytest.raises(ValidationError):
        _line(emotion="angry")
    with pytest.raises(ValidationError):
        _line(speaker="villain")
    with pytest.raises(ValidationError):
        _scene("x", kind="choice")


def test_dangling_next_scene_flagged():
    scenes = _valid_scenes()
    scenes[0].nextSceneId = "nope"
    violations = validate_script(_script(scenes), CHUNKS, OBJECTIVES, WEB_URLS)
    assert any("nextSceneId does not resolve" in v for v in violations)
    assert any("Unreachable scenes" in v for v in violations)


def test_wrong_checkpoint_count_flagged():
    scenes = _valid_scenes()
    scenes[3] = _scene("s4", dialogue=[_line("line-x")], next_id="s5")
    violations = validate_script(_script(scenes), CHUNKS, OBJECTIVES, WEB_URLS)
    assert any("exactly two checkpoints" in v for v in violations)


def test_invented_chunk_and_web_refs_flagged():
    bad = _line("line-bad", sourceRefs=[_ref("doc-p9999-000")],
                webRefs=[WebRef(title="X", url="https://example.com/not-supplied")])
    wrong_pages = EpisodeSourceRef(
        chunkId="doc-p0004-001", documentId="doc-1", pageStart=9, pageEnd=9
    )
    scenes = _valid_scenes()
    scenes[0].dialogue.append(bad)
    scenes[0].dialogue.append(_line("line-pages", sourceRefs=[wrong_pages]))
    violations = validate_script(_script(scenes), CHUNKS, OBJECTIVES, WEB_URLS)
    assert any("chunkId does not resolve" in v for v in violations)
    assert any("webRef url not supplied" in v for v in violations)
    assert any("pages do not match the chunk" in v for v in violations)


def test_question_invariants_flagged():
    scenes = _valid_scenes()
    q = scenes[1].question
    q.correctOptionId = "zzz"
    q.objectiveId = "obj-unknown"
    violations = validate_script(_script(scenes), CHUNKS, OBJECTIVES, WEB_URLS)
    assert any("correctOptionId not in options" in v for v in violations)
    assert any("objectiveId not in locked objectives" in v for v in violations)


def test_unreachable_ending_and_duplicate_ids_flagged():
    scenes = _valid_scenes()
    scenes[4].kind = "dialogue"
    scenes[4].dialogue[0].lineId = "line-1"
    violations = validate_script(_script(scenes), CHUNKS, OBJECTIVES, WEB_URLS)
    assert any("No ending scene is reachable" in v for v in violations)
    assert any("Duplicate line id" in v for v in violations)


def test_start_scene_and_missing_question_flagged():
    scenes = _valid_scenes()
    scenes[1].question = None
    script = _script(scenes, startSceneId="ghost")
    violations = validate_script(script, CHUNKS, OBJECTIVES, WEB_URLS)
    assert any("startSceneId does not resolve" in v for v in violations)
    assert any("checkpoint requires a question" in v for v in violations)
