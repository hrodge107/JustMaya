import os

import pytest

from app.config import Settings
from app.models.document import (
    DocumentPage,
    DocumentSection,
    ExtractedDocument,
    SourcePassage,
)
from app.services.pdf_extractor import extract_document
from app.services.rag_indexer import _token_len, chunk_document, index_document
from app.services.retriever import retrieve
from app.services.vector_store import get_collection

# ONNX-dependent tests download the ~80MB MiniLM model on first run
# (cached afterwards in ~/.cache/chroma); skip unless JUSTMAYA_EMBED=1
EMBED = pytest.mark.skipif(
    os.environ.get("JUSTMAYA_EMBED") != "1",
    reason="downloads the ONNX embedding model on first run; set JUSTMAYA_EMBED=1",
)


def _doc(pages, doc_id="doc-a", sections=None):
    return ExtractedDocument(
        document_id=doc_id,
        page_count=len(pages),
        pages=pages,
        sections=sections or [],
    )


def _settings(tmp_path):
    return Settings(_env_file=None, chroma_dir=tmp_path / "chroma")


def _indexed_chunk_ids(settings, document_id):
    return get_collection(settings).get(where={"document_id": document_id})["ids"]


def test_source_passage_serialization():
    passage = SourcePassage(
        chunk_id="d1-p0004-0",
        text="Cuneiform used wedge instruments.",
        source={
            "chunk_id": "d1-p0004-0",
            "document_id": "d1",
            "page_start": 4,
            "page_end": 4,
            "section_id": "sec-1",
        },
        similarity_score=0.5,
    )
    data = passage.model_dump()
    assert data["source"]["page_start"] == 4
    assert data["source"]["document_id"] == "d1"
    assert data["similarity_score"] == 0.5


def test_chunk_document_metadata_and_sections():
    doc = _doc(
        [
            DocumentPage(
                document_id="doc-a", page_number=1, text="Intro text here.",
            ),
            DocumentPage(
                document_id="doc-a", page_number=2, text="Body text here.",
            ),
        ],
        sections=[DocumentSection(section_id="s-9", title="Body", page_start=2, page_end=2)],
    )
    chunks = chunk_document(doc, chunk_tokens=180, chunk_overlap=30)
    assert [c.page_start for c in chunks] == [1, 2]
    assert chunks[0].chunk_id == "doc-a-p0001-0"
    assert chunks[0].section_id is None
    assert chunks[1].section_id == "s-9"


def test_chunk_document_respects_token_limit():
    long_text = " ".join(f"word{i}" for i in range(400))
    doc = _doc([DocumentPage(document_id="doc-a", page_number=3, text=long_text)])
    chunks = chunk_document(doc, chunk_tokens=60, chunk_overlap=10)
    assert len(chunks) > 1
    for chunk in chunks:
        assert _token_len(chunk.text) <= 60
        assert chunk.page_start == chunk.page_end == 3


def test_chunk_document_skips_textless_pages():
    doc = _doc(
        [
            DocumentPage(document_id="doc-a", page_number=1, text=""),
            DocumentPage(
                document_id="doc-a", page_number=2, text="   ", flags=["no_text"]
            ),
            DocumentPage(document_id="doc-a", page_number=3, text="Real text."),
        ]
    )
    chunks = chunk_document(doc, chunk_tokens=180, chunk_overlap=30)
    assert [c.page_start for c in chunks] == [3]


@EMBED
def test_fixture_questions_retrieve_correct_pages(fixtures, tmp_path):
    settings = _settings(tmp_path)
    extracted = extract_document("sample", fixtures("PDF_SAMPLE.pdf"))
    assert index_document(extracted, settings) > 0

    cases = [
        ("What is cuneiform and what was it written on?", 4, "cuneiform"),
        ("How did the Romans publish news articles?", 15, "gazette"),
        ("Who invented the printing press?", 19, "gutenberg"),
    ]
    for question, page, keyword in cases:
        results = retrieve("sample", question, top_k=5, settings=settings)
        assert results, f"no results for {question!r}"
        assert any(
            p.source.page_start <= page <= p.source.page_end
            and keyword in p.text.lower()
            for p in results
        ), f"expected page {page} for {question!r}, got {[p.source.page_start for p in results]}"
        for p in results:
            assert p.source.document_id == "sample"
            assert p.similarity_score is not None


@EMBED
def test_no_cross_document_leakage(fixtures, tmp_path):
    settings = _settings(tmp_path)
    index_document(
        extract_document("sample", fixtures("PDF_SAMPLE.pdf")), settings
    )
    index_document(
        _doc(
            [
                DocumentPage(
                    document_id="doc-b",
                    page_number=1,
                    text="Quantum zebras migrate across striped savannas every winter solstice.",
                )
            ],
            doc_id="doc-b",
        ),
        settings,
    )
    results = retrieve("sample", "zebra migration", top_k=10, settings=settings)
    assert results
    assert all(p.source.document_id == "sample" for p in results)
    results_b = retrieve("doc-b", "cuneiform", top_k=10, settings=settings)
    assert all(p.source.document_id == "doc-b" for p in results_b)


@EMBED
def test_reindex_is_idempotent(fixtures, tmp_path):
    settings = _settings(tmp_path)
    extracted = extract_document("sample", fixtures("PDF_SAMPLE.pdf"))
    first = index_document(extracted, settings)
    ids_first = _indexed_chunk_ids(settings, "sample")
    second = index_document(extracted, settings)
    ids_second = _indexed_chunk_ids(settings, "sample")
    assert first == second
    assert sorted(ids_first) == sorted(ids_second)
    assert len(ids_second) == second


@EMBED
def test_index_persists_across_clients(fixtures, tmp_path):
    settings = _settings(tmp_path)
    index_document(
        extract_document("sample", fixtures("PDF_SAMPLE.pdf")), settings
    )
    # get_collection opens a fresh PersistentClient against the same dir
    results = retrieve("sample", "cuneiform", top_k=3, settings=settings)
    assert results
    assert all(p.source.document_id == "sample" for p in results)


@EMBED
def test_top_k_bounds_and_unindexed_document(fixtures, tmp_path):
    settings = _settings(tmp_path)
    index_document(
        extract_document("sample", fixtures("PDF_SAMPLE.pdf")), settings
    )
    results = retrieve("sample", "inventions", top_k=3, settings=settings)
    assert 1 <= len(results) <= 3
    scores = [p.similarity_score for p in results]
    assert scores == sorted(scores, reverse=True)
    assert retrieve("never-indexed", "anything", settings=settings) == []
