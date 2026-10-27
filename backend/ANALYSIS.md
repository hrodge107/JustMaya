# Concept analysis operations

The `analyze` stage stores a validated inventory in private storage and reports
`partial_complete`; it does not create an episode. Document text and optional
Wikipedia summaries are untrusted source data. `ANALYSIS_THIN_CHARS_PER_PAGE`
sets the low-density threshold (default 200), `ANALYSIS_WEB_FETCH_CAP` the
per-document lifetime request cap (default 5; 0 disables fetching), and
`ANALYSIS_WEB_TIMEOUT_SECONDS` the request timeout (default 5). Reservations
persist across retries in `data/analysis-fetches.db`. A failed or unavailable
summary leaves the source gap flagged. Model usage is charged to `analyze`.

For an older job that already completed at `index`, explicitly run from
`backend/`:

```powershell
.\.venv\Scripts\python.exe scripts/resume_analysis.py JOB_ID
```

Only an indexing-only `partial_complete` job with its checkpoint is eligible.
The command resumes at analysis; it does not repeat extraction or indexing.
It can spend model tokens and make the bounded web requests described above.
The worker does not automatically requeue these older jobs.
