"""Run or resume one pipeline job.

Flow: atomic claim -> document processing -> graph invoke (fresh input, or
`invoke(None)` to resume a pending checkpoint) -> terminal execution_state.
Used by the worker, the run endpoint, and abandoned-job recovery alike.
"""

from pathlib import Path

from langgraph.checkpoint.sqlite import SqliteSaver

from app.config import Settings
from app.pipeline.graph import build_graph
from app.storage.documents import set_document_status
from app.storage.jobs import (
    ELIGIBLE_RUN,
    EXECUTION_COMPLETE,
    EXECUTION_PARTIAL,
    EXECUTION_REVIEW,
    admission,
    claim_job,
    complete_job,
    connect_db,
    fail_job,
    finish_job,
    get_job,
    job_pipeline_target,
    needs_generate_resume,
    resolve_outcome,
)


def run_job(
    job_id: str,
    settings: Settings,
    data_dir: Path,
    eligible: tuple[str, ...] = ELIGIBLE_RUN,
) -> dict:
    conn = connect_db(data_dir)
    try:
        current = get_job(conn, job_id)
        claimable = admission(data_dir, current, eligible)
        if claimable is None:
            return {"claimed": False, "job": current}
        # Pre-change drafts park at awaiting_review after generation; they
        # resume into the validate stage via an as_node update below.
        resume_generated = current is not None and needs_generate_resume(
            data_dir, current
        )
        if not claim_job(conn, job_id, claimable):
            return {"claimed": False, "job": get_job(conn, job_id)}
        target = job_pipeline_target(conn, job_id)
        if target is None:
            fail_job(conn, job_id, "Job has no document target.")
            return {"claimed": True, "job": get_job(conn, job_id)}
        document_id, storage_path = target
        set_document_status(conn, document_id, "processing")
    finally:
        conn.close()

    config = {"configurable": {"thread_id": job_id}}
    try:
        with SqliteSaver.from_conn_string(str(settings.checkpoint_db_path)) as saver:
            graph = build_graph(saver, settings, data_dir)
            checkpoint = graph.get_state(config)
            if current and current["execution_state"] == EXECUTION_PARTIAL:
                if checkpoint.next or not checkpoint.values.get("extracted_path"):
                    raise ValueError("Partial checkpoint is missing or incompatible")
                if current["stage"] == "analyze" and not checkpoint.values.get("inventory_path"):
                    raise ValueError("Analysis checkpoint is missing its inventory")
                if current["stage"] == "plan" and not checkpoint.values.get("curriculum_id"):
                    raise ValueError("Planning checkpoint is missing its roadmap")
                graph.update_state(config, {}, as_node=current["stage"])
                checkpoint = graph.get_state(config)
            elif resume_generated:
                graph.update_state(config, {}, as_node="generate")
                checkpoint = graph.get_state(config)
            if checkpoint.next:
                graph.invoke(None, config)
            elif not checkpoint.values.get("curriculum_id"):
                graph.invoke(
                    {
                        "job_id": job_id,
                        "document_id": document_id,
                        "storage_path": storage_path,
                    },
                    config,
                )
    except Exception as exc:
        conn = connect_db(data_dir)
        try:
            fail_job(conn, job_id, str(exc))
            set_document_status(conn, document_id, "failed")
            job = get_job(conn, job_id)
        finally:
            conn.close()
        return {"claimed": True, "job": job, "error": str(exc)}

    conn = connect_db(data_dir)
    try:
        if resolve_outcome(data_dir, document_id) == EXECUTION_COMPLETE:
            complete_job(conn, job_id)
        else:
            finish_job(conn, job_id, EXECUTION_REVIEW)
        job = get_job(conn, job_id)
    finally:
        conn.close()
    return {"claimed": True, "job": job}
