import asyncio
from app.models.episode import EpisodeScript
from app.services.picture_cards import eligible, attach_picture_cards
from app.tests.test_episode_generator import _lesson_context


def candidate():
    return {"title": "File:Ziggurat at Ur.jpg", "imageinfo": [{"thumburl": "https://upload.wikimedia.org/wikipedia/commons/a/aa/file.jpg", "descriptionurl": "https://commons.wikimedia.org/wiki/File:Ziggurat_at_Ur.jpg", "mime": "image/jpeg", "width": 1000, "height": 700, "extmetadata": {"LicenseUrl": {"value": "https://creativecommons.org/publicdomain/zero/1.0/"}, "Artist": {"value": "<b>Example author</b>"}}}]}


def test_rights_and_host_validation():
    page = candidate()
    credit = eligible(page, "Ziggurat")
    assert credit and credit.author == "Example author" and credit.license == "CC0 1.0"
    page["imageinfo"][0]["extmetadata"]["LicenseUrl"]["value"] = "https://creativecommons.org/licenses/by-sa/4.0/"
    assert eligible(page, "Ziggurat") is None
    page = candidate()
    page["imageinfo"][0]["extmetadata"]["LicenseUrl"]["value"] = "https://creativecommons.org/licenses/by/4.0/"
    assert eligible(page, "Ziggurat") is None
    page = candidate()
    page["imageinfo"][0]["extmetadata"]["Artist"]["value"] = ""
    assert eligible(page, "Ziggurat") is None
    page = candidate()
    page["imageinfo"][0]["thumburl"] = "https://upload.wikimedia.org.evil.test/image.jpg"
    assert eligible(page, "Ziggurat") is None
    assert eligible(candidate(), "pyramid") is None


def test_cards_survive_serialization_and_provider_failure(monkeypatch, tmp_path):
    import app.services.picture_cards as cards
    lesson = _lesson_context()
    lesson.concepts[0].title = "Ziggurat"
    script = EpisodeScript.model_validate({"episodeId": "ep-1", "documentId": "doc-1", "title": "Lesson", "learningObjectives": [], "estimatedMinutes": 1, "startSceneId": "s1", "scenes": [{"sceneId": "s1", "kind": "dialogue", "dialogue": [{"lineId": "l1", "speaker": "mascot", "text": "A ziggurat was a temple platform.", "emotion": "talking", "sourceRefs": [{"chunkId": "c1", "documentId": "doc-1", "pageStart": 2, "pageEnd": 2}]}]}]})
    class Response:
        def raise_for_status(self): pass
        def json(self): return {"query": {"pages": {"1": candidate()}}}
    class Client:
        def __init__(self, **kwargs): pass
        async def __aenter__(self): return self
        async def __aexit__(self, *args): pass
        async def get(self, *args, **kwargs): return Response()
    monkeypatch.setattr(cards.httpx, "AsyncClient", Client)
    from app.models.document import SourcePassage, SourceRef
    passages = [SourcePassage(chunk_id="c1", text="A ziggurat was a temple platform.", source=SourceRef(chunk_id="c1", document_id="doc-1", page_start=2, page_end=2))]
    class Provider:
        async def generate_structured(self, **kwargs): return {"index": 0}
    asyncio.run(attach_picture_cards(script, lesson, passages, Provider(), "job"))
    from app.storage.database import init_db
    from app.storage.episodes import save_episode_draft, read_episode_by_id
    init_db(tmp_path)
    save_episode_draft(tmp_path, script, "cur-1")
    restored = read_episode_by_id(tmp_path, "ep-1")
    assert restored.scenes[0].pictureCard.sourceRefs[0].pageStart == 2
    assert restored.scenes[0].pictureCard.image.author == "Example author"
    script.scenes[0].pictureCard = None
    class Abstain:
        async def generate_structured(self, **kwargs): return {"index": -1}
    asyncio.run(attach_picture_cards(script, lesson, passages, Abstain(), "job"))
    assert script.scenes[0].pictureCard is None
    async def fail(*args, **kwargs): raise RuntimeError("offline")
    monkeypatch.setattr(Client, "get", fail)
    asyncio.run(attach_picture_cards(script, lesson, passages, Provider(), "job"))
    assert script.scenes[0].pictureCard is None
