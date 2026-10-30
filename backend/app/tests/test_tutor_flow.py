"""Dialogue-flow policy — pure derivation and bounds, no I/O.

Covers new topics, anchored inheritance, diagnosis, levels 1-5 (no skips,
no overflow), reflection gating, the one accessible retry, foundation/pause
exits, resolved turns, mode switches, and anchor ownership.
"""

import pytest

from app.models.session import (
    LearnerSession,
    QuestionRequest,
    TutorFlow,
    TutorInteraction,
)
from app.services.session_controller import new_session, raise_hand, resume
from app.services.tutor_flow import (
    active_thread,
    apply_policy,
    plan_turn,
    thread_id_for,
    validate_anchor,
)
from app.tests.test_raise_hand import _script


def _turn(
    tid,
    iid,
    move,
    level=None,
    awaiting="none",
    help_mode="explain",
    msg="m",
    reflection=None,
    topic="topic",
):
    return TutorInteraction(
        interactionId=iid,
        kind="raise_hand",
        userMessage=msg,
        answer="a",
        lines=["a"],
        createdAt="now",
        flow=TutorFlow(
            threadId=tid,
            topicQuestion=topic,
            helpMode=help_mode,
            move=move,
            hintLevel=level,
            reflection=reflection,
            awaiting=awaiting,
        ),
    )


def _session(*turns):
    session = raise_hand(new_session(_script()))
    return session.model_copy(update={"interactions": list(turns)})


def _request(
    help_mode="explain",
    reply=None,
    reflection=None,
    question="q?",
    request_id="r",
):
    return QuestionRequest(
        question=question,
        request_id=request_id,
        expected_version=1,
        help_mode=help_mode,
        reply_to_interaction_id=reply,
        reflection=reflection,
    )


def _policy(session, request, move="explain", engagement="engaged",
            grounding="supported"):
    ctx = plan_turn(session, request)
    return apply_policy(ctx, request, move, engagement, grounding)


# --- threads and anchors ---


def test_raise_assigns_thread_and_resume_clears():
    session = new_session(_script())
    raised = raise_hand(session)
    assert raised.tutorThreadId == f"{session.sessionId}:2"
    resumed = resume(raised, _script())
    assert resumed.tutorThreadId is None
    assert active_thread(resumed) == []


def test_lazy_thread_id_for_legacy_question_session():
    session = new_session(_script()).model_copy(
        update={"mode": "question", "tutorThreadId": None, "version": 7}
    )
    assert thread_id_for(session) == f"{session.sessionId}:7"


def test_active_thread_only_flow_turns_of_live_interrupt():
    session = _session()
    tid = session.tutorThreadId
    legacy = TutorInteraction(
        interactionId="old", kind="raise_hand", userMessage="m",
        answer="a", createdAt="then",
    )
    other = _turn("other-thread", "x", "explain")
    mine = _turn(tid, "i1", "explain")
    session = session.model_copy(
        update={"interactions": [legacy, other, mine]}
    )
    assert [i.interactionId for i in active_thread(session)] == ["i1"]


def test_anchor_must_be_latest_thread_turn():
    session = _session()
    tid = session.tutorThreadId
    session = session.model_copy(update={
        "interactions": [
            _turn(tid, "i1", "explain"),
            _turn(tid, "i2", "explain"),
        ]
    })
    validate_anchor(session, "i2")  # latest passes
    with pytest.raises(ValueError):
        validate_anchor(session, "i1")  # superseded
    with pytest.raises(ValueError):
        validate_anchor(session, "ghost")  # missing
    with pytest.raises(ValueError):
        validate_anchor(session, "other-session-turn")
    validate_anchor(session, None)  # unanchored always fine


def test_anchor_rejected_on_legacy_or_new_interrupt():
    legacy = new_session(_script()).model_copy(
        update={"mode": "question", "tutorThreadId": None}
    )
    with pytest.raises(ValueError):
        validate_anchor(legacy, "i1")
    # A second interrupt does not continue the first thread.
    resumed = resume(_session(_turn("t", "i1", "explain")), _script())
    again = raise_hand(resumed)
    assert again.tutorThreadId != "t"
    with pytest.raises(ValueError):
        validate_anchor(again, "i1")


# --- planning ---


def test_new_explain_topic_uses_question_as_topic():
    session = _session()
    ctx = plan_turn(session, _request(question="why floods?"))
    assert ctx.parent is None
    assert ctx.topic_question == "why floods?"
    assert ctx.help_mode == "explain" and ctx.awaiting == "none"
    flow = _policy(session, _request(question="why floods?"))
    assert (flow.move, flow.awaiting, flow.hintLevel) == ("explain", "none", None)
    assert flow.topicQuestion == "why floods?"
    assert flow.replyToInteractionId is None
    assert flow.threadId == session.tutorThreadId


