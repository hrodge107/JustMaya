"""Learner session contract (spec section 7.4) plus declared vocabulary.

Field names are camelCase to match the persisted LearnerSession JSON and the
spec contract — same rule as EpisodeScript mirroring section 7.3. SESSION_*
constants are the single declaration consumed by the schema CHECK, the
controller's transition gate, and serialization.
"""

from typing import Literal

from pydantic import BaseModel, Field

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


class TutorInteraction(BaseModel):
    interactionId: str
    kind: Literal["raise_hand", "discussion"]
    userMessage: str
    answer: str
    sourceRefs: list[EpisodeSourceRef] = []
    createdAt: str


class LearnerSession(BaseModel):
    sessionId: str
    episodeId: str
    mode: Literal[*SESSION_MODES]
    sceneId: str
    dialogueIndex: int = Field(ge=0)
    resumeSnapshot: Position | None = None
    quizAttempts: list[QuizAttempt] = []
    interactions: list[TutorInteraction] = []
    learningNotes: list[str] = []
    version: int = Field(ge=1)
    status: Literal[*SESSION_STATUSES]
    updatedAt: str


class AdvanceRequest(BaseModel):
    request_id: str = Field(min_length=1)
    expected_version: int = Field(ge=1)
