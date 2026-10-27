"""Partition extraction into bounded, page-attributed analysis inputs."""

from dataclasses import dataclass

from app.models.concept import Coverage
from app.models.document import ExtractedDocument


@dataclass(frozen=True)
class AnalysisWindow:
    section_id: str | None
    section_title: str | None
    pages: tuple[tuple[int, str], ...]


def analysis_windows(document: ExtractedDocument, max_chars: int = 8000) -> tuple[list[AnalysisWindow], list[Coverage]]:
    if max_chars < 1:
        raise ValueError("max_chars must be positive")
    windows: list[AnalysisWindow] = []
    coverage: list[Coverage] = []
    for page in document.pages:
        sections = [s for s in document.sections if s.page_start <= page.page_number <= s.page_end]
        coverage.append(Coverage(page_number=page.page_number, section_ids=[s.section_id for s in sections],
                                 textless=not bool(page.text.strip()), insufficient=not bool(page.text.strip())))
        # A page can belong to overlapping outline sections. Analyze its text once,
        # while coverage retains every applicable section.
        section = sections[-1] if sections else None
        for offset in range(0, len(page.text), max_chars):
            piece = page.text[offset:offset + max_chars]
            section_id = section.section_id if section else None
            if (windows and windows[-1].section_id == section_id
                    and sum(len(text) for _, text in windows[-1].pages) + len(piece) <= max_chars):
                previous = windows[-1]
                windows[-1] = AnalysisWindow(previous.section_id, previous.section_title,
                                             previous.pages + ((page.page_number, piece),))
            else:
                windows.append(AnalysisWindow(section_id, section.title if section else None,
                                              ((page.page_number, piece),)))
    return windows, coverage
