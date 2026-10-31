import asyncio

import pytest

from app.config import Settings
from app.models.document import SourcePassage, SourceRef
from app.models.episode import EpisodeScript, PictureCard
from app.services.model_provider import ImageResult
from app.services.picture_cards import attach_picture_cards
from app.tests.test_episode_generator import _lesson_context

WEBP = b"RIFF\x00\x00\x00\x00WEBPVP8 fake"


def _script():
    return EpisodeScript.model_validate({
        "episodeId": "ep-1", "documentId": "doc-1", "title": "Lesson",
        "learningObjectives": [], "estimatedMinutes": 1, "startSceneId": "s1",
        "scenes": [
            {"sceneId": "s1", "kind": "dialogue", "dialogue": [
                {"lineId": "l1", "speaker": "mascot",
                 "text": "A ziggurat was a temple platform.", "emotion": "talking",
                 "sourceRefs": [{"chunkId": "c1", "documentId": "doc-1", "pageStart": 2, "pageEnd": 2}]},
                {"lineId": "l2", "speaker": "narrator",
                 "text": "Farmers dug canals.", "emotion": "idle",
                 "sourceRefs": [{"chunkId": "c1", "documentId": "doc-1", "pageStart": 2, "pageEnd": 2}]},
            ]},
            {"sceneId": "s2", "kind": "ending", "dialogue": []},
        ],
    })


def _passages():
    return [SourcePassage(
        chunk_id="c1",
        text="A ziggurat was a temple platform. Farmers dug canals to the river.",
        source=SourceRef(chunk_id="c1", document_id="doc-1", page_start=2, page_end=2),
    )]


def _settings(tmp_path, **overrides):
    return Settings(meta_api_key="t", **overrides)


class Provider:
    """Fake metered-provider shape: structured returns dicts, image returns bytes."""

    def __init__(self, cards=None, image=WEBP, fail_lines=()):
        self.cards = cards if cards is not None else [
            {"sceneId": "s1", "lineId": "l1", "title": "Ziggurat",
             "visual": "a stepped mud-brick temple tower"},
            {"sceneId": "s1", "lineId": "l2", "title": "Irrigation canal",
             "visual": "a hand-dug water channel beside fields"},
        ]
        self.image = image
        self.fail_lines = set(fail_lines)
        self.image_calls = []

    async def generate_structured(self, **kw):
        return {"cards": self.cards}

    async def generate_image(self, **kw):
        self.image_calls.append(kw)
        plan = kw["prompt"]
        for marker in self.fail_lines:
            if marker in plan:
                raise RuntimeError("image backend down")
        return ImageResult(image=self.image)


def _attach(script, provider, tmp_path, **kw):
    asyncio.run(attach_picture_cards(
        script, _lesson_context(), _passages(), provider, "job",
        _settings(tmp_path, **kw), tmp_path,
    ))


def test_nomination_attaches_cards_and_writes_files(tmp_path):
    script = _script()
    provider = Provider()
    _attach(script, provider, tmp_path)
    cards = script.scenes[0].pictureCards
    assert [c.lineId for c in cards] == ["l1", "l2"]
    assert cards[0].title == "Ziggurat"
    assert cards[0].description == "A ziggurat was a temple platform."
    assert cards[0].sourceRefs[0].pageStart == 2
    assert cards[0].image.imageUrl == "/api/episodes/ep-1/pictures/s1-l1.webp"
    assert "muse-image" in cards[0].image.credit
    assert (tmp_path / "pictures" / "ep-1" / "s1-l1.webp").read_bytes() == WEBP
    assert len(provider.image_calls) == 2


