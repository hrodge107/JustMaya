import pymupdf
import pytest

from app.models.document import DocumentPage, DocumentSection, ExtractedDocument
from app.services.pdf_extractor import ExtractionError, _normalize, extract_document


def test_models_serialize():
    page = DocumentPage(
        document_id="d", page_number=1, text="t", flags=["no_text"], char_count=1
    )
    assert page.model_dump() == {
        "document_id": "d",
        "page_number": 1,
        "text": "t",
        "flags": ["no_text"],
        "char_count": 1,
    }
    section = DocumentSection(section_id="s1", title="Intro", page_start=1, page_end=2)
    result = ExtractedDocument(
        document_id="d", page_count=2, pages=[page], sections=[section]
    )
    dumped = result.model_dump()
    assert dumped["image_only_document"] is False
    assert dumped["pages"][0]["page_number"] == 1


def test_sample_extracts_page_attributed(fixtures):
    path = fixtures("PDF_SAMPLE.pdf")
    result = extract_document("doc-1", path)

    assert result.page_count == len(result.pages)
    assert [p.page_number for p in result.pages] == list(
        range(1, result.page_count + 1)
    )
    assert all(p.document_id == "doc-1" for p in result.pages)

    src = pymupdf.open(path)
    for page_no in (1, result.page_count):
        expected = _normalize(src[page_no - 1].get_text("text"))
        actual = result.pages[page_no - 1].text
        assert actual.splitlines()[:5] == expected.splitlines()[:5]


def test_empty_pdf_flagged(fixtures):
    result = extract_document("e", fixtures("empty.pdf"))
    assert result.page_count == 1
    assert "no_text" in result.pages[0].flags
    assert result.image_only_document is True


def test_non_pdf_raises(fixtures):
    with pytest.raises(ExtractionError) as exc:
        extract_document("x", fixtures("not_a_pdf.pdf"))
    assert exc.value.code == "EXTRACTION_FAILED"


def test_boilerplate_suppressed(tmp_path):
    doc = pymupdf.open()
    for i in range(5):
        page = doc.new_page()
        page.insert_text((72, 50), "CONFIDENTIAL HEADER")
        page.insert_text((72, 700), "page footer line")
        page.insert_text((72, 72), f"unique body {i}")
    path = tmp_path / "boiler.pdf"
    doc.save(path)

    result = extract_document("b", path)
    for p in result.pages:
        assert "CONFIDENTIAL HEADER" not in p.text
        assert "page footer line" not in p.text
        assert any("unique body" in line for line in p.text.splitlines())


def test_normalization_collapses_whitespace():
    assert _normalize("  a   b \n\n c\td  ") == "a b\nc d"


def test_sections_from_toc(tmp_path):
    doc = pymupdf.open()
    doc.new_page().insert_text((72, 72), "intro page")
    doc.new_page().insert_text((72, 72), "body page")
    doc.new_page().insert_text((72, 72), "tail page")
    doc.set_toc([[1, "Intro", 1], [1, "Body", 2]])
    path = tmp_path / "sections.pdf"
    doc.save(path)

    result = extract_document("s", path)
    assert [(s.title, s.page_start, s.page_end) for s in result.sections] == [
        ("Intro", 1, 1),
        ("Body", 2, 3),
    ]


def test_no_toc_yields_empty_sections(tmp_path):
    doc = pymupdf.open()
    doc.new_page().insert_text((72, 72), "no structure")
    path = tmp_path / "plain.pdf"
    doc.save(path)

    result = extract_document("s", path)
    assert result.sections == []
