"""Optional AI-illustrated note cards for validated episodes.

One nomination call picks card-worthy cited lines; deterministic checks then
resolve each pick to a real dialogue line with real sourceRefs, pull a verbatim
description sentence from the cited passages, and generate one muse-image
illustration per card. Images persist under data_dir/pictures/<episode_id>/ and
are served by the episodes API. Every failure skips only that card — enrichment
never blocks publication.
"""

import asyncio
import json
import logging
import re
from pathlib import Path

from app.config import Settings
from app.models.curriculum import LessonContext
from app.models.document import SourcePassage
from app.models.episode import EpisodeScript, PictureCard, PictureImage

logger = logging.getLogger(__name__)

STAGE = "pictures"
_CREDIT = "AI-generated illustration (muse-image)"

# One shared art direction so every card reads as the same hand. Text is banned
# outright — image models render it garbled, and the card carries its own title.
STYLE = (
    "Flat storybook educational illustration in one consistent lesson-card "
    "identity: matte cream paper background, ink navy linework, muted sage mint "
    "and warm terracotta accents, subtle paper grain, soft diffused light, one "
    "centered subject with generous empty margins, calm museum-plate clarity. "
    "No text, letters, numbers, captions, labels, borders, frames, watermarks, "
    "or realistic human faces."
)

_SCHEMA = {
    "type": "object",
    "properties": {
        "cards": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "sceneId": {"type": "string"},
                    "lineId": {"type": "string"},
                    "title": {"type": "string"},
                    "visual": {"type": "string"},
                },
                "required": ["sceneId", "lineId", "title", "visual"],
                "additionalProperties": False,
            },
        }
    },
    "required": ["cards"],
    "additionalProperties": False,
}


def _slug(value: str) -> str:
    return re.sub(r"[^A-Za-z0-9_-]", "_", value)[:80]


def _description(cited: list[SourcePassage], title: str, visual: str) -> str | None:
    """Best verbatim sentence from the cited passages for the card detail."""
    keys = {
        w for w in re.findall(r"[a-z0-9]+", f"{title} {visual}".lower())
        if len(w) > 3
    }
    best, best_score = None, 0
    for passage in cited:
        for part in re.split(r"(?<=[.!?])\s+", passage.text):
            sentence = " ".join(part.split())
            if not 30 <= len(sentence) <= 250:
                continue
            score = len(keys & set(re.findall(r"[a-z0-9]+", sentence.lower())))
            if score > best_score:
                best, best_score = sentence, score
    if best is not None:
        return best
    for passage in cited:
        text = " ".join(passage.text.split())
        if len(text) < 30:
            continue
        if len(text) > 250:
            cut = text[:250].rsplit(" ", 1)[0]
            text = cut if len(cut) >= 30 else text[:250]
        return text
    return None


async def _nominate(script, lesson, provider, job_id, settings) -> list:
    lines = []
    for scene in script.scenes:
        if scene.kind != "dialogue":
            continue
        items = [
            {"lineId": line.lineId, "text": line.text}
            for line in scene.dialogue
            if line.sourceRefs
        ]
        if items:
            lines.append({"sceneId": scene.sceneId, "lines": items})
    if not lines:
        return []
    system = (
        "You are the art director for an educational visual novel lesson. "
        "Choose the dialogue lines where a picture card would most help the "
        "learner form a mental image. Rules: pick only lines listed in <lines>; "
        "spread picks across scenes; prefer concrete subjects (places, objects, "
        "tools, maps, scenes of daily life) over abstract ideas; each pick gets "
        "a short card title and one concrete drawable subject for the "
        "illustrator (a thing or scene to paint, never a written caption). "
        f"Return {settings.picture_card_min} to {settings.picture_card_max} "
        "cards, fewer only when the material is too abstract. "
        "Never invent scene or line ids."
    )
    user = (
        "<lines>"
        + json.dumps(lines, ensure_ascii=False)
        + "</lines><concepts>"
        + json.dumps([c.title for c in lesson.concepts][:40], ensure_ascii=False)
        + "</concepts>"
    )
    result = await provider.generate_structured(
        job_id=job_id, stage=STAGE, system=system, user=user, schema=_SCHEMA,
        max_tokens=8_000, preflight=True, cache_key="picture-card-nominate-v1",
    )
    cards = result.get("cards")
    return cards if isinstance(cards, list) else []


async def attach_picture_cards(
    script: EpisodeScript,
    lesson: LessonContext,
    passages: list[SourcePassage],
    provider,
    job_id: str,
    settings: Settings,
    data_dir: Path,
) -> None:
    """Nominate, verify, render and attach up to `picture_card_max` cards."""
    try:
        items = await _nominate(script, lesson, provider, job_id, settings)
    except Exception as exc:  # Optional enrichment must never prevent publication.
        logger.info("Optional picture nomination unavailable: %s", type(exc).__name__)
        return

    # The model nominates; code decides — every pick must resolve to a real
    # dialogue line with real sourceRefs, and its description comes verbatim
    # from the cited passages.
    plans = []
    seen = set()
    for item in items:
        if len(plans) == settings.picture_card_max or not isinstance(item, dict):
            continue
        scene = next(
            (s for s in script.scenes
             if s.kind == "dialogue" and s.sceneId == item.get("sceneId")),
            None,
        )
        if scene is None:
            continue
        line = next((l for l in scene.dialogue if l.lineId == item.get("lineId")), None)
        if line is None or not line.sourceRefs or (scene.sceneId, line.lineId) in seen:
            continue
        title = str(item.get("title") or "").strip()
        visual = str(item.get("visual") or "").strip()
        if not (4 <= len(title) <= 80 and 10 <= len(visual) <= 400):
            continue
        cited = [p for p in passages if p.chunk_id in {r.chunkId for r in line.sourceRefs}]
        description = _description(cited, title, visual)
        if description is None:
            continue
        seen.add((scene.sceneId, line.lineId))
        plans.append((scene, line, title, visual, description))
    if not plans:
        return

    async def render(plan) -> PictureCard:
        scene, line, title, visual, description = plan
        result = await provider.generate_image(
            job_id=job_id, stage=STAGE,
            prompt=f"{STYLE}\n\nSubject: {visual}\nCard topic: {title}",
            user=job_id,
        )
        name = f"{_slug(scene.sceneId)}-{_slug(line.lineId)}.webp"
        path = data_dir / "pictures" / script.episodeId / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(result.image)
        return PictureCard(
            title=title, description=description, sourceRefs=list(line.sourceRefs),
            lineId=line.lineId,
            image=PictureImage(
                imageUrl=f"/api/episodes/{script.episodeId}/pictures/{name}",
                credit=_CREDIT, alt=title,
            ),
        )

    cards = await asyncio.gather(*(render(p) for p in plans), return_exceptions=True)
    for plan, card in zip(plans, cards):
        if isinstance(card, BaseException):
            logger.info("Optional picture render failed: %s", type(card).__name__)
            continue
        plan[0].pictureCards.append(card)
    for scene in script.scenes:
        if scene.pictureCards:
            order = {line.lineId: i for i, line in enumerate(scene.dialogue)}
            scene.pictureCards.sort(key=lambda c: order.get(c.lineId, 0))
