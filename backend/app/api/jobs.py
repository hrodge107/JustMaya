import sqlite3

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from starlette.concurrency import run_in_threadpool

from app.errors import error_body
from app.models.document import JobStatusResponse
from app.pipeline.jobs import connect_db
from app.pipeline.runner import ELIGIBLE_RUN, run_job

router = APIRouter()


@router.get("/api/jobs/{job_id}")
async def get_job(job_id: str, request: Request) -> JobStatusResponse:
    conn = sqlite3.connect(request.app.state.data_dir / "app.db")
    try:
        row = conn.execute(
            "SELECT job_id, document_id, status, stage, error, execution_state "
            "FROM jobs WHERE job_id = ?",
            (job_id,),
        ).fetchone()
    finally:
        conn.close()

    if row is None:
        return JSONResponse(
            status_code=404, content=error_body("NOT_FOUND", "Job not found.")
        )
    return JobStatusResponse(
        job_id=row[0],
        document_id=row[1],
        status=row[2],
        stage=row[3],
        error=row[4],
        execution_state=row[5],
    )


@router.post("/api/jobs/{job_id}/run")
async def run_job_endpoint(job_id: str, request: Request) -> JobStatusResponse:
    data_dir = request.app.state.data_dir
    conn = connect_db(data_dir)
    try:
        exists = conn.execute(
            "SELECT 1 FROM jobs WHERE job_id = ?", (job_id,)
        ).fetchone()
    finally:
        conn.close()

    if exists is None:
        return JSONResponse(
            status_code=404, content=error_body("NOT_FOUND", "Job not found.")
        )

    result = await run_in_threadpool(
        run_job, job_id, request.app.state.settings, data_dir, ELIGIBLE_RUN
    )
    if not result["claimed"]:
        return JSONResponse(
            status_code=409,
            content=error_body(
                "JOB_NOT_ELIGIBLE",
                "Job is already running or complete; only queued or failed "
                "jobs can be run.",
            ),
        )
    return JobStatusResponse(**result["job"])
