import sqlite3

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from app.errors import error_body
from app.models.document import JobStatusResponse

router = APIRouter()


@router.get("/api/jobs/{job_id}")
async def get_job(job_id: str, request: Request) -> JobStatusResponse:
    conn = sqlite3.connect(request.app.state.data_dir / "app.db")
    try:
        row = conn.execute(
            "SELECT job_id, document_id, status, stage, error FROM jobs WHERE job_id = ?",
            (job_id,),
        ).fetchone()
    finally:
        conn.close()

    if row is None:
        return JSONResponse(
            status_code=404, content=error_body("NOT_FOUND", "Job not found.")
        )
    return JobStatusResponse(
        job_id=row[0], document_id=row[1], status=row[2], stage=row[3], error=row[4]
    )
