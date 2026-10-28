from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from starlette.concurrency import run_in_threadpool

from app.errors import error_body
from app.models.document import JobStatusResponse
from app.pipeline.runner import run_job
from app.services.token_budget import job_usage
from app.storage.jobs import ELIGIBLE_RUN, can_run, connect_db, get_job

router = APIRouter()


@router.get("/api/jobs/{job_id}")
async def get_job_status(job_id: str, request: Request) -> JobStatusResponse:
    data_dir = request.app.state.data_dir
    conn = connect_db(data_dir)
    try:
        job = get_job(conn, job_id)
    finally:
        conn.close()

    if job is None:
        return JSONResponse(
            status_code=404, content=error_body("NOT_FOUND", "Job not found.")
        )
    job["token_usage"] = job_usage(data_dir, job_id)
    job["can_run"] = can_run(data_dir, job)
    return JobStatusResponse(**job)


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
        run_job, job_id, request.app.state.settings, data_dir, ELIGIBLE_RUN,
        ctx=getattr(request.app.state, "stage_ctx", None),
    )
    if not result["claimed"]:
        return JSONResponse(
            status_code=409,
            content=error_body(
                "JOB_NOT_ELIGIBLE",
                "Job is not eligible to run; it may be running, awaiting review, or complete.",
            ),
        )
    job = result["job"]
    job["token_usage"] = job_usage(data_dir, job_id)
    job["can_run"] = can_run(data_dir, job)
    return JobStatusResponse(**job)
