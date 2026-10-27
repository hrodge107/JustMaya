"""Stage document test fixtures into backend/tests/fixtures/.

Real PDFs (the private sample) are copied from gitignored docs/; only the
seed helper and the tiny synthetic negative under fixtures_src/ are committed.
Run directly (`python backend/scripts/seed_fixtures.py`) or via pytest.
"""

import shutil
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
FIXTURES_DIR = REPO_ROOT / "backend" / "tests" / "fixtures"
SAMPLE_SRC = REPO_ROOT / "docs" / "PDF_SAMPLE.pdf"
NEGATIVE_SRC = (
    REPO_ROOT / "backend" / "app" / "tests" / "fixtures_src" / "not_a_pdf.pdf"
)

SAMPLE_NAME = "PDF_SAMPLE.pdf"
NEGATIVE_NAME = "not_a_pdf.pdf"
EMPTY_NAME = "empty.pdf"

# Minimal valid one-page PDF with no text content.
EMPTY_PDF = (
    b"%PDF-1.4\n"
    b"1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n"
    b"2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n"
    b"3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]>>endobj\n"
    b"trailer<</Root 1 0 R>>\n%%EOF\n"
)


def fixture_path(name: str) -> Path:
    return FIXTURES_DIR / name


def seed() -> Path:
    if not SAMPLE_SRC.is_file():
        raise SystemExit(
            f"Missing private sample: {SAMPLE_SRC}\n"
            "Provide docs/PDF_SAMPLE.pdf (local-only, gitignored) and re-run."
        )
    FIXTURES_DIR.mkdir(parents=True, exist_ok=True)
    for src, name in ((SAMPLE_SRC, SAMPLE_NAME), (NEGATIVE_SRC, NEGATIVE_NAME)):
        dest = FIXTURES_DIR / name
        if not dest.exists():
            shutil.copyfile(src, dest)
    empty = FIXTURES_DIR / EMPTY_NAME
    if not empty.exists():
        empty.write_bytes(EMPTY_PDF)
    sample = FIXTURES_DIR / SAMPLE_NAME
    head = sample.read_bytes()[:5]
    if sample.stat().st_size == 0 or not head.startswith(b"%PDF"):
        raise SystemExit(f"Staged sample {sample} is empty or not a PDF.")
    return FIXTURES_DIR


if __name__ == "__main__":
    try:
        seed()
    except SystemExit as exc:
        sys.exit(str(exc))
    print(f"Fixtures ready at {FIXTURES_DIR}")
