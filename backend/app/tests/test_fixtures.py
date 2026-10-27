import shutil

import pytest

import seed_fixtures


def test_sample_staged(fixtures):
    p = fixtures("PDF_SAMPLE.pdf")
    assert p.is_file()
    assert p.parent == seed_fixtures.FIXTURES_DIR
    assert p.read_bytes()[:4] == b"%PDF"


def test_negative_not_a_pdf(fixtures):
    p = fixtures("not_a_pdf.pdf")
    assert p.is_file()
    assert not p.read_bytes().startswith(b"%PDF")


def test_empty_pdf_fixture(fixtures):
    p = fixtures("empty.pdf")
    assert p.is_file()
    assert p.read_bytes().startswith(b"%PDF")


def test_seed_idempotent(fixtures):
    before = sorted(f.name for f in seed_fixtures.FIXTURES_DIR.iterdir())
    seed_fixtures.seed()
    after = sorted(f.name for f in seed_fixtures.FIXTURES_DIR.iterdir())
    assert before == after


def test_missing_sample_fails(monkeypatch, tmp_path):
    monkeypatch.setattr(seed_fixtures, "SAMPLE_SRC", tmp_path / "gone.pdf")
    with pytest.raises(SystemExit):
        seed_fixtures.seed()
