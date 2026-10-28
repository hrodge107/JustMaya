"""Pipeline worker: `python -m app.pipeline.worker [--once]`.

On startup, resumes jobs abandoned mid-run by a previous process, then polls
the jobs table for queued work. Single worker is the hackathon scope — the
atomic claim makes a second worker safe but unnecessary.
"""

import argparse
import time

from app.config import load_settings
from app.pipeline.runner import run_job
from app.storage.database import init_db
from app.storage.documents import init_storage
from app.storage.jobs import (
    ELIGIBLE_RECOVERY,
    ELIGIBLE_WORKER,
    connect_db,
    next_queued_job,
    recover_abandoned,
)


def drain(settings, data_dir, *, ctx=None, stages=None) -> None:
    conn = connect_db(data_dir)
    try:
        for job_id in recover_abandoned(conn):
            run_job(job_id, settings, data_dir, eligible=ELIGIBLE_RECOVERY,
                    ctx=ctx, stages=stages)
        while True:
            job_id = next_queued_job(conn)
            if job_id is None:
                return
            run_job(job_id, settings, data_dir, eligible=ELIGIBLE_WORKER,
                    ctx=ctx, stages=stages)
    finally:
        conn.close()


def serve(settings, data_dir) -> None:
    while True:
        drain(settings, data_dir)
        time.sleep(settings.worker_poll_seconds)


def main() -> None:
    parser = argparse.ArgumentParser(description="JustMaya pipeline worker")
    parser.add_argument(
        "--once", action="store_true", help="recover + drain queued jobs, then exit"
    )
    args = parser.parse_args()
    settings = load_settings()
    data_dir = settings.data_dir
    init_db(data_dir)
    init_storage(data_dir)
    if args.once:
        drain(settings, data_dir)
    else:
        serve(settings, data_dir)


if __name__ == "__main__":
    main()
