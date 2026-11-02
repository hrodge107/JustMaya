from typing import Annotated

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel, ConfigDict, StringConstraints

from app.errors import error_body
from app.services.speech import SpeechError

router = APIRouter()


class SpeechRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    text: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=4000)]


@router.post("/api/speech")
async def speech(body: SpeechRequest, request: Request):
    try:
        audio = await request.app.state.speech.synthesize(
            body.text, request.client.host if request.client else "unknown",
        )
    except SpeechError as exc:
        return JSONResponse(
            status_code=exc.status, content=error_body(exc.code, str(exc), True),
            headers={"Cache-Control": "no-store"},
        )
    return Response(audio, media_type="audio/mpeg", headers={"Cache-Control": "no-store"})