def test_anchored_explain_inherits_topic_and_parent():
    session = _session()
    tid = session.tutorThreadId
    parent = _turn(tid, "i1", "explain", topic="silt", msg="what is silt?")
    session = session.model_copy(update={"interactions": [parent]})
    request = _request(reply="i1", question="why does it flood?")
    ctx = plan_turn(session, request)
    assert ctx.topic_question == "silt"
    assert ctx.last_learner_message == "what is silt?"
    flow = apply_policy(ctx, request, "explain", "engaged", "supported")
    assert flow.replyToInteractionId == "i1"
    assert flow.topicQuestion == "silt"


def test_clarify_turn_awaits_clarification_then_explains():
    session = _session()
    flow = _policy(session, _request(), move="clarify")
    assert (flow.move, flow.awaiting) == ("clarify", "clarification")
    session = session.model_copy(update={
        "interactions": [
            _turn(session.tutorThreadId, "c1", "clarify",
                  awaiting="clarification")
        ]
    })
    request = _request(reply="c1", question="the flood one")
    ctx = plan_turn(session, request)
    assert ctx.awaiting == "clarification"
    flow = apply_policy(ctx, request, "explain", "engaged", "supported")
    assert (flow.move, flow.awaiting) == ("explain", "none")


# --- hint ladder ---


def test_hint_topic_starts_with_diagnosis():
    session = _session()
    request = _request(help_mode="hint", question="help with the checkpoint")
    flow = _policy(session, request, move="diagnose")
    assert (flow.move, flow.hintLevel, flow.awaiting) == (
        "diagnose", 0, "attempt"
    )


def test_hint_diagnosis_fast_path_when_attempt_supplied():
    session = _session()
    flow = _policy(session, _request(help_mode="hint"), move="hint")
    assert (flow.move, flow.hintLevel, flow.awaiting) == (
        "hint", 1, "reflection"
    )


def _hinted_session(level, tid_tid=None, extra=()):
    session = _session()
    tid = tid_tid or session.tutorThreadId
    turns = [
        _turn(tid, "d0", "diagnose", level=0, awaiting="attempt",
              help_mode="hint"),
        _turn(tid, "h1", "hint", level=1, awaiting="reflection",
              help_mode="hint", reflection="tried X"),
    ]
    for n in range(2, level + 1):
        turns.append(_turn(tid, f"h{n}", "hint", level=n,
                           awaiting="reflection", help_mode="hint",
                           reflection=f"learned {n - 1}"))
    session = session.model_copy(update={"interactions": turns + list(extra)})
    return session


def test_attempt_reply_delivers_level_one():
    session = _session()
    tid = session.tutorThreadId
    session = session.model_copy(update={
        "interactions": [
            _turn(tid, "d0", "diagnose", level=0, awaiting="attempt",
                  help_mode="hint")
        ]
    })
    request = _request(help_mode="hint", reply="d0",
                       question="I tried option B first")
    flow = _policy(session, request, move="hint")
    assert (flow.move, flow.hintLevel, flow.awaiting) == (
        "hint", 1, "reflection"
    )
    assert flow.replyToInteractionId == "d0"


def test_unclear_attempt_report_stays_in_diagnosis():
    session = _session()
    tid = session.tutorThreadId
    session = session.model_copy(update={
        "interactions": [
            _turn(tid, "d0", "diagnose", level=0, awaiting="attempt",
                  help_mode="hint")
        ]
    })
    flow = _policy(
        session,
        _request(help_mode="hint", reply="d0", question="dunno"),
        move="diagnose",
    )
    assert (flow.move, flow.hintLevel, flow.awaiting) == (
        "diagnose", 0, "attempt"
    )


@pytest.mark.parametrize("level", [1, 2, 3, 4])
def test_engaged_reflection_advances_exactly_one_level(level):
    session = _hinted_session(level)
    request = _request(
        help_mode="hint",
        reply=f"h{level}",
        reflection="it points at flooding",
        question="it points at flooding",
    )
    flow = _policy(session, request, move="hint")
    assert (flow.move, flow.hintLevel, flow.awaiting) == (
        "hint", level + 1, "reflection"
    )
    assert flow.reflection == "it points at flooding"


def test_level_five_exhaustion_offers_foundation_not_level_six():
    session = _hinted_session(5)
    request = _request(
        help_mode="hint", reply="h5",
        reflection="the parallel case worked", question="still stuck",
    )
    flow = _policy(session, request, move="hint")
    assert (flow.move, flow.awaiting) == ("foundation", "none")
    assert flow.hintLevel == 5


