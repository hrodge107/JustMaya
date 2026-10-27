import pytest
from pydantic import ValidationError

from app.config import Settings


def test_missing_api_key_fails(monkeypatch):
    monkeypatch.delenv("META_API_KEY", raising=False)
    with pytest.raises(ValidationError) as exc_info:
        Settings(_env_file=None)
    assert "meta_api_key" in str(exc_info.value)


def test_valid_settings(monkeypatch):
    monkeypatch.setenv("META_API_KEY", "secret-value-123")
    settings = Settings(_env_file=None)
    assert settings.meta_api_key.get_secret_value() == "secret-value-123"
    assert settings.meta_base_url == "https://api.meta.ai/v1"
    assert settings.meta_model == "muse-spark-1.3-contributor"


def test_secret_not_in_repr(monkeypatch):
    monkeypatch.setenv("META_API_KEY", "secret-value-123")
    settings = Settings(_env_file=None)
    assert "secret-value-123" not in repr(settings)
    assert "secret-value-123" not in str(settings)


def test_rag_settings_defaults_and_overrides(monkeypatch):
    monkeypatch.setenv("META_API_KEY", "secret-value-123")
    defaults = Settings(_env_file=None)
    assert defaults.chroma_dir.name == "chroma"
    assert defaults.rag_chunk_tokens == 180
    assert defaults.rag_chunk_overlap == 30
    assert defaults.rag_top_k == 5

    monkeypatch.setenv("RAG_CHUNK_TOKENS", "120")
    monkeypatch.setenv("RAG_TOP_K", "3")
    overridden = Settings(_env_file=None)
    assert overridden.rag_chunk_tokens == 120
    assert overridden.rag_top_k == 3
