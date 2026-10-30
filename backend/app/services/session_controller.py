"""Deterministic learner-session transitions (spec 12.2) — pure, no I/O.

One authoritative transition per accepted event. Persistence, request
deduplication, and version checks live in app/storage/sessions.py; this
module only decides what an accepted event does to a session.
"""

import uuid
from datetime import datetime, timezone

from app.models.episode import EpisodeScript
from app.models.session import (
    MODE_CHECKPOINT,
    MODE_COMPLETED,
    MODE_PLAYING,
    MODE_QUESTION,
    STATUS_ACTIVE,
    STATUS_COMPLETED,
    AnswerRequest,
    LearnerSession,
    CheckpointState,
    Position,
    QuizAttempt,
)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


class InvalidSessionTransition(Exception):
    pass


def new_session(episode: EpisodeScript) -> LearnerSession:
    now = _now()
    return LearnerSession(
        sessionId=uuid.uuid4().hex,
        episodeId=episode.episodeId,
        mode=MODE_PLAYING,
        sceneId=episode.startSceneId,
        dialogueIndex=0,
        version=1,
        status=STATUS_ACTIVE,
        updatedAt=now,
    )


def restore_checkpoint(session: LearnerSession, episode: EpisodeScript) -> LearnerSession:
    """Derive released feedback from saved history, including pre-revamp
    payloads. Completion is the last pick being correct; wrong picks stay
    eliminated. `finalIncorrect` is never served — it may name the answer."""
    if session.mode != MODE_CHECKPOINT:
        return session.model_copy(update={"checkpoint": None})
    scene = next(s for s in episode.scenes if s.sceneId == session.sceneId)
    question = scene.question
    if question is None:
        raise InvalidSessionTransition("Checkpoint has no question.")
    history = [a for a in session.quizAttempts if a.questionId == question.questionId]
    last = history[-1] if history else None
    correct = last.correct if last else None
    completed = correct is True
    feedback = None
    if last:
        if correct:
            feedback = (question.feedback.correct if question.feedback else None) \
                or question.correctExplanation
        else:
            picked = next(
                (o for o in question.options if o.optionId == last.selectedOptionId),
                None,
            )
            feedback = (picked.mistakeResponse if picked else None) \
                or (question.feedback.firstIncorrect if question.feedback else None) \
                or question.incorrectExplanation
    state = CheckpointState(
        questionId=question.questionId, attemptsUsed=len(history),
        isCorrect=correct,
        checkpointCompleted=completed,
        selectedOptionId=last.selectedOptionId if last else None,
        feedback=feedback, correctOptionId=question.correctOptionId if completed else None,
    )
    return session.model_copy(update={"checkpoint": state})


def advance(session: LearnerSession, episode: EpisodeScript) -> LearnerSession:
    """Apply one authoritative dialogue or completed-checkpoint transition."""
    session = restore_checkpoint(session, episode)
    checkpoint_done = session.mode == MODE_CHECKPOINT and session.checkpoint.checkpointCompleted
    if session.mode != MODE_PLAYING and not checkpoint_done:
        raise InvalidSessionTransition(f"Cannot advance while session mode is {session.mode!r}.")
    scenes = {scene.sceneId: scene for scene in episode.scenes}
    scene = scenes[session.sceneId]
    update: dict = {}
    if checkpoint_done or (scene.kind == "dialogue" and session.dialogueIndex + 1 >= len(scene.dialogue)):
        if not scene.nextSceneId:
            raise InvalidSessionTransition("Scene has no next scene.")
        nxt = scenes[scene.nextSceneId]
        update.update(sceneId=nxt.sceneId, dialogueIndex=0,
                      mode=MODE_CHECKPOINT if nxt.kind == "checkpoint" else MODE_PLAYING)
    elif session.dialogueIndex + 1 < len(scene.dialogue):
        update["dialogueIndex"] = session.dialogueIndex + 1
    elif scene.kind == "ending":
        update.update(mode=MODE_COMPLETED, status=STATUS_COMPLETED)
    else:
        raise InvalidSessionTransition("Checkpoint answer required.")
    update.update(version=session.version + 1, updatedAt=_now())
    return restore_checkpoint(session.model_copy(update=update), episode)


def answer(session: LearnerSession, episode: EpisodeScript, request: AnswerRequest) -> LearnerSession:
    if session.mode != MODE_CHECKPOINT:
        raise InvalidSessionTransition("Session is not at a checkpoint.")
    session = restore_checkpoint(session, episode)
    if session.checkpoint.checkpointCompleted:
        raise InvalidSessionTransition("Checkpoint is already complete.")
    scene = next(s for s in episode.scenes if s.sceneId == session.sceneId)
    question = scene.question
    if question.questionId != request.questionId:
        raise ValueError("Question is not the active checkpoint.")
    if request.optionId not in {o.optionId for o in question.options}:
        raise ValueError("Option is not part of the active checkpoint.")
    if request.optionId in {a.selectedOptionId for a in session.quizAttempts
                            if a.questionId == question.questionId}:
        raise ValueError("Option was already attempted.")
    attempts = session.checkpoint.attemptsUsed + 1
    correct = request.optionId == question.correctOptionId
    quiz = QuizAttempt(questionId=question.questionId, selectedOptionId=request.optionId,
                       correct=correct, attemptNumber=attempts, timestamp=_now())
    notes = session.learningNotes
    if attempts == 1 and not correct:
        notes = [*notes, f"Review objective {question.objectiveId}: {question.prompt}"]
    updated = session.model_copy(update={
        "quizAttempts": [*session.quizAttempts, quiz], "learningNotes": notes,
        "version": session.version + 1, "updatedAt": _now(),
    })
    return restore_checkpoint(updated, episode)


def raise_hand(session: LearnerSession) -> LearnerSession:
    """Snapshot the exact position once and enter question mode."""
    if session.mode not in (MODE_PLAYING, MODE_CHECKPOINT):
        raise InvalidSessionTransition(f"Cannot raise hand while session mode is {session.mode!r}.")
    return session.model_copy(update={
        "resumeSnapshot": Position(
            sceneId=session.sceneId,
            dialogueIndex=session.dialogueIndex,
            mode=session.mode,
        ),
        "mode": MODE_QUESTION,
        # Deterministic interrupt identity; resume clears it.
        "tutorThreadId": f"{session.sessionId}:{session.version + 1}",
        "version": session.version + 1,
        "updatedAt": _now(),
    })


def resume(session: LearnerSession, episode: EpisodeScript) -> LearnerSession:
    """Restore the snapshotted position and leave question mode."""
    snap = session.resumeSnapshot
    if session.mode != MODE_QUESTION or snap is None:
        raise InvalidSessionTransition("Session is not in question mode.")
    return restore_checkpoint(session.model_copy(update={
        "sceneId": snap.sceneId,
        "dialogueIndex": snap.dialogueIndex,
        "mode": snap.mode,
        "resumeSnapshot": None,
        "tutorThreadId": None,
        "version": session.version + 1,
        "updatedAt": _now(),
    }), episode)
