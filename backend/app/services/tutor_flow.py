"""Pure tutor dialogue-flow policy — thread state, anchors, moves, levels.

Authoritative progression (hint levels, awaiting state, unsuccessful
streaks) derives from persisted flow metadata only; the structured model
call supplies constrained move/engagement observations, never levels,
identity, or lesson position. No I/O and no provider imports.
"""

from typing import NamedTuple

from app.models.session import (
    LearnerSession,
    QuestionRequest,
    TutorFlow,
    TutorInteraction,
)

ENGAGEMENTS = ("engaged", "unclear", "resolved", "foundation_needed")

_HINT_NAMES = {
    1: "a conceptual question pointing at the principle without naming it",
    2: "a familiar analogy to something the learner already knows",
    3: "a reminder naming the relevant principle, still asking them to apply it",
    4: "a procedural nudge giving the direction, not the execution",
    5: "a parallel worked example with different surface content but the "
    "same structure — never this task's solution",
}


class TurnContext(NamedTuple):
    """Everything the service needs for one submitted turn."""

    thread_id: str
    parent: TutorInteraction | None
    topic_question: str
    last_learner_message: str | None
    help_mode: str
    awaiting: str
    hint_level: int | None
    unsuccessful: int
    directive: str


def thread_id_for(session: LearnerSession) -> str:
    """Deterministic interrupt identity; the lazy value a legacy stored
    question-mode session receives inside its next committed question."""
    return session.tutorThreadId or f"{session.sessionId}:{session.version}"


def active_thread(session: LearnerSession) -> list[TutorInteraction]:
    """Raise-hand interactions belonging to the live interrupt, in order."""
    if not session.tutorThreadId:
        return []
    return [
        i
        for i in session.interactions
        if i.kind == "raise_hand"
        and i.flow is not None
        and i.flow.threadId == session.tutorThreadId
    ]


def validate_anchor(session: LearnerSession, reply_to: str | None) -> None:
    """A continuation must name the latest turn of the active thread."""
    if reply_to is None:
        return
    thread = active_thread(session)
    if not thread or thread[-1].interactionId != reply_to:
        raise ValueError(
            "Reply anchor is not the latest exchange in this conversation."
        )


def _unsuccessful(thread: list[TutorInteraction], level: int | None) -> int:
    """Consecutive requests that already arrived without engagement at this
    level: every same-level awaiting-reflection hint turn after the first is
    one rejected engagement request, independent of prompt history bounds."""
    trailing = 0
    for turn in reversed(thread):
        flow = turn.flow
        if (
            flow is not None
            and flow.move == "hint"
            and flow.hintLevel == level
            and flow.awaiting == "reflection"
        ):
            trailing += 1
        else:
            break
    return max(0, trailing - 1)


def plan_turn(session: LearnerSession, request: QuestionRequest) -> TurnContext:
    """Resolve the request against persisted dialogue state (pre-spend)."""
    validate_anchor(session, request.reply_to_interaction_id)
    thread = active_thread(session)
    # A null reply starts a new topic inside the same interrupt thread —
    # progression only continues through an explicit anchor.
    parent = thread[-1] if (thread and request.reply_to_interaction_id) else None
    flow = parent.flow if parent else None
    awaiting = flow.awaiting if flow else "none"
    level = flow.hintLevel if flow else None
    unsuccessful = (
        _unsuccessful(thread, level)
        if flow and flow.move == "hint" and awaiting == "reflection"
        else 0
    )
    return TurnContext(
        thread_id=thread_id_for(session),
        parent=parent,
        topic_question=flow.topicQuestion if flow else request.question,
        last_learner_message=parent.userMessage if parent else None,
        help_mode=request.help_mode,
        awaiting=awaiting,
        hint_level=level,
        unsuccessful=unsuccessful,
        directive=_directive(request.help_mode, awaiting, level, unsuccessful),
    )


