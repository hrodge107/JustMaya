"""Explicitly advance a pre-analysis partial job without repeating completed stages."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.config import load_settings
from app.pipeline.jobs import EXECUTION_PARTIAL
from app.pipeline.runner import run_job


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("Usage: python scripts/resume_analysis.py JOB_ID")
    settings = load_settings()
    result = run_job(sys.argv[1], settings, settings.data_dir, eligible=(EXECUTION_PARTIAL,))
    if not result["claimed"]:
        raise SystemExit("Job is not an eligible indexing-only partial job")
    if result.get("error"):
        raise SystemExit(result["error"])
    print("Analysis finished:", result["job"]["execution_state"])
