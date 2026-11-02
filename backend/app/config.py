import sys
from pathlib import Path
from typing import Literal

from pydantic import Field, SecretStr, ValidationError, field_validator
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
    meta_image_model: str = "muse-image-1.0"
    model_request_timeout_seconds: float = 180.0

    data_dir: Path = DEFAULT_DATA_DIR

    max_upload_bytes: int = 20 * 1024 * 1024
    max_upload_pages: int = 100
    photo_max_count: int = 5
    photo_max_bytes: int = 10 * 1024 * 1024
    photo_total_bytes: int = 20 * 1024 * 1024
    photo_max_pixels: int = 40_000_000
    photo_long_edge: int = 2048
    photo_normalized_bytes: int = 3 * 1024 * 1024
    photo_input_tokens: int = 8_000
    photo_output_tokens: int = 48_000
    photo_extract_budget: int = 300_000
    photo_job_budget: int = 900_000

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
    token_stage_budget: int | None = 200_000
    token_stage_budgets: dict[str, int] = {}
    token_job_budget: int | None = 600_000

    analysis_thin_chars_per_page: int = 200
    analysis_web_fetch_cap: int = 5
    analysis_web_timeout_seconds: float = 5.0
    # Survey emits slim per-window output, so wider windows stay cheap.
    analysis_survey_max_chars: int = 6000
    analysis_detail_max_chars: int = Field(default=6000, gt=0)
    analysis_reasoning_effort: Literal["minimal", "low", "medium", "high", "xhigh"] | None = "low"

    # Detail pass: confirmed Episode-1 evidence pages + margin, hard-capped —
    # over-cap fails actionable like the other input bounds.
    detail_context_margin_pages: int = 1
    detail_scope_max_pages: int = 30

    roadmap_max_input_tokens: int = 48000
    roadmap_reading_wpm: float = 140.0
    roadmap_interaction_minutes: float = 2.0

    # ponytail: ~60k output cap — reasoning model burns budget before content;
    # escalate to phase-wise generation only if live runs show truncation
    generation_max_tokens: int = 60_000
    generation_max_input_tokens: int = 60_000
    generation_max_passages: int = 24

    # A08 validation bounds: deterministic ceilings on the draft plus sizing
    # for the single semantic review call. The dialogue floor is relative to
    # the confirmed outline's own target, never an absolute duration — a thin
    # locked scope keeps a thin floor.
    validation_max_scenes: int = 24
    validation_max_dialogue_words: int = 2200
    validation_checkpoint_count: int = 2
    validation_max_minutes: float = 15.0
    validation_min_target_fraction: float = 0.8
    validation_max_input_tokens: int = 48_000
    validation_max_tokens: int = 20_000

    # B03 tutor: short answers; reasoning burns budget before content.
    tutor_max_tokens: int = 8_000

    # Lobby mascot chat: shorter turns than the tutor; per-IP window limits
    # unauthenticated spend (token budgets cap the total under job "mascot").
    mascot_max_tokens: int = 4_000
    mascot_rate_limit_per_minute: int = 12

    speech_model_dir: Path = DEFAULT_DATA_DIR / "speech"

    # Episode picture cards: target range fed to the nomination prompt; the
    # max is also the hard cap on generated images per episode.
    picture_card_min: int = 4
    picture_card_max: int = 10

    @field_validator("analysis_reasoning_effort", mode="before")
    @classmethod
    def parse_analysis_reasoning_effort(cls, value):
        return None if value == "null" else value


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
