"""Bounded Wikipedia summaries, with durable per-document request reservations."""

import json
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import quote

import httpx

from app.models.concept import WebSupplement


def reserve_fetch(data_dir: Path, document_id: str, cap: int) -> bool:
    if cap <= 0:
        return False
    data_dir.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(data_dir / "analysis-fetches.db", timeout=10)
    try:
        with conn:
            conn.execute("CREATE TABLE IF NOT EXISTS fetches (document_id TEXT PRIMARY KEY, count INTEGER NOT NULL)")
            conn.execute("BEGIN IMMEDIATE")
            row = conn.execute("SELECT count FROM fetches WHERE document_id = ?", (document_id,)).fetchone()
            if row and row[0] >= cap:
                return False
            conn.execute("INSERT INTO fetches VALUES (?, 1) ON CONFLICT(document_id) DO UPDATE SET count = count + 1", (document_id,))
            return True
    finally:
        conn.close()


def valid_title(title: str) -> bool:
    return bool(title.strip()) and len(title) <= 200 and not any(ord(c) < 32 for c in title) and "://" not in title and "/" not in title and "\\" not in title


async def fetch_summary(data_dir: Path, document_id: str, title: str, page_numbers: list[int],
                        cap: int, timeout: float, transport=None) -> WebSupplement | None:
    if not valid_title(title) or not reserve_fetch(data_dir, document_id, cap):
        return None
    url = "https://en.wikipedia.org/api/rest_v1/page/summary/" + quote(title.strip(), safe="")
    try:
        async with httpx.AsyncClient(timeout=timeout, transport=transport, follow_redirects=False,
                                     headers={"User-Agent": "MeetMita/1.0 educational analysis"}) as client:
            async with client.stream("GET", url) as response:
                if response.status_code != 200:
                    return None
                body = bytearray()
                async for chunk in response.aiter_bytes():
                    body.extend(chunk)
                    if len(body) > 100_000:
                        return None
        payload = json.loads(body)
        if not isinstance(payload, dict) or payload.get("type") != "standard":
            return None
        summary, article_title = payload.get("extract"), payload.get("title")
        if not isinstance(summary, str) or not summary.strip() or not isinstance(article_title, str) or not article_title.strip():
            return None
        return WebSupplement(title=article_title, url="https://en.wikipedia.org/wiki/" + quote(article_title.replace(" ", "_"), safe=""),
                             retrieved_at=datetime.now(timezone.utc).isoformat(), summary=summary, page_numbers=page_numbers)
    except (httpx.HTTPError, ValueError, UnicodeDecodeError):
        return None
