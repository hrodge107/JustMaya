import math
from collections import Counter
from pathlib import Path

import pymupdf

from app.models.document import DocumentPage, DocumentSection, ExtractedDocument

# ponytail: repeated-line cutoff for header/footer suppression; tune if real
# docs show boilerplate below or real content at/above this fraction
BOILERPLATE_MIN_FRACTION = 0.6


class ExtractionError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


def _normalize(text: str) -> str:
    return "\n".join(
        " ".join(line.split()) for line in text.splitlines() if line.strip()
    )


def extract_document(document_id: str | None, path: Path) -> ExtractedDocument:
    try:
        doc = pymupdf.open(path)
    except Exception as exc:
        raise ExtractionError(
            "EXTRACTION_FAILED", f"Could not open {path.name} as a PDF."
        ) from exc

    with doc:
        doc_id = document_id or path.stem
        pages: list[DocumentPage] = []
        for i, page in enumerate(doc):
            text = _normalize(page.get_text("text"))
            flags = []
            if not text:
                flags.append("no_text")
                if page.get_images(full=True):
                    flags.append("image_only")
            pages.append(
                DocumentPage(
                    document_id=doc_id,
                    page_number=i + 1,
                    text=text,
                    flags=flags,
                    char_count=len(text),
                )
            )
        toc = [(title, page) for _lvl, title, page in doc.get_toc(simple=True) if page > 0]
        page_count = doc.page_count

    text_pages = [p for p in pages if p.text]
    if len(text_pages) >= 3:
        counts: Counter[str] = Counter()
        for p in text_pages:
            counts.update(set(p.text.splitlines()))
        boilerplate = {
            line
            for line, n in counts.items()
            if n >= math.ceil(len(text_pages) * BOILERPLATE_MIN_FRACTION)
        }
        for p in text_pages:
            kept = [line for line in p.text.splitlines() if line not in boilerplate]
            p.text = "\n".join(kept)
            p.char_count = len(p.text)

    sections = [
        DocumentSection(
            section_id=f"sec-{i}",
            title=title,
            page_start=start,
            page_end=(toc[i][1] - 1 if i < len(toc) else page_count),
        )
        for i, (title, start) in enumerate(toc, start=1)
    ]
    for i, section in enumerate(sections[:-1]):
        if section.page_end < section.page_start:
            section.page_end = section.page_start

    return ExtractedDocument(
        document_id=doc_id,
        page_count=page_count,
        pages=pages,
        sections=sections,
        image_only_document=all("no_text" in p.flags for p in pages),
    )
