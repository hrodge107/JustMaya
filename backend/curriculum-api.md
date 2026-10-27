# Curriculum review API

For local inspection, start the backend (`cd backend; .\.venv\Scripts\python.exe -m uvicorn app.main:app`) and Vite (`npm run dev` from the repository root), then open `/dev/review`. Upload a PDF and either start the worker (`python -m app.pipeline.worker`) or use the tool's Run pipeline button. The page can reopen a job by ID after a reload. It is a temporary developer tool, separate from the eventual learner frontend.

`GET /api/documents/{document_id}/inspection/{stage}` reads saved `extraction`, `index`, or `analysis` output. The index response contains stored chunk IDs, text and metadata. Missing extraction or analysis output returns 404; an empty index has no chunks available. These endpoints return internal source material and are intended for the local development environment.

`GET /api/documents/{document_id}/curriculum` returns the saved roadmap, concept and objective labels, derived uncovered concept IDs, timing estimates, warnings and revision. It never invokes the model. Internal lesson context and source provenance are not returned in this review response.

`PUT /api/documents/{document_id}/curriculum` takes `expected_revision` and an `episodes` array containing every episode's `episode_id`, ordered `concept_ids`, `words_per_minute` and `interaction_minutes`. The response is the updated review representation. A stale revision or confirmed roadmap returns 409; invalid edits return 422.

`POST /api/documents/{document_id}/curriculum/confirm` takes `{"expected_revision": 1}` with the current revision. It freezes episode 1's private lesson context and returns the confirmed roadmap. Repeating confirmation with the same revision is safe. Missing roadmaps return 404.

Defaults are 140 words per minute and two interaction minutes. Minutes equal estimated dialogue words divided by pace plus interaction time. After concept assignments change, the original word estimate is marked stale. It remains provisional and can be confirmed with the warning visible.
