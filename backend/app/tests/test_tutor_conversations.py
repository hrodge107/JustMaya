"""Representative grounded conversations — minimum assistance, useful next
steps, and leakage reviewed against the four required skills.

Each scripted turn runs the real service + policy with a deterministic
provider, so the persisted flow trajectory is reviewed, not the prose.
Rubric findings: assistance stays graduated (levels advance only on
recorded engagement, one accessible retry, then a foundation/pause exit);
every non-terminal turn ends awaiting one concrete learner action; the
only model-side leakage control is the prompt's no-solution/no-key rule
plus withholding grading data — schema cannot prove prose safety.
"""

import pytest

from app.models.session import Position, QuestionRequest
from app.services.session_controller import new_session, raise_hand
from app.services.token_budget import MeteredProvider
from app.services.tutor import answer_question
from app.tests.test_raise_hand import (
    _script,
    _settings,
    _stub_retriever,
    _passages,
    StubProvider,
    _flow_interaction,
    init_db,
)


class ScriptProvider(StubProvider):
    """Returns queued responses in order; records one call per turn."""

    def __init__(self, responses):
        super().__init__(data=responses[0])
        self.responses = list(responses)

    async def generate_structured(self, **kw):
        self.calls.append(kw)
        from app.services.model_provider import StructuredResult
        return StructuredResult(
            data=self.responses.pop(0),
            usage={
                "prompt_tokens": 10,
                "completion_tokens": 5,
                "total_tokens": 15,
            },
        )


def _resp(move="explain", engagement="engaged", grounding="supported",
          lines=("beat",), note="topic",
          relation=None):
    return {
        "lines": list(lines),
        "cited_chunk_ids": ["c1"] if grounding == "supported" else [],
        "grounding_status": grounding,
        "learning_note": note,
        "move": move,
        "engagement": engagement,
        "relation": (
            relation
            if relation is not None
            else ("on_document" if grounding == "supported" else "on_topic")
        ),
    }


def _question_session(mode="playing", scene="s1", index=1):
    session = raise_hand(new_session(_script()).model_copy(
        update={"sceneId": scene, "dialogueIndex": index, "mode": mode}))
    return session


def _ask(session, request, provider, tmp_path, settings):
    """Run one turn through the real service; append the interaction the
    way commit_question would, so the chain is authoritative."""
    async def run():
        return await answer_question(
            provider=provider,
            session=session,
            episode=_script(),
            request=request,
            settings=settings,
            retriever=_stub_retriever(_passages("c1")),
        )
    return run()


@pytest.mark.anyio
async def test_explain_clarify_and_hint_ladder_conversation(tmp_path):
    """A grounded conversation across explain, ambiguity, and every level."""
    init_db(tmp_path)
    settings = _settings()
    provider = MeteredProvider(
        ScriptProvider([
            _resp(move="explain", lines=("Cities grew by rivers.", "More.")),
            _resp(move="clarify", lines=("Which city do you mean?",)),
            _resp(move="explain", lines=("Uruk sat on the Euphrates.",)),
            _resp(move="diagnose", lines=("What have you tried?",)),
            _resp(move="hint", lines=("What feeds a city?",)),
            _resp(move="hint", lines=("Think of a garden hose.",)),
            _resp(move="hint", lines=("Irrigation moves river water.",)),
            _resp(move="hint", lines=("Try listing what fields need.",)),
            _resp(move="hint", lines=("A similar town solved it thus.",)),
            _resp(move="foundation", lines=("Let's shore up farming.",)),
        ]),
        settings, tmp_path)
    session = _question_session()
    tid = session.tutorThreadId
    turns = []

    async def ask(**kw):
        nonlocal session
        request = QuestionRequest(**kw)
        result = await answer_question(
            provider=provider, session=session, episode=_script(),
            request=request, settings=settings,
            retriever=_stub_retriever(_passages("c1")))
        session = session.model_copy(
            update={"interactions": [*session.interactions,
                                    result.interaction]})
        turns.append(result.interaction)
        return result.interaction

    # 1-3: explanation, ambiguous follow-up clarified, clarified answer.
    a = await ask(question="why did cities form near rivers?",
                  request_id="t1", expected_version=2)
    assert (a.flow.move, a.flow.awaiting) == ("explain", "none")
    b = await ask(question="what about that one?",
                  request_id="t2", expected_version=3,
                  reply_to_interaction_id=a.interactionId)
    assert (b.flow.move, b.flow.awaiting) == ("clarify", "clarification")
    c = await ask(question="the biggest one",
                  request_id="t3", expected_version=4,
                  reply_to_interaction_id=b.interactionId)
    assert (c.flow.move, c.flow.awaiting) == ("explain", "none")

    # 4: hint topic opens with diagnosis, not help.
    d = await ask(question="help me with the checkpoint",
                  request_id="t4", expected_version=5, help_mode="hint")
    assert (d.flow.move, d.flow.hintLevel, d.flow.awaiting) == (
        "diagnose", 0, "attempt")

    # 5-9: each reflected level advances exactly once, through level 5.
    parent = d
    for level in range(1, 6):
        turn = await ask(
            question=f"I see, the {level} hint",
            request_id=f"th{level}",
            expected_version=5 + level,
            help_mode="hint",
            reply_to_interaction_id=parent.interactionId,
            reflection=f"reflection on level {level}",
        )
        assert (turn.flow.move, turn.flow.hintLevel,
                turn.flow.awaiting) == ("hint", level, "reflection"), level
        parent = turn

    # 10: still stuck after the deepest hint -> foundation/pause, not L6.
    out = await ask(
        question="still stuck", request_id="th6", expected_version=11,
        help_mode="hint", reply_to_interaction_id=parent.interactionId,
        reflection="tried everything",
    )
    assert (out.flow.move, out.flow.hintLevel, out.flow.awaiting) == (
        "foundation", 5, "none")

    # Every turn stayed in the live thread; each anchored turn names its
    # parent and the new-topic hint request anchors to nothing.
    assert all(t.flow.threadId == tid for t in turns)
    assert all(
        t.flow.replyToInteractionId == turns[i - 1].interactionId
        for i, t in enumerate(turns)
        if i > 0 and i != 3
    )
    assert turns[3].flow.replyToInteractionId is None
    # Diagnosis reset the topic; the hint run kept the new topic.
    assert turns[3].flow.topicQuestion == "help me with the checkpoint"


