from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from app.errors import error_body
from app.models.episode import learner_view
from app.storage.episodes import read_episode_by_id

router = APIRouter()


@router.get("/api/episodes/{episode_id}")
def get_episode(episode_id: str, request: Request):
    try:
        return learner_view(read_episode_by_id(request.app.state.data_dir, episode_id))
    except LookupError:
        return JSONResponse(
            status_code=404, content=error_body("NOT_FOUND", "Episode not found.")
        )
