from app.models.document import DocumentPage, DocumentSection, ExtractedDocument
from app.services.analysis_windows import analysis_windows


def test_windows_cover_pages_sections_and_long_text():
    doc = ExtractedDocument(document_id="d", page_count=4, pages=[
        DocumentPage(document_id="d", page_number=1, text="a" * 9),
        DocumentPage(document_id="d", page_number=2, text="bb"),
        DocumentPage(document_id="d", page_number=3, text=""),
        DocumentPage(document_id="d", page_number=4, text="cc"),
    ], sections=[
        DocumentSection(section_id="s1", title="First", page_start=1, page_end=2),
        DocumentSection(section_id="s2", title="Nested", page_start=2, page_end=2),
    ])
    windows, coverage = analysis_windows(doc, max_chars=4)
    assert all(sum(len(text) for _, text in window.pages) <= 4 for window in windows)
    assert "".join(text for window in windows for page, text in window.pages if page == 1) == "a" * 9
    assert coverage[1].section_ids == ["s1", "s2"]
    assert coverage[2].textless and coverage[2].insufficient
    assert windows[-1].section_id is None and windows[-1].section_title is None


def test_no_outline_keeps_all_text_without_invented_titles():
    doc = ExtractedDocument(document_id="d", page_count=2, pages=[
        DocumentPage(document_id="d", page_number=1, text="one"),
        DocumentPage(document_id="d", page_number=2, text="two"),
    ])
    windows, coverage = analysis_windows(doc, max_chars=8)
    assert windows[0].pages == ((1, "one"), (2, "two"))
    assert windows[0].section_title is None
    assert [c.page_number for c in coverage] == [1, 2]