@pytest.mark.anyio
async def test_unfinished_checkpoint_hint_never_gets_level_skip(tmp_path):
    """Checkpoint help: policy bounds stop level skips and exits cleanly."""
    init_db(tmp_path)
    settings = _settings()
    provider = MeteredProvider(
        ScriptProvider([
            _resp(move="diagnose", lines=("What did you try?",)),
            _resp(move="hint", lines=("Level one.",)),
            _resp(move="hint", lines=("Level two.",)),
            _resp(move="hint", lines=("Engagement, accessibly?",)),
            _resp(move="foundation", lines=("Foundation or pause.",)),
        ]),
        settings, tmp_path)
    session = _question_session(mode="checkpoint", scene="s2", index=0)
    turns = []

    async def ask(**kw):
        nonlocal session
        request = QuestionRequest(**kw)
        result = await answer_question(
            provider=provider, session=session, episode=_script(),
            request=request, settings=settings,
            retriever=_stub_retriever(_passages("c1")))
        session = session.model_copy(
            update={"interactions": [*session.interactions,
                                    result.interaction]})
        turns.append(result.interaction)
        return result.interaction

    d = await ask(question="hint for this?", request_id="c1",
                  expected_version=2, help_mode="hint")
    h1 = await ask(question="I picked B", request_id="c2",
                   expected_version=3, help_mode="hint",
                   reply_to_interaction_id=d.interactionId)
    h2 = await ask(question="tried again", request_id="c3",
                   expected_version=4, help_mode="hint",
                   reply_to_interaction_id=h1.interactionId,
                   reflection="B was wrong")
    # Missing reflection: one accessible same-level retry...
    again = await ask(question="another", request_id="c4",
                      expected_version=5, help_mode="hint",
                      reply_to_interaction_id=h2.interactionId)
    assert (again.flow.move, again.flow.hintLevel) == ("hint", 2)
    # ...then the exit instead of a compulsory loop.
    out = await ask(question="just the answer", request_id="c5",
                    expected_version=6, help_mode="hint",
                    reply_to_interaction_id=again.interactionId)
    assert (out.flow.move, out.flow.awaiting) == ("foundation", "none")

    # Every prompt carried the no-solution / no-checkpoint-key rule and the
    # checkpoint lesson context stayed label-only.
    scripted = provider._provider
    for call in scripted.calls:
        assert "never identify the correct option" in call["system"]
        assert "correctOptionId" not in call["user"]
        assert "Options shown to the learner: A, B" in call["user"]
    assert len(scripted.calls) == 5
