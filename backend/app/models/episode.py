"""Playable episode script contract (spec section 7.3) plus structural checks.

Field names are camelCase to match the persisted EpisodeScript JSON exactly;
the player and A08 validation consume this contract verbatim. `webRefs` is an
additive internal-provenance extension for web-origin claims — never rendered
to the learner. `GeneratedEpisode` is the model-facing wire shape: scenes plus
the refusal channel; envelope fields are filled by code, never by the model.
"""

from collections import deque
from typing import Literal

from pydantic import BaseModel, Field, field_validator

Emotion = Literal["idle", "talking", "thinking", "happy", "confused"]
SceneKind = Literal["dialogue", "checkpoint", "ending"]


class WebRef(BaseModel):
    title: str
    url: str


class EpisodeSourceRef(BaseModel):
    chunkId: str
    documentId: str
    pageStart: int = Field(ge=1)
    pageEnd: int = Field(ge=1)
    sectionId: str | None = None


class DialogueLine(BaseModel):
    lineId: str = Field(min_length=1)
    speaker: Literal["mascot", "narrator"]
    text: str
    emotion: Emotion
    sourceRefs: list[EpisodeSourceRef] = []
    webRefs: list[WebRef] = []


class AnswerOption(BaseModel):
    optionId: str
    label: str
    # Dedicated response released when this option is picked wrong. Grading
    # data — never leaves the server on learner reads. Optional so episodes
    # persisted before per-option responses still parse.
    mistakeResponse: str | None = None


