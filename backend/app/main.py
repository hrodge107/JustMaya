from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException

from app.api.documents import router as documents_router
from app.api.jobs import router as jobs_router
from app.api.curriculum import router as curriculum_router
from app.api.inspection import router as inspection_router
from app.config import load_settings
from app.errors import error_body
from app.storage.database import init_db
from app.storage.documents import init_storage

STATUS_CODES = {404: "NOT_FOUND", 405: "METHOD_NOT_ALLOWED"}


def create_app(data_dir: Path | None = None) -> FastAPI:
    settings = load_settings()

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        base = data_dir or settings.data_dir
        init_db(base)
        init_storage(base)
        app.state.data_dir = base
        yield

    app = FastAPI(title="JustMaya", lifespan=lifespan)
    app.state.settings = settings
    app.include_router(documents_router)
    app.include_router(jobs_router)
    app.include_router(curriculum_router)
    app.include_router(inspection_router)

    @app.exception_handler(HTTPException)
    async def http_error(request: Request, exc: HTTPException) -> JSONResponse:
        code = STATUS_CODES.get(exc.status_code, f"HTTP_{exc.status_code}")
        message = exc.detail if isinstance(exc.detail, str) else "Request failed."
        return JSONResponse(status_code=exc.status_code, content=error_body(code, message))

    @app.exception_handler(RequestValidationError)
    async def validation_error(request: Request, exc: RequestValidationError) -> JSONResponse:
        return JSONResponse(
            status_code=422,
            content=error_body("VALIDATION_ERROR", "Request failed validation."),
        )

    @app.exception_handler(Exception)
    async def unhandled_error(request: Request, exc: Exception) -> JSONResponse:
        return JSONResponse(
            status_code=500,
            content=error_body("INTERNAL_ERROR", "Unexpected server error.", retryable=True),
        )

    @app.get("/health")
    async def health() -> dict:
        return {"status": "ok"}

    return app


app = create_app()
