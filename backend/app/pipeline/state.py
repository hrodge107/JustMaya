"""Shared graph state for the Pipeline A orchestrator.

Contract rules (stable across future A04-A08 nodes):

- JSON-serializable primitives/collections ONLY. The checkpointer serializes
  state; pydantic models and file handles do not belong here.
- The runner owns the `in` fields and sets them as the initial state.
- Each node returns a PARTIAL update dict for its `out` fields only.
- `total=False` so later features can add fields without breaking existing
  nodes. Node outputs that downstream stages need live in deterministic
  artifacts (files/DB/Chroma keyed by document_id); state carries references
  and counts only.

Field ownership:

    job_id        in   runner - identity; also the LangGraph thread_id
    document_id   in   runner
    storage_path  in   runner - PDF filename inside private storage
    extracted_path out extract - deterministic artifact, storage/{doc}.extracted.json
    page_count    out extract
    chunk_count   out index
    inventory_path out analyze - private document-keyed concept inventory
    curriculum_id out plan - durable roadmap identifier
    error         reserved - future state-carried errors
"""

from typing_extensions import TypedDict


class PipelineState(TypedDict, total=False):
    job_id: str
    document_id: str
    storage_path: str
    extracted_path: str
    page_count: int
    chunk_count: int
    inventory_path: str
    curriculum_id: str
    error: dict
