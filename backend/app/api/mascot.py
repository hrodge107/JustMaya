"""Lobby Talk endpoint — a session-free mirror of the raise-hand contract.

`POST /api/mascot/chat` takes {question, request_id} and returns an
interaction envelope shaped like the tutor's, minus session fields. The
model call stays outside any transaction because there is nothing to commit;
abuse control is a per-IP sliding window plus the shared token budgets.
"""

import time
import uuid
from collections import deque
from datetime import datetime, timezone
from typing import Annotated

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field, StringConstraints

from app.errors import error_body
from app.services.mascot_chat import answer_chat
from app.services.model_provider import MetaProvider, ModelProviderError
from app.services.token_budget import MeteredProvider, TokenBudgetError

router = APIRouter()

QUESTION_MAX_LENGTH = 500


class MascotChatRequest(BaseModel):
    question: Annotated[
        str,
        StringConstraints(
            strip_whitespace=True, min_length=1, max_length=QUESTION_MAX_LENGTH
        ),
    ]
    request_id: str = Field(min_length=1)


# ponytail: in-memory per-IP window — fine for one process; a shared store if
# the app ever runs multiple workers.
_hits: dict[str, deque[float]] = {}


def _rate_limited(ip: str, limit: int, window: float = 60.0) -> bool:
    now = time.monotonic()
    hits = _hits.setdefault(ip, deque())
    while hits and now - hits[0] > window:
        hits.popleft()
    if len(hits) >= limit:
        return True
    hits.append(now)
    return False


@router.post("/api/mascot/chat")
async def mascot_chat_endpoint(body: MascotChatRequest, request: Request):
    settings = request.app.state.settings
    ip = request.client.host if request.client else "unknown"
    if _rate_limited(ip, settings.mascot_rate_limit_per_minute):
        return JSONResponse(
            status_code=429,
            content=error_body(
                "RATE_LIMITED", "Too many questions at once — try again shortly.", True
            ),
        )
    provider = getattr(request.app.state, "mascot_provider", None)
    if provider is None:
        provider = request.app.state.mascot_provider = MeteredProvider(
            MetaProvider(settings),
            settings,
            request.app.state.data_dir,
        )
    try:
        answer = await answer_chat(
            provider=provider,
            question=body.question,
            request_id=body.request_id,
            settings=settings,
        )
    except TokenBudgetError as exc:
        return JSONResponse(status_code=503, content=error_body(exc.code, str(exc)))
    except ModelProviderError as exc:
        return JSONResponse(
            status_code=503,
            content=error_body(exc.code, exc.message, exc.retryable),
        )
    return {
        "interaction": {
            "interactionId": uuid.uuid4().hex,
            "kind": "mascot",
            "userMessage": body.question,
            "answer": "\n".join(answer.lines),
            "lines": answer.lines,
            "createdAt": datetime.now(timezone.utc).isoformat(),
            "requestId": body.request_id,
        }
    }