def test_missing_reflection_repeats_same_level_once():
    session = _hinted_session(2)
    request = _request(
        help_mode="hint", reply="h2", question="next hint please",
        reflection=None,
    )
    flow = _policy(session, request, move="hint", engagement="unclear")
    assert (flow.move, flow.hintLevel, flow.awaiting) == (
        "hint", 2, "reflection"
    )


def test_second_unsuccessful_request_routes_to_foundation():
    session = _session()
    tid = session.tutorThreadId
    turns = [
        _turn(tid, "h1", "hint", level=1, awaiting="reflection",
              help_mode="hint", reflection="tried X"),
        _turn(tid, "h1b", "hint", level=1, awaiting="reflection",
              help_mode="hint"),
    ]
    session = session.model_copy(update={"interactions": turns})
    request = _request(
        help_mode="hint", reply="h1b", question="just tell me",
        reflection=None,
    )
    ctx = plan_turn(session, request)
    assert ctx.unsuccessful == 1
    flow = apply_policy(ctx, request, "hint", "unclear", "supported")
    assert (flow.move, flow.awaiting) == ("foundation", "none")


def test_engagement_field_alone_cannot_advance_without_reflection():
    session = _hinted_session(1)
    request = _request(
        help_mode="hint", reply="h1", question="got it, next",
        reflection=None,
    )
    flow = _policy(session, request, move="hint", engagement="engaged")
    assert flow.hintLevel == 1  # reflection field is the deterministic gate


def test_resolved_report_closes_without_grading():
    session = _hinted_session(3)
    request = _request(
        help_mode="hint", reply="h3", question="that worked, thanks!"
    )
    flow = _policy(session, request, move="resolved",
                   engagement="resolved")
    assert (flow.move, flow.awaiting) == ("resolved", "none")
    assert flow.hintLevel == 3  # level kept as evidence, not a grade


def test_foundation_needed_routes_to_foundation():
    session = _hinted_session(1)
    request = _request(
        help_mode="hint", reply="h1", reflection="I don't know what a city is",
        question="I don't know what a city is",
    )
    flow = _policy(session, request, move="hint",
                   engagement="foundation_needed")
    assert (flow.move, flow.awaiting) == ("foundation", "none")


def test_unsupported_grounding_overrides_progression():
    session = _hinted_session(1)
    request = _request(help_mode="hint", reply="h1",
                       reflection="tried it", question="off doc?")
    flow = _policy(session, request, move="hint", engagement="engaged",
                   grounding="unsupported")
    assert (flow.move, flow.awaiting) == ("unsupported", "none")


def test_explain_mode_coerces_ladder_moves():
    session = _hinted_session(1)
    request = _request(help_mode="explain", reply="h1",
                       question="just explain it")
    flow = _policy(session, request, move="hint", engagement="engaged")
    assert (flow.move, flow.awaiting, flow.hintLevel) == (
        "explain", "none", None
    )


def test_clarify_inside_hint_thread_preserves_level_then_resumes():
    session = _hinted_session(2)
    tid = session.tutorThreadId
    session = session.model_copy(update={
        "interactions": [
            *session.interactions,
            _turn(tid, "c1", "clarify", level=2, awaiting="clarification",
                  help_mode="hint"),
        ]
    })
    request = _request(help_mode="hint", reply="c1", question="the canals one")
    ctx = plan_turn(session, request)
    assert ctx.hint_level == 2
    flow = apply_policy(ctx, request, "hint", "engaged", "supported")
    assert (flow.move, flow.hintLevel, flow.awaiting) == (
        "hint", 2, "reflection"
    )


def test_mode_switch_and_new_topic_reset_progression():
    session = _hinted_session(3)
    # An unanchored send starts a new topic inside the same interrupt.
    request = _request(help_mode="hint", question="different problem")
    ctx = plan_turn(session, request)
    assert ctx.topic_question == "different problem"
    assert ctx.hint_level is None and ctx.awaiting == "none"
    flow = apply_policy(ctx, request, "diagnose", "engaged", "supported")
    # A fresh diagnose turn restarts the ladder at level 0.
    assert (flow.move, flow.hintLevel, flow.awaiting) == (
        "diagnose", 0, "attempt"
    )
    assert flow.topicQuestion == "different problem"


def test_reflection_recorded_not_in_user_message():
    session = _hinted_session(1)
    request = _request(help_mode="hint", reply="h1",
                       reflection="the hint mentioned floods",
                       question="next hint")
    flow = _policy(session, request, move="hint", engagement="engaged")
    assert flow.reflection == "the hint mentioned floods"