def test_invalid_nominations_are_skipped(tmp_path):
    script = _script()
    provider = Provider(cards=[
        {"sceneId": "ghost", "lineId": "l1", "title": "Bad scene", "visual": "x" * 12},
        {"sceneId": "s1", "lineId": "ghost", "title": "Bad line", "visual": "x" * 12},
        {"sceneId": "s1", "lineId": "l1", "title": "ok", "visual": "short"},          # visual too short
        {"sceneId": "s1", "lineId": "l1", "title": "", "visual": "x" * 12},           # blank title
        {"sceneId": "s1", "lineId": "l1", "title": "Ziggurat", "visual": "a stepped mud-brick tower"},
        {"sceneId": "s1", "lineId": "l1", "title": "Duplicate", "visual": "a duplicate line pick"},
        "not-a-dict",
    ])
    _attach(script, provider, tmp_path)
    cards = script.scenes[0].pictureCards
    assert [c.title for c in cards] == ["Ziggurat"]
    assert len(provider.image_calls) == 1


def test_cap_bounds_cards(tmp_path):
    script = _script()
    provider = Provider()
    _attach(script, provider, tmp_path, picture_card_max=1)
    assert len(script.scenes[0].pictureCards) == 1


def test_nomination_failure_leaves_playback_intact(tmp_path):
    script = _script()
    class Offline:
        async def generate_structured(self, **kw):
            raise RuntimeError("offline")
    _attach(script, Offline(), tmp_path)
    assert script.scenes[0].pictureCards == []


def test_image_failure_skips_only_that_card(tmp_path):
    script = _script()
    provider = Provider(fail_lines=["Irrigation canal"])
    _attach(script, provider, tmp_path)
    assert [c.lineId for c in script.scenes[0].pictureCards] == ["l1"]


def test_cards_survive_serialization(tmp_path):
    from app.storage.database import init_db
    from app.storage.episodes import save_episode_draft, read_episode_by_id
    script = _script()
    _attach(script, Provider(), tmp_path)
    init_db(tmp_path)
    save_episode_draft(tmp_path, script, "cur-1")
    restored = read_episode_by_id(tmp_path, "ep-1")
    card = restored.scenes[0].pictureCards[0]
    assert card.lineId == "l1"
    assert card.image.imageUrl.endswith("/s1-l1.webp")
    assert card.description == "A ziggurat was a temple platform."


def test_legacy_picture_card_payload_still_parses():
    script = EpisodeScript.model_validate({
        "episodeId": "ep-1", "documentId": "doc-1", "title": "T",
        "learningObjectives": [], "estimatedMinutes": 1, "startSceneId": "s1",
        "scenes": [{"sceneId": "s1", "kind": "dialogue", "dialogue": [],
                    "pictureCard": {"title": "Ziggurat", "description": "D",
                                    "sourceRefs": [{"chunkId": "c1", "documentId": "doc-1",
                                                    "pageStart": 1, "pageEnd": 1}],
                                    "image": {"imageUrl": "https://upload.wikimedia.org/x.jpg",
                                              "filePageUrl": "https://commons.wikimedia.org/wiki/File:X",
                                              "title": "X", "author": "A", "license": "CC0 1.0",
                                              "licenseUrl": "https://creativecommons.org/publicdomain/zero/1.0/",
                                              "retrievedAt": "2026-11-01", "changes": "None"}}}],
    })
    legacy = script.scenes[0].pictureCard
    assert legacy and legacy.image.imageUrl.startswith("https://")
    assert script.scenes[0].pictureCards == []


def test_get_picture_route_serves_and_blocks_traversal(tmp_path):
    from fastapi.testclient import TestClient
    from app.main import create_app
    folder = tmp_path / "pictures" / "ep-1"
    folder.mkdir(parents=True)
    (folder / "s1-l1.webp").write_bytes(WEBP)
    with TestClient(create_app(data_dir=tmp_path)) as client:
        ok = client.get("/api/episodes/ep-1/pictures/s1-l1.webp")
        assert ok.status_code == 200 and ok.content == WEBP
        assert client.get("/api/episodes/ep-1/pictures/nope.webp").status_code == 404
        bad = client.get("/api/episodes/ep-1/pictures/..%2F..%2Fapp.db")
        assert bad.status_code == 404