def _directive(
    help_mode: str, awaiting: str, level: int | None, unsuccessful: int
) -> str:
    """The instruction this turn's single model call is steered by."""
    if help_mode == "explain":
        return (
            "Explain the learner's question from the passages. If its target "
            "stays ambiguous after weighing the thread and lesson context, "
            "ask exactly one clarifying question (move=clarify) instead of "
            "guessing."
        )
    if awaiting == "attempt":
        return (
            "Their message answers your diagnosis. If prerequisites are "
            "missing (engagement=foundation_needed) offer foundation work or "
            "a pause (move=foundation); otherwise give level 1: "
            f"{_HINT_NAMES[1]} (move=hint). If their report is still unclear, "
            "ask only for the missing piece (move=diagnose)."
        )
    if awaiting == "reflection" and level is not None:
        if level >= 5:
            return (
                "They are at the deepest hint. Whether or not they engaged, "
                "offer foundation work or a pause (move=foundation) — never "
                "the full solution. If they report solving it, close warmly "
                "(engagement=resolved, move=resolved)."
            )
        miss = (
            "ask once for what the hint told them, in an accessible form "
            "(move=hint at the same level)"
            if unsuccessful == 0
            else "offer foundation work or a pause (move=foundation) — do "
            "not loop on reflection"
        )
        return (
            f"They owe a reflection on the level {level} hint. If it engages "
            f"(engagement=engaged), give level {level + 1}: "
            f"{_HINT_NAMES[level + 1]} (move=hint). If it does not engage "
            f"(engagement=unclear), {miss}. If they report solving it, close "
            "warmly (engagement=resolved, move=resolved)."
        )
    if awaiting == "clarification":
        resume = (
            f"continue the hint ladder at level {level}: {_HINT_NAMES[level]}"
            if level
            else "run the diagnosis"
        )
        return (
            "Their message answers your clarifying question. With the target "
            f"now resolved, {resume}."
        )
    return (
        "Start the hint ladder: diagnose first — ask what they tried and "
        "what kind of help they need, asking only for what is missing "
        "(move=diagnose). If their message already supplies both, give "
        f"level 1: {_HINT_NAMES[1]} (move=hint)."
    )


def apply_policy(
    ctx: TurnContext,
    request: QuestionRequest,
    observed_move: str | None,
    engagement: str | None,
    grounding: str,
) -> TutorFlow:
    """Bound the model's observations into authoritative flow metadata."""
    move, awaiting, level = _decide(
        ctx, request, observed_move, engagement, grounding
    )
    return TutorFlow(
        threadId=ctx.thread_id,
        topicQuestion=ctx.topic_question[:500],
        replyToInteractionId=(
            ctx.parent.interactionId if ctx.parent else None
        ),
        helpMode=ctx.help_mode,
        move=move,
        hintLevel=level,
        reflection=request.reflection,
        awaiting=awaiting,
    )


def _decide(
    ctx: TurnContext,
    request: QuestionRequest,
    observed_move: str | None,
    engagement: str | None,
    grounding: str,
) -> tuple[str, str, int | None]:
    level = ctx.hint_level if ctx.help_mode == "hint" else None
    if engagement == "resolved" or observed_move == "resolved":
        return "resolved", "none", level
    if grounding == "unsupported" or observed_move == "unsupported":
        return "unsupported", "none", level
    if engagement == "foundation_needed" or observed_move == "foundation":
        return "foundation", "none", level
    if observed_move == "clarify":
        return "clarify", "clarification", level
    if ctx.help_mode == "explain":
        return "explain", "none", None
    if ctx.awaiting == "attempt":
        if observed_move == "diagnose":
            return "diagnose", "attempt", 0
        return "hint", "reflection", 1
    if ctx.awaiting == "reflection" and ctx.hint_level is not None:
        engaged = bool(request.reflection) and engagement == "engaged"
        if engaged:
            if ctx.hint_level >= 5:
                return "foundation", "none", ctx.hint_level
            return "hint", "reflection", ctx.hint_level + 1
        if ctx.unsuccessful + 1 >= 2:
            return "foundation", "none", ctx.hint_level
        return "hint", "reflection", ctx.hint_level
    if ctx.awaiting == "clarification":
        if ctx.hint_level:
            return "hint", "reflection", ctx.hint_level
        return "diagnose", "attempt", 0
    if observed_move == "hint":
        return "hint", "reflection", 1
    return "diagnose", "attempt", 0
