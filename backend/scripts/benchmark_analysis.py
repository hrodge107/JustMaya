"""Live analysis comparison on frozen lesson scopes; isolated data in TEMP.

Replays saved 7/18/80-page extraction, inventory and outline twice per config.
Survey is independently validated. Detail uses the original inventory so scope
variance cannot change the workload. Reviews the saved episode against the new
lesson context; does not regenerate or modify production episodes.
"""

import asyncio
import json
import sqlite3
import sys
import tempfile
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.config import load_settings
from app.models.concept import ConceptInventory
from app.models.curriculum import Roadmap
from app.models.document import ExtractedDocument
from app.models.episode import EpisodeScript
from app.services.concept_analyzer import detail_analysis, survey_document
from app.services.curriculum_review import build_lesson_context, detail_scope
from app.services.episode_generator import passages_for_lesson
from app.services.episode_validator import deterministic_check, semantic_review
from app.services.model_provider import MetaProvider
from app.services.rag_indexer import index_document
from app.services.token_budget import MeteredProvider, job_usage
from app.storage.database import init_db


class TimedProvider(MetaProvider):
    async def generate_structured(self, **kwargs):
        started = time.monotonic()
        result = await super().generate_structured(**kwargs)
        print(f"CALL {time.monotonic() - started:.1f}s {result.usage.get('total_tokens', 0)} tokens", flush=True)
        return result


async def run(settings, document, inventory, roadmap, script, base):
    init_db(base)
    provider = MeteredProvider(TimedProvider(settings), settings, base)
    timings = {}
    try:
        start = time.monotonic()
        survey = await survey_document(document, provider, "benchmark", settings=settings, data_dir=base)
        timings["analyze"] = time.monotonic() - start
        start = time.monotonic()
        detail = await detail_analysis(document, roadmap, inventory, detail_scope(roadmap, inventory, settings),
                                       provider, "benchmark", settings=settings, data_dir=base)
        timings["detail"] = time.monotonic() - start
        lesson = build_lesson_context(roadmap, detail, inventory)
        index_document(document, settings)
        passages, chunks = passages_for_lesson(document.document_id, lesson, settings)
        violations = deterministic_check(script, chunks, {o.id for o in lesson.objectives},
            {s.url for s in lesson.supplements}, settings, target_dialogue_words=roadmap.episodes[0].dialogue_words)
        verdict = await semantic_review(script, lesson, passages, provider, "benchmark", settings)
        return {"status": "pass" if not violations and verdict.verdict == "pass" else "failed",
                "timings": timings, "deterministic": violations, "semantic": verdict.model_dump(),
                "survey_concepts": len(survey.concepts), "detail_uncertainty": detail.uncertainty,
                "usage": job_usage(base, "benchmark")}
    except Exception as exc:
        return {"status": "failed", "timings": timings, "error": str(exc),
                "usage": job_usage(base, "benchmark")}


def main():
    original = load_settings()
    root = Path(tempfile.mkdtemp(prefix="mita-analysis-replay-"))
    print(f"RESULTS {root}", flush=True)
    with sqlite3.connect(f"file:{original.data_dir / 'app.db'}?mode=ro", uri=True) as conn:
        rows = conn.execute("SELECT d.document_id,d.page_count,r.payload,e.payload FROM documents d "
                            "JOIN roadmaps r USING(document_id) JOIN episodes e USING(document_id) "
                            "WHERE e.status='ready' ORDER BY d.page_count").fetchall()
    fixtures = {pages: (doc_id, roadmap, script) for doc_id, pages, roadmap, script in rows if pages in (7, 18, 80)}
    if set(fixtures) != {7, 18, 80}:
        raise RuntimeError("Missing saved 7/18/80-page fixture")
    results = []
    for repeat in (1, 2):
        for pages, (doc_id, roadmap_json, script_json) in fixtures.items():
            document = ExtractedDocument.model_validate_json((original.data_dir / "storage" / f"{doc_id}.extracted.json").read_text(encoding="utf-8"))
            inventory = ConceptInventory.model_validate_json((original.data_dir / "storage" / f"{doc_id}.concepts.json").read_text(encoding="utf-8"))
            roadmap = Roadmap.model_validate_json(roadmap_json)
            script = EpisodeScript.model_validate_json(script_json)
            for tuned in ((False, True) if repeat == 1 else (True, False)):
                variant = "tuned" if tuned else "baseline"
                base = root / f"{pages}-{repeat}-{variant}"
                base.mkdir()
                settings = original.model_copy(update={"data_dir": base, "chroma_dir": base / "chroma",
                    "checkpoint_db_path": base / "checkpoints.db",
                    "analysis_detail_max_chars": 6000 if tuned else 1500,
                    "analysis_reasoning_effort": "low" if tuned else None})
                print(f"START {pages}p repeat={repeat} {variant}", flush=True)
                result = asyncio.run(run(settings, document, inventory, roadmap, script, base))
                with sqlite3.connect(base / "app.db") as conn:
                    result["calls"] = dict(conn.execute("SELECT stage, COUNT(*) FROM token_usage GROUP BY stage"))
                result.update(pages=pages, repeat=repeat, variant=variant, data_dir=str(base))
                results.append(result)
                (root / "results.json").write_text(json.dumps(results, indent=2), encoding="utf-8")
                print(f"RESULT {pages}p {repeat} {variant} {result['status']} {result['timings']}", flush=True)
    print(f"COMPLETE {root / 'results.json'}", flush=True)


if __name__ == "__main__":
    main()
