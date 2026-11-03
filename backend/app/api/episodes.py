import re
from pathlib import Path

from fastapi import APIRouter, Request
from fastapi.responses import FileResponse, JSONResponse

from app.errors import error_body
from app.models.episode import learner_view
from app.storage.episodes import read_episode_by_id

router = APIRouter()

_NAME = re.compile(r"^[A-Za-z0-9_-]+\.webp$")


@router.get("/api/episodes/{episode_id}")
def get_episode(episode_id: str, request: Request):
    try:
        return learner_view(read_episode_by_id(request.app.state.data_dir, episode_id))
    except LookupError:
        return JSONResponse(
            status_code=404, content=error_body("NOT_FOUND", "Episode not found.")
        )


@router.get("/api/episodes/{episode_id}/pictures/{name}")
def get_picture(episode_id: str, name: str, request: Request):
    base = (request.app.state.data_dir / "pictures").resolve()
    root = (base / episode_id).resolve()
    path = (root / name).resolve()
    if (not re.fullmatch(r"[A-Za-z0-9_-]+", episode_id) or root.parent != base
            or not _NAME.fullmatch(name) or path.parent != root or not path.is_file()):
        return JSONResponse(
            status_code=404, content=error_body("NOT_FOUND", "Picture not found.")
        )
    return FileResponse(path, media_type="image/webp")
