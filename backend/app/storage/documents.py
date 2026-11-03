import sqlite3
import hashlib
import uuid
from datetime import datetime, timezone
from pathlib import Path

from app.config import DEFAULT_DATA_DIR
from app.models.document import PhotoPage, PhotoSource
from app.storage.artifacts import ArtifactStore
from app.storage.jobs import enqueue


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


def save_photo_source(storage_dir: Path, document_id: str, photos: list[tuple[str, bytes]]) -> Path:
    source = PhotoSource(pages=[])
    try:
        for number, (filename, data) in enumerate(photos, 1):
            path = storage_dir / f"{document_id}.photo-{number}.jpg"
            source.pages.append(PhotoPage(filename=filename, storage_path=path.name))
            path.write_bytes(data)
        return ArtifactStore(storage_dir).save(document_id, "photos", source.model_dump_json())
    except Exception:
        delete_photo_source(storage_dir, document_id, len(photos))
        raise


def delete_photo_source(storage_dir: Path, document_id: str, count: int) -> None:
    for number in range(1, count + 1):
        (storage_dir / f"{document_id}.photo-{number}.jpg").unlink(missing_ok=True)
    ArtifactStore(storage_dir).path(document_id, "photos").unlink(missing_ok=True)


def create_photo_document(data_dir: Path, photos: list[tuple[str, bytes]], original_bytes: int) -> tuple[str, str]:
    document_id = uuid.uuid4().hex
    storage_dir = data_dir / "storage"
    digest = hashlib.sha256()
    for _, data in photos:
        digest.update(len(data).to_bytes(8, "big"))
        digest.update(data)
    conn = sqlite3.connect(data_dir / "app.db")
    try:
        path = save_photo_source(storage_dir, document_id, photos)
        with conn:
            conn.execute(
                "INSERT INTO documents (document_id, filename, status, page_count, "
                "file_hash, file_size, storage_path, created_at) VALUES (?, ?, 'uploaded', ?, ?, ?, ?, ?)",
                (document_id, photos[0][0] if len(photos) == 1 else f"{photos[0][0]} (+{len(photos) - 1} photos)",
                 len(photos), digest.hexdigest(), original_bytes, path.name, datetime.now(timezone.utc).isoformat()),
            )
            job_id = enqueue(conn, document_id)
    except Exception:
        delete_photo_source(storage_dir, document_id, len(photos))
        raise
    finally:
        conn.close()
    return document_id, job_id


def photo_warnings(storage_dir: Path, document_id: str) -> list[str]:
    path = ArtifactStore(storage_dir).path(document_id, "photos")
    if not path.exists():
        return []
    source = ArtifactStore(storage_dir).load(path, PhotoSource)
    warnings = []
    for number, page in enumerate(source.pages, 1):
        result = page.result
        if result and (result.status != "readable" or result.omissions):
            message = "was unreadable and skipped" if result.status == "unreadable" else "had uncertain text omitted"
            warnings.append(f"Photo {number} ({page.filename}) {message}.")
    return warnings


def set_document_status(
    conn: sqlite3.Connection, document_id: str, status: str
) -> None:
    with conn:
        conn.execute(
            "UPDATE documents SET status = ? WHERE document_id = ?",
            (status, document_id),
        )
