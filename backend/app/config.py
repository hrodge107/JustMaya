import sys
from pathlib import Path

from pydantic import SecretStr, ValidationError
from pydantic_settings import BaseSettings, SettingsConfigDict

BACKEND_DIR = Path(__file__).resolve().parents[1]
REPO_ROOT = BACKEND_DIR.parent
DEFAULT_DATA_DIR = BACKEND_DIR / "data"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=REPO_ROOT / ".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    meta_api_key: SecretStr
    meta_base_url: str = "https://api.meta.ai/v1"
    meta_model: str = "muse-spark-1.3-contributor"

    data_dir: Path = DEFAULT_DATA_DIR

    max_upload_bytes: int = 20 * 1024 * 1024
    max_upload_pages: int = 100

    chroma_dir: Path = DEFAULT_DATA_DIR / "chroma"
    # ponytail: 180 BPE tokens stays well under MiniLM-L6's 256-word-piece
    # truncation limit; retune with the real tokenizer if raised past ~200
    rag_chunk_tokens: int = 180
    rag_chunk_overlap: int = 30
    rag_top_k: int = 5

    checkpoint_db_path: Path = DEFAULT_DATA_DIR / "checkpoints.db"
    worker_poll_seconds: float = 2.0
    pipeline_node_max_attempts: int = 3

    # Token governance: caps on total tokens (prompt+completion) per stage and
    # per job; None disables that scope. Per-stage overrides via env JSON, e.g.
    # TOKEN_STAGE_BUDGETS='{"analyze": 200000}'
    token_stage_budget: int | None = 100_000
    token_stage_budgets: dict[str, int] = {}
    token_job_budget: int | None = 300_000

    analysis_thin_chars_per_page: int = 200
    analysis_web_fetch_cap: int = 5
    analysis_web_timeout_seconds: float = 5.0


def load_settings() -> Settings:
    try:
        return Settings()
    except ValidationError as exc:
        missing = sorted(
            {str(loc).upper() for e in exc.errors() for loc in e["loc"] if e["type"] == "missing"}
        )
        sys.stderr.write(
            "Configuration error: missing required environment variable(s): "
            + ", ".join(missing)
            + "\n"
        )
        raise SystemExit(1) from exc