class GeneratedAnswerOption(AnswerOption):
    mistakeResponse: str

    @field_validator("mistakeResponse")
    @classmethod
    def nonblank(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("mistakeResponse must not be blank")
        return value


class CheckpointFeedback(BaseModel):
    firstIncorrect: str = Field(min_length=1)
    correct: str = Field(min_length=1)
    finalIncorrect: str = Field(min_length=1)

    @field_validator("firstIncorrect", "correct", "finalIncorrect")
    @classmethod
    def nonblank(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("Feedback must not be blank")
        return value


class RecallQuestion(BaseModel):
    questionId: str
    prompt: str
    objectiveId: str
    options: list[AnswerOption] = Field(min_length=2)
    correctOptionId: str
    correctExplanation: str
    incorrectExplanation: str
    feedback: CheckpointFeedback | None = None
    sourceRefs: list[EpisodeSourceRef] = []
    webRefs: list[WebRef] = []
    # Persisted compat only: elimination means attempts are unbounded until
    # the correct pick, so stored values are tolerated but never applied.
    maxAttempts: int = Field(default=2, ge=1)


class GeneratedRecallQuestion(RecallQuestion):
    options: list[GeneratedAnswerOption] = Field(min_length=3, max_length=3)


class EpisodeScene(BaseModel):
    sceneId: str
    kind: SceneKind
    dialogue: list[DialogueLine] = []
    question: RecallQuestion | None = None
    nextSceneId: str | None = None


class GeneratedEpisodeScene(EpisodeScene):
    question: GeneratedRecallQuestion | None = None


class EpisodeScript(BaseModel):
    schemaVersion: Literal["1.0"] = "1.0"
    episodeId: str
    documentId: str
    title: str
    learningObjectives: list[str]
    estimatedMinutes: float = Field(ge=0)
    startSceneId: str
    scenes: list[EpisodeScene] = Field(min_length=1)
    status: Literal["draft", "ready"] = "draft"


class GeneratedEpisode(BaseModel):
    """Model-facing generation shape: scenes plus the refusal channel."""

    scenes: list[GeneratedEpisodeScene] = Field(min_length=1)
    problems: list[str] = []


# Grading data never leaves the server on learner-facing episode reads.
# `feedback` is the structured shape arriving with recall-checkpoints —
# stripping by name keeps the projection to one mechanism. `maxAttempts`
# is dead data under elimination (attempts run until the correct pick).
LEARNER_HIDDEN_QUESTION_FIELDS = frozenset(
    {
        "correctOptionId",
        "correctExplanation",
        "incorrectExplanation",
        "feedback",
        "maxAttempts",
    }
)


def learner_view(script: EpisodeScript) -> dict:
    """Learner-facing episode payload: everything except answer keys and
    grading explanations. Internal reads (inspection, grading) keep the
    full persisted model."""
    data = script.model_dump()
    for scene in data["scenes"]:
        question = scene.get("question")
        if question is None:
            continue
        for field in LEARNER_HIDDEN_QUESTION_FIELDS:
            question.pop(field, None)
        for option in question.get("options", []):
            option.pop("mistakeResponse", None)
    return data


class SemanticViolation(BaseModel):
    check: str
    detail: str


class SemanticVerdict(BaseModel):
    """Flat review-verdict wire shape — the endpoint rejects recursive schemas."""

    verdict: Literal["pass", "fail"]
    violations: list[SemanticViolation] = []


class ValidationReport(BaseModel):
    """Persisted A08 outcome stored on episodes.validation."""

    schema_version: int = 1
    checked_at: str
    deterministic_violations: list[str] = []
    semantic: SemanticVerdict | None = None
    regenerated: bool = False
    bounds: dict[str, int | float] = {}


def _check_refs(
    refs: list[EpisodeSourceRef],
    web_refs: list[WebRef],
    known_chunks: dict[str, tuple[int, int]],
    supplied_web_urls: set[str],
    owner: str,
    document_id: str,
    violations: list[str],
) -> None:
    for ref in refs:
        real = known_chunks.get(ref.chunkId)
        if real is None:
            violations.append(f"{owner}: sourceRef chunkId does not resolve")
        elif ref.documentId != document_id:
            violations.append(f"{owner}: sourceRef document mismatch")
        elif (ref.pageStart, ref.pageEnd) != real:
            violations.append(f"{owner}: sourceRef pages do not match the chunk")
    for web in web_refs:
        if web.url not in supplied_web_urls:
            violations.append(f"{owner}: webRef url not supplied")


def validate_script(
    script: EpisodeScript,
    known_chunks: dict[str, tuple[int, int]],
    known_objective_ids: set[str],
    supplied_web_urls: set[str],
    expected_checkpoints: int = 2,
) -> list[str]:
    """Deterministic structural checks; enum shapes are enforced by schema.

    `known_chunks` maps a real document chunk id to its (page_start, page_end)
    so a cited ref must resolve to a real chunk AND its true page range.
    """
    violations: list[str] = []
    scenes = {scene.sceneId: scene for scene in script.scenes}
    if len(scenes) != len(script.scenes):
        violations.append("Duplicate scene id")
    if script.startSceneId not in scenes:
        violations.append("startSceneId does not resolve to a scene")

    line_ids: list[str] = []
    question_ids: list[str] = []
    for scene in script.scenes:
        if scene.nextSceneId is not None and scene.nextSceneId not in scenes:
            violations.append(f"{scene.sceneId}: nextSceneId does not resolve")
        if scene.kind == "checkpoint" and scene.question is None:
            violations.append(f"{scene.sceneId}: checkpoint requires a question")
        if scene.kind != "checkpoint" and scene.question is not None:
            violations.append(f"{scene.sceneId}: question on a non-checkpoint scene")
        for line in scene.dialogue:
            line_ids.append(line.lineId)
            _check_refs(line.sourceRefs, line.webRefs, known_chunks,
                        supplied_web_urls, line.lineId, script.documentId, violations)
        question = scene.question
        if question is None:
            continue
        question_ids.append(question.questionId)
        for option in question.options:
            if not (option.mistakeResponse or "").strip():
                violations.append(
                    f"{question.questionId}.{option.optionId}: mistakeResponse required"
                )
        if len(question.options) != 3:
            violations.append(
                f"{question.questionId}: expected 3 options, "
                f"found {len(question.options)}"
            )
        if len({option.optionId for option in question.options}) != len(question.options):
            violations.append(f"{question.questionId}: duplicate option id")
        if question.correctOptionId not in {option.optionId for option in question.options}:
            violations.append(f"{question.questionId}: correctOptionId not in options")
        if question.objectiveId not in known_objective_ids:
            violations.append(f"{question.questionId}: objectiveId not in locked objectives")
        _check_refs(question.sourceRefs, question.webRefs, known_chunks,
                    supplied_web_urls, question.questionId, script.documentId, violations)

    if len(line_ids) != len(set(line_ids)):
        violations.append("Duplicate line id")
    if len(question_ids) != len(set(question_ids)):
        violations.append("Duplicate question id")
    checkpoint_count = sum(1 for scene in script.scenes if scene.kind == "checkpoint")
    if checkpoint_count != expected_checkpoints:
        violations.append(
            f"Expected exactly {expected_checkpoints} checkpoints, found {checkpoint_count}"
        )

    reached: set[str] = set()
    queue: deque[str] = deque([script.startSceneId] if script.startSceneId in scenes else [])
    while queue:
        scene_id = queue.popleft()
        if scene_id in reached:
            continue
        reached.add(scene_id)
        nxt = scenes[scene_id].nextSceneId
        if nxt is not None and nxt in scenes:
            queue.append(nxt)
    if not any(scenes[sid].kind == "ending" for sid in reached):
        violations.append("No ending scene is reachable")
    unreachable = set(scenes) - reached
    if unreachable:
        violations.append(f"Unreachable scenes: {sorted(unreachable)}")
    return violations
