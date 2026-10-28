import pytest
from pydantic import BaseModel

from app.models.document import DocumentPage, ExtractedDocument
from app.storage.artifacts import ArtifactStore
from app.storage.documents import init_storage


class _Model(BaseModel):
    n: int


def _store(tmp_path) -> ArtifactStore:
    return ArtifactStore(init_storage(tmp_path))


def test_path_naming_per_kind(tmp_path):
    store = _store(tmp_path)
    assert store.path("d", "extracted") == tmp_path / "storage" / "d.extracted.json"
    assert store.path("d", "concepts") == tmp_path / "storage" / "d.concepts.json"
    assert (
        store.path("d", "script", episode_id="e")
        == tmp_path / "storage" / "d.e.script.json"
    )


def test_script_kind_requires_episode_id(tmp_path):
    with pytest.raises(ValueError):
        _store(tmp_path).path("d", "script")


def test_unknown_kind_rejected(tmp_path):
    with pytest.raises(ValueError, match="unknown artifact kind"):
        _store(tmp_path).path("d", "nope")


def test_save_is_atomic_and_leaves_no_temp_files(tmp_path):
    store = _store(tmp_path)
    artifact = store.save("d", "extracted", '{"a": 1}')
    assert artifact == tmp_path / "storage" / "d.extracted.json"
    assert artifact.read_text(encoding="utf-8") == '{"a": 1}'
    assert list((tmp_path / "storage").iterdir()) == [artifact]


def test_load_by_path_and_bare_name(tmp_path):
    store = _store(tmp_path)
    artifact = store.save("d", "concepts", _Model(n=7).model_dump_json())
    assert store.load(artifact, _Model).n == 7
    assert store.load("d.concepts.json", _Model).n == 7


def test_extracted_document_round_trip_unchanged(tmp_path):
    store = _store(tmp_path)
    document = ExtractedDocument(
        document_id="d",
        page_count=1,
        pages=[DocumentPage(document_id="d", page_number=1, text="source")],
    )
    store.save("d", "extracted", document.model_dump_json())
    assert store.load("d.extracted.json", ExtractedDocument) == document
