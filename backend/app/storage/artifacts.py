"""Stage-artifact persistence — the single owner of the
``storage/{document_id}.{kind}.json`` naming convention, atomic writes,
and typed loads.

Pipeline stages and the inspection endpoint resolve artifact paths and
read artifacts through this module instead of deriving filenames.
Every save writes a temporary file in the storage directory and renames
it into place, so a crash mid-write can never leave a truncated
artifact that a resumed run would consume as valid input. Filenames are
the contract: ``PipelineState`` carries bare names (``extracted_path``,
``inventory_path``) and ``load`` resolves them under the storage dir.
"""

import os
import tempfile
from pathlib import Path
from typing import TypeVar

from pydantic import BaseModel

T = TypeVar("T", bound=BaseModel)


class ArtifactStore:
    """Artifact naming, atomic writes, and typed loads bound to one
    private storage directory."""

    def __init__(self, storage_dir: Path):
        self.storage_dir = storage_dir

    def path(
        self, document_id: str, kind: str, *, episode_id: str | None = None
    ) -> Path:
        if kind == "script":
            if episode_id is None:
                raise ValueError("script artifacts require episode_id")
            name = f"{document_id}.{episode_id}.script.json"
        elif kind in ("extracted", "concepts"):
            name = f"{document_id}.{kind}.json"
        else:
            raise ValueError(f"unknown artifact kind: {kind}")
        return self.storage_dir / name

    def save(
        self,
        document_id: str,
        kind: str,
        payload: str,
        *,
        episode_id: str | None = None,
    ) -> Path:
        artifact = self.path(document_id, kind, episode_id=episode_id)
        temporary = None
        try:
            with tempfile.NamedTemporaryFile(
                mode="w", encoding="utf-8", dir=self.storage_dir, delete=False
            ) as handle:
                temporary = Path(handle.name)
                handle.write(payload)
            os.replace(temporary, artifact)
        finally:
            if temporary is not None:
                temporary.unlink(missing_ok=True)
        return artifact

    def load(self, ref: str | Path, model: type[T]) -> T:
        path = ref if isinstance(ref, Path) else self.storage_dir / ref
        return model.model_validate_json(path.read_text(encoding="utf-8"))
