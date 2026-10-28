# Glossary

Load-bearing domain vocabulary. When a term here appears in code, it should
be the declared constant, not a literal.

## Job lifecycle (owner: `backend/app/storage/jobs.py`)

| Term | Meaning |
|------|---------|
| `jobs.status` | What the job is doing, for humans: `queued`, a stage status (`extracting`…`validating` from `STAGE_STATUS`), `ready`, `failed`. CHECK-enforced in the schema; the CHECK is generated from `JOB_STATUSES`. |
| `jobs.stage` | The pipeline node currently or last running: `extract` → `validate` (`STAGE_NODES`). Drives checkpoint resume via `as_node`. |
| `jobs.execution_state` | The lifecycle machine: `queued` → `running` → `awaiting_review` \| `complete` \| `failed`; `partial_complete` for confirmed-draft resumables. Application-enforced (SQLite cannot ALTER a CHECK in). |
| `enqueue` | Job creation — always inside the caller's transaction (upload). |
| `claim` | Atomic `running` transition: a single `UPDATE … WHERE execution_state IN (eligible)` — concurrent claimers can never double-run a job. |
| `admission` | The claim intents a job may be picked up under: `None` = inadmissible; otherwise the `execution_state` set `claim_job` may match. Centralizes the partial-stage gate and the review-resume special case. |
| `can_run` | Serialized `admission(…, ELIGIBLE_RUN)` for the wire — the frontend must never re-derive eligibility. |
| `ELIGIBLE_RUN` / `ELIGIBLE_WORKER` / `ELIGIBLE_RECOVERY` | Claim intents per caller kind: manual/API runs admit `queued` + `failed` + valid `partial_complete`; the worker only picks up `queued`; recovery only re-claims `running`. |
| `release_from_review` | `awaiting_review` → `partial_complete`, run inside `confirm_draft`'s `BEGIN IMMEDIATE` so roadmap confirmation and job release commit atomically. |
| `needs_generate_resume` | An `awaiting_review` job parked at `stage=generate` with a non-ready episode resumes into `validate` (pre-change drafts flow). |
| `resolve_outcome` | Terminal decision after a graph run: `complete` iff a `ready` episode exists, else `awaiting_review`. |

## Documents

| Term | Meaning |
|------|---------|
| `documents.status` | `uploaded` | `processing` | `ready` | `failed`. Owned by `storage/documents.py` (`set_document_status`) — except the deliberate atomic `ready` flip inside episode publication (`storage/episodes.py`). |

## Architecture vocabulary

`module` / `interface` / `implementation` / `depth` / `seam` / `adapter` /
`leverage` / `locality` — the shared design language for architecture reviews
(see the `codebase-design` skill). A *deep* module hides a hard problem behind
a small interface; a *seam* is where an implementation may be swapped.
