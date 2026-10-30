"""Capped manual output check for the persona-and-feedback-quality change."""

import asyncio
import json

from app.config import load_settings
from app.models.episode import EpisodeScript
from app.models.session import QuestionRequest
from app.services.episode_generator import _system as episode_system
from app.services.model_provider import MetaProvider
from app.services.session_controller import new_session, raise_hand
from app.services.token_budget import MeteredProvider
from app.services.tutor import answer_question


async def main() -> None:
    settings = load_settings()
    path = next((settings.data_dir / "storage").glob("*.script.json"))
    episode = EpisodeScript.model_validate_json(path.read_text(encoding="utf-8"))
    provider = MetaProvider(settings)
    sample = await provider.generate_structured(
        system=episode_system(),
        user=("Create one instructor dialogue line and one wrong-option response for "
              "this factual lesson excerpt: A Sumerian ziggurat was a sacred place "
              "of the chief god, built of sun-baked bricks; only priests could enter. "
              "Question: Which description fits a ziggurat? Wrong option selected: "
              "a public marketplace open to traders. Output text only in the requested fields."),
        schema={"type": "object", "properties": {
            "dialogue": {"type": "string"}, "wrong_feedback": {"type": "string"}},
            "required": ["dialogue", "wrong_feedback"], "additionalProperties": False},
        max_tokens=5000,
    )
    metered = MeteredProvider(provider, settings, settings.data_dir)

    async def ask(session, question, request_id, parent=None):
        response = await answer_question(
            provider=metered, session=session, episode=episode,
            request=QuestionRequest(question=question, request_id=request_id,
                                    expected_version=session.version,
                                    reply_to_interaction_id=parent),
            settings=settings,
        )
        return response.interaction

    session = raise_hand(new_session(episode))
    first = await ask(session, "What was a ziggurat used for?", "persona-live-1")
    session = session.model_copy(update={"interactions": [first], "version": session.version + 1})
    pushback = await ask(session, "I think you are wrong.", "persona-live-2", first.interactionId)

    session2 = raise_hand(new_session(episode))
    contrary = first.model_copy(update={
        "interactionId": "seed-contrary", "answer": "Everyone could enter a ziggurat.",
        "lines": ["Everyone could enter a ziggurat."],
        "flow": first.flow.model_copy(update={"threadId": session2.tutorThreadId}),
    })
    session2 = session2.model_copy(update={"interactions": [contrary], "version": session2.version + 1})
    correction = await ask(session2, "Page 6 says only priests could enter. Does that correct your claim?",
                           "persona-live-3", contrary.interactionId)

    session3 = raise_hand(new_session(episode))
    outside = await ask(session3, "Who was a king in the Sumerian era?", "persona-live-4")
    output = {"model": settings.meta_model, "episode_sample": sample.data,
              "episode_tokens": sample.usage,
              "tutor": [{"question": q, "answer": i.answer,
                         "grounding": i.groundingStatus,
                         "pages": [r.pageStart for r in i.sourceRefs]}
                        for q, i in (("initial", first), ("no_evidence", pushback),
                                     ("contrary", correction), ("outside", outside))]}
    target = settings.data_dir / "persona_live_evidence.json"
    target.write_text(json.dumps(output, indent=2, ensure_ascii=False), encoding="utf-8")
    print(target)


if __name__ == "__main__":
    asyncio.run(main())
