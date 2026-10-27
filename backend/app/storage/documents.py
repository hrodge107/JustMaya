from pathlib import Path

from app.config import DEFAULT_DATA_DIR


def init_storage(data_dir: Path | None = None) -> Path:
    storage_dir = (data_dir or DEFAULT_DATA_DIR) / "storage"
    storage_dir.mkdir(parents=True, exist_ok=True)
    return storage_dir
