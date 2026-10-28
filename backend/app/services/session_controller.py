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
    STATUS_ACTIVE,
    STATUS_COMPLETED,
    LearnerSession,
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


def advance(session: LearnerSession, episode: EpisodeScript) -> LearnerSession:
    """Apply one advance event (spec 12.2) and return the updated session."""
    if session.mode != MODE_PLAYING:
        raise InvalidSessionTransition(
            f"Cannot advance while session mode is {session.mode!r}."
        )
    scenes = {scene.sceneId: scene for scene in episode.scenes}
    scene = scenes[session.sceneId]
    update: dict = {}
    if session.dialogueIndex + 1 < len(scene.dialogue):
        update["dialogueIndex"] = session.dialogueIndex + 1
    elif scene.kind == "dialogue" and scene.nextSceneId:
        nxt = scenes[scene.nextSceneId]
        update["sceneId"] = nxt.sceneId
        update["dialogueIndex"] = 0
        update["mode"] = MODE_CHECKPOINT if nxt.kind == "checkpoint" else MODE_PLAYING
    elif scene.kind == "ending":
        update["mode"] = MODE_COMPLETED
        update["status"] = STATUS_COMPLETED
    else:
        raise InvalidSessionTransition("Checkpoint answer required.")
    update["version"] = session.version + 1
    update["updatedAt"] = _now()
    return session.model_copy(update=update)
