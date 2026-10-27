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
