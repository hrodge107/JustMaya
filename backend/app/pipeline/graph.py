"""Pipeline A graph: START -> extract -> index -> analyze -> plan -> generate -> validate -> END.

Errors propagate out of nodes so a failed run leaves a pending checkpoint at
the failed node; retrying the job resumes there instead of re-running
completed work.
"""

from functools import partial
from pathlib import Path

from langgraph.checkpoint.base import BaseCheckpointSaver
from langgraph.graph import END, START, StateGraph
from langgraph.types import RetryPolicy

from app.config import Settings
from app.pipeline.nodes import STAGES, TRANSIENT_ERRORS
from app.pipeline.stage import Stage, StageContext
from app.pipeline.state import PipelineState

STAGE_NODES = tuple(stage.name for stage in STAGES)


def build_graph(
    checkpointer: BaseCheckpointSaver,
    settings: Settings,
    data_dir: Path,
    *,
    ctx: StageContext | None = None,
    stages: tuple[Stage, ...] | None = None,
):
    ctx = ctx or StageContext(settings, data_dir)
    sequence = stages or STAGES
    retry = RetryPolicy(
        max_attempts=settings.pipeline_node_max_attempts,
        retry_on=TRANSIENT_ERRORS,
    )
    builder = StateGraph(PipelineState)
    for stage in sequence:
        builder.add_node(stage.name, partial(stage.run, ctx), retry_policy=retry)
    builder.add_edge(START, sequence[0].name)
    for prev, nxt in zip(sequence, sequence[1:]):
        builder.add_edge(prev.name, nxt.name)
    builder.add_edge(sequence[-1].name, END)
    return builder.compile(checkpointer=checkpointer)
