"""Optional, conservative Commons image enrichment for validated episodes."""

import logging
import re
from datetime import datetime, timezone
from html.parser import HTMLParser
from urllib.parse import urlparse

import httpx

from app.models.curriculum import LessonContext
from app.models.document import SourcePassage
from app.models.episode import EpisodeScript, PictureCard, PictureCredit

logger = logging.getLogger(__name__)
_API = "https://commons.wikimedia.org/w/api.php"
_LICENSES = {
    "https://creativecommons.org/publicdomain/zero/1.0/": "CC0 1.0",
    "https://creativecommons.org/licenses/by/4.0/": "CC BY 4.0",
    "https://creativecommons.org/licenses/by/3.0/": "CC BY 3.0",
}


class _Text(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts = []

    def handle_data(self, data):
        self.parts.append(data)


def _plain(value: str) -> str:
    parser = _Text()
    parser.feed(value)
    return " ".join(" ".join(parser.parts).split())[:300]


def _host(url: str, host: str) -> bool:
    try:
        parsed = urlparse(url)
        return parsed.scheme == "https" and parsed.hostname == host and parsed.port in (None, 443) and parsed.username is None and parsed.password is None
    except ValueError:
        return False


def eligible(page: dict, query: str) -> PictureCredit | None:
    title = page.get("title", "")
    if not isinstance(title, str) or query.casefold() not in title.casefold():
        return None
    info = (page.get("imageinfo") or [{}])[0]
    meta = info.get("extmetadata") or {}
    def field(name):
        value = meta.get(name, {}).get("value", "")
        return value if isinstance(value, str) else ""
    license_url = field("LicenseUrl").replace("http://creativecommons.org/", "https://creativecommons.org/")
    license_name = _LICENSES.get(license_url)
    image_url, page_url = info.get("thumburl", ""), info.get("descriptionurl", "")
    if not isinstance(image_url, str) or not isinstance(page_url, str):
        return None
    author = _plain(field("Artist"))
    if (not license_name or not author or not _host(image_url, "upload.wikimedia.org")
            or not _host(page_url, "commons.wikimedia.org")
            or info.get("mime") not in {"image/jpeg", "image/png", "image/webp"}
            or not isinstance(info.get("width"), int) or not isinstance(info.get("height"), int)
            or info["width"] < 400 or info["height"] < 300):
        return None
    return PictureCredit(imageUrl=image_url, filePageUrl=page_url, title=title.removeprefix("File:"),
                         author=author, license=license_name, licenseUrl=license_url,
                         retrievedAt=datetime.now(timezone.utc).isoformat())


async def attach_picture_cards(script: EpisodeScript, lesson: LessonContext, passages: list[SourcePassage]) -> None:
    """Add at most two cards using exact text from a cited PDF passage."""
    pairs = []
    for scene in script.scenes:
        if scene.kind != "dialogue":
            continue
        for concept in lesson.concepts:
            title = concept.title.strip()
            if len(title) < 4 or len(title) > 80 or not re.fullmatch(r"[\w -]+", title, re.UNICODE):
                continue
            for line in scene.dialogue:
                if (title.casefold() in line.text.casefold() and line.sourceRefs
                        and len(line.text) <= 300):
                    for passage in passages:
                        if passage.chunk_id not in {ref.chunkId for ref in line.sourceRefs}:
                            continue
                        sentence = next((part.strip() for part in re.split(r'(?<=[.!?])\s+', passage.text) if title.casefold() in part.casefold() and 30 <= len(part.strip()) <= 250), None)
                        if sentence:
                            refs = [ref for ref in line.sourceRefs if ref.chunkId == passage.chunk_id]
                            pairs.append((scene, title, sentence, refs))
                            break
                    if pairs and pairs[-1][0] is scene:
                        break
            else:
                continue
            break
        if len(pairs) == 2:
            break
    if not pairs:
        return
    try:
        async with httpx.AsyncClient(timeout=5.0, follow_redirects=False, headers={"User-Agent": "MeetMita/1.0 (educational episode picture cards)"}) as client:
            for scene, title, description, refs in pairs:
                response = await client.get(_API, params={"action": "query", "format": "json", "generator": "search", "gsrsearch": title, "gsrnamespace": 6, "gsrlimit": 8, "prop": "imageinfo", "iiprop": "url|size|mime|extmetadata", "iiurlwidth": 640})
                response.raise_for_status()
                pages = response.json().get("query", {}).get("pages", {})
                for page in pages.values():
                    credit = eligible(page, title)
                    if credit:
                        scene.pictureCard = PictureCard(title=title, description=description, sourceRefs=refs, image=credit)
                        break
    except Exception as exc:  # Optional enrichment must never prevent publication.
        logger.info("Optional Commons picture search unavailable: %s", type(exc).__name__)
