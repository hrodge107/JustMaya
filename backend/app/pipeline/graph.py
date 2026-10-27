"""Pipeline A graph: START -> extract -> index -> analyze -> END.

Errors propagate out of nodes so a failed run leaves a pending checkpoint at
the failed node; retrying the job resumes there instead of re-running
completed work.
"""

from pathlib import Path

from langgraph.checkpoint.base import BaseCheckpointSaver
from langgraph.graph import END, START, StateGraph
from langgraph.types import RetryPolicy

from app.config import Settings
from app.pipeline.nodes import TRANSIENT_ERRORS, make_nodes
from app.pipeline.state import PipelineState

STAGE_NODES = ("extract", "index", "analyze", "plan")


def build_graph(checkpointer: BaseCheckpointSaver, settings: Settings, data_dir: Path):
    nodes = make_nodes(settings, data_dir)
    retry = RetryPolicy(
        max_attempts=settings.pipeline_node_max_attempts,
        retry_on=TRANSIENT_ERRORS,
    )
    builder = StateGraph(PipelineState)
    for name in STAGE_NODES:
        builder.add_node(name, nodes[name], retry_policy=retry)
    builder.add_edge(START, STAGE_NODES[0])
    for prev, nxt in zip(STAGE_NODES, STAGE_NODES[1:]):
        builder.add_edge(prev, nxt)
    builder.add_edge(STAGE_NODES[-1], END)
    return builder.compile(checkpointer=checkpointer)
