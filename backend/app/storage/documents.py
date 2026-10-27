from pathlib import Path

from app.config import DEFAULT_DATA_DIR


def init_storage(data_dir: Path | None = None) -> Path:
    storage_dir = (data_dir or DEFAULT_DATA_DIR) / "storage"
    storage_dir.mkdir(parents=True, exist_ok=True)
    return storage_dir


def save_document_file(storage_dir: Path, document_id: str, data: bytes) -> Path:
    path = storage_dir / f"{document_id}.pdf"
    path.write_bytes(data)
    return path


def resolve_document_path(storage_dir: Path, storage_path: str) -> Path:
    return storage_dir / Path(storage_path).name
