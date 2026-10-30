"""Learner session contract (spec section 7.4) plus declared vocabulary.

Field names are camelCase to match the persisted LearnerSession JSON and the
spec contract — same rule as EpisodeScript mirroring section 7.3. SESSION_*
constants are the single declaration consumed by the schema CHECK, the
controller's transition gate, and serialization.
"""

from typing import Annotated, Literal

from pydantic import BaseModel, Field, StringConstraints

from app.models.episode import EpisodeSourceRef

MODE_PLAYING = "playing"
MODE_CHECKPOINT = "checkpoint"
MODE_QUESTION = "question"
MODE_COMPLETED = "completed"
MODE_DISCUSSION = "discussion"
MODE_ERROR = "error"
SESSION_MODES = (
    MODE_PLAYING,
    MODE_CHECKPOINT,
    MODE_QUESTION,
    MODE_COMPLETED,
    MODE_DISCUSSION,
    MODE_ERROR,
)

STATUS_ACTIVE = "active"
STATUS_COMPLETED = "completed"
STATUS_ABANDONED = "abandoned"
SESSION_STATUSES = (STATUS_ACTIVE, STATUS_COMPLETED, STATUS_ABANDONED)


class Position(BaseModel):
    sceneId: str
    dialogueIndex: int = Field(ge=0)
    # spec 7.4: Exclude<EpisodeMode, "question" | "error">
    mode: Literal["playing", "checkpoint", "completed", "discussion"]


class QuizAttempt(BaseModel):
    questionId: str
    selectedOptionId: str
    correct: bool
    attemptNumber: int = Field(ge=1)
    timestamp: str


class CheckpointState(BaseModel):
    questionId: str
    # Elimination means picks run until the correct option — no upper bound.
    attemptsUsed: int = Field(ge=0)
    isCorrect: bool | None = None
    checkpointCompleted: bool = False
    selectedOptionId: str | None = None
    feedback: str | None = None
    correctOptionId: str | None = None


HELP_MODES = ("explain", "hint")
TUTOR_MOVES = (
    "explain",
    "clarify",
    "diagnose",
    "hint",
    "foundation",
    "unsupported",
    "resolved",
)
AWAITING_KINDS = ("none", "attempt", "reflection", "clarification")


class TutorFlow(BaseModel):
    """Server-owned dialogue metadata for one tutor turn (additive)."""
    threadId: str
    topicQuestion: str = Field(max_length=500)
    replyToInteractionId: str | None = None
    helpMode: Literal["explain", "hint"]
    move: Literal[*TUTOR_MOVES]
    hintLevel: int | None = Field(default=None, ge=0, le=5)
    reflection: str | None = Field(default=None, max_length=500)
    awaiting: Literal[*AWAITING_KINDS] = "none"


class TutorInteraction(BaseModel):
    interactionId: str
    kind: Literal["raise_hand", "discussion"]
    userMessage: str
    answer: str
    lines: list[str] = []
    sourceRefs: list[EpisodeSourceRef] = []
    createdAt: str
    groundingStatus: Literal["supported", "partial", "unsupported"] | None = None
    requestId: str | None = None
    flow: TutorFlow | None = None


class LearnerSession(BaseModel):
    sessionId: str
    episodeId: str
    mode: Literal[*SESSION_MODES]
    sceneId: str
    dialogueIndex: int = Field(ge=0)
    resumeSnapshot: Position | None = None
    quizAttempts: list[QuizAttempt] = []
    checkpoint: CheckpointState | None = None
    interactions: list[TutorInteraction] = []
    learningNotes: list[str] = []
    tutorThreadId: str | None = None
    version: int = Field(ge=1)
    status: Literal[*SESSION_STATUSES]
    updatedAt: str


class AdvanceRequest(BaseModel):
    request_id: str = Field(min_length=1)
    expected_version: int = Field(ge=1)


class AnswerRequest(BaseModel):
    questionId: str = Field(min_length=1)
    optionId: str = Field(min_length=1)
    request_id: str = Field(min_length=1)
    expected_version: int = Field(ge=1)


QUESTION_MAX_LENGTH = 500
REFLECTION_MAX_LENGTH = 500


class RaiseHandRequest(BaseModel):
    request_id: str = Field(min_length=1)
    expected_version: int = Field(ge=1)


class QuestionRequest(BaseModel):
    question: Annotated[
        str,
        StringConstraints(
            strip_whitespace=True, min_length=1, max_length=QUESTION_MAX_LENGTH
        ),
    ]
    request_id: str = Field(min_length=1)
    expected_version: int = Field(ge=1)
    # Optional dialogue-flow fields; absent means an explanation on a new topic.
    help_mode: Literal["explain", "hint"] = "explain"
    reply_to_interaction_id: str | None = None
    reflection: Annotated[
        str | None,
        StringConstraints(
            strip_whitespace=True,
            min_length=1,
            max_length=REFLECTION_MAX_LENGTH,
        ),
    ] = None


class ResumeRequest(BaseModel):
    request_id: str = Field(min_length=1)
    expected_version: int = Field(ge=1)


def learner_session_view(session: LearnerSession) -> dict:
    """Only a completed checkpoint may serialize the answer identifier."""
    data = session.model_dump()
    if data["checkpoint"] and not data["checkpoint"]["checkpointCompleted"]:
        data["checkpoint"].pop("correctOptionId", None)
    return data
