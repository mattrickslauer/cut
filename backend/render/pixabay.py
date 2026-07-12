"""Pixabay as the render's realism source — real photographed plates when the
scene has a good stock match, and real-footage *tags* as generation context when
it doesn't. Real photos already carry a real lens, grain, bounce light and depth
of field, so a matched plate is the strongest "feels filmed" lever we have; when
no plate fits, the top results' tags ground the text-to-image prompt in what real
footage of that setting actually looks like.

The router (`plate_for`) is the "Both" decision from the design:
    strong real match  -> use the Pixabay photo directly
    weak / no match    -> generate, prompt enriched with Pixabay context tags

Needs a free key in env `PIXABAY_API_KEY`. All network I/O goes through the
module-level `_get_json` / `_get_bytes` so the ranking/routing logic is unit-
testable without the API. Responses and downloaded bytes are cached on disk.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import time
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from typing import Callable, Dict, List, Optional

API_PHOTO = "https://pixabay.com/api/"
API_VIDEO = "https://pixabay.com/api/videos/"
KEY = os.environ.get("PIXABAY_API_KEY", "").strip()
CACHE_DIR = os.environ.get("CUT_PIXABAY_CACHE", os.path.expanduser("~/.cache/cut/pixabay"))

# A photo is a "good enough" real plate above this relevance — below it we'd
# rather generate a scene that actually matches the improv than force bad stock.
MATCH_THRESHOLD = float(os.environ.get("CUT_PIXABAY_THRESHOLD", "0.34"))

_STOP = {"a", "an", "the", "of", "in", "on", "at", "with", "and", "some", "scene",
         "room", "place", "area", "shot", "background", "interior", "exterior"}


def _tokens(s: str) -> set:
    return {w for w in re.split(r"[^a-z0-9]+", (s or "").lower()) if len(w) > 2 and w not in _STOP}


# ---- network seams (monkeypatched in tests) --------------------------------
def _get_json(url: str) -> dict:
    with urllib.request.urlopen(url, timeout=20) as r:
        return json.loads(r.read().decode())


def _get_bytes(url: str) -> bytes:
    with urllib.request.urlopen(url, timeout=45) as r:
        return r.read()


@dataclass
class Candidate:
    kind: str                       # "photo" | "video"
    url: str                        # full-res image url, or video file url
    tags: str = ""
    downloads: int = 0
    likes: int = 0
    width: int = 0
    height: int = 0
    score: float = 0.0              # filled by _rank

    @property
    def landscape(self) -> bool:
        return self.width == 0 or self.width >= self.height


def _quality(c: Candidate) -> float:
    """Popularity as a rough proxy for 'looks good' — log-compressed so a viral
    outlier doesn't dominate relevance. 0..~1."""
    import math
    return min(1.0, math.log10(1 + c.downloads + 3 * c.likes) / 5.0)


def _rank(cands: List[Candidate], query: str) -> List[Candidate]:
    """Relevance (tag/query token overlap) dominates; quality and a landscape
    bonus break ties. Sorted best-first."""
    q = _tokens(query)
    for c in cands:
        t = _tokens(c.tags)
        overlap = len(q & t) / len(q) if q else 0.0        # fraction of query covered
        c.score = 0.7 * overlap + 0.25 * _quality(c) + (0.05 if c.landscape else 0.0)
    return sorted(cands, key=lambda c: c.score, reverse=True)


def _parse_photos(data: dict) -> List[Candidate]:
    out = []
    for h in data.get("hits", []):
        out.append(Candidate(
            kind="photo",
            url=h.get("largeImageURL") or h.get("webformatURL", ""),
            tags=h.get("tags", ""),
            downloads=int(h.get("downloads", 0)),
            likes=int(h.get("likes", 0)),
            width=int(h.get("imageWidth", 0)),
            height=int(h.get("imageHeight", 0)),
        ))
    return [c for c in out if c.url]


def _parse_videos(data: dict) -> List[Candidate]:
    out = []
    for h in data.get("hits", []):
        files = h.get("videos", {})
        f = files.get("large") or files.get("medium") or files.get("small") or {}
        if not f.get("url"):
            continue
        out.append(Candidate(
            kind="video", url=f["url"], tags=h.get("tags", ""),
            downloads=int(h.get("downloads", 0)), likes=int(h.get("likes", 0)),
            width=int(f.get("width", 0)), height=int(f.get("height", 0)),
        ))
    return out


def _cache_path(name: str) -> str:
    return os.path.join(CACHE_DIR, name)


def _cached_json(url: str) -> dict:
    os.makedirs(CACHE_DIR, exist_ok=True)
    p = _cache_path("q_" + hashlib.sha1(url.encode()).hexdigest()[:16] + ".json")
    if os.path.exists(p) and time.time() - os.path.getmtime(p) < 7 * 86400:
        with open(p) as f:
            return json.load(f)
    data = _get_json(url)
    with open(p, "w") as f:
        json.dump(data, f)
    return data


def search(query: str, kind: str = "photo", per_page: int = 20) -> List[Candidate]:
    """Ranked candidates for `query`. Returns [] if no key or no results."""
    if not KEY or not query.strip():
        return []
    base = API_VIDEO if kind == "video" else API_PHOTO
    params = {
        "key": KEY, "q": query.strip(), "per_page": max(3, min(per_page, 200)),
        "safesearch": "true", "orientation": "horizontal",
    }
    if kind != "video":
        params["image_type"] = "photo"
    url = base + "?" + urllib.parse.urlencode(params)
    try:
        data = _cached_json(url)
    except Exception:
        return []
    cands = _parse_videos(data) if kind == "video" else _parse_photos(data)
    return _rank(cands, query)


def context_tags(query: str, limit: int = 6) -> List[str]:
    """Distinct tags from the top real results — generation context to ground a
    text-to-image prompt when we fall back to generating (excludes tokens the
    query already has)."""
    have = _tokens(query)
    seen, out = set(), []
    for c in search(query)[:6]:
        for tag in (t.strip() for t in c.tags.split(",")):
            tl = tag.lower()
            if tag and tl not in seen and tl not in have and len(tl) > 2:
                seen.add(tl)
                out.append(tag)
    return out[:limit]


def download(url: str) -> bytes:
    os.makedirs(CACHE_DIR, exist_ok=True)
    ext = os.path.splitext(urllib.parse.urlparse(url).path)[1] or ".bin"
    p = _cache_path("a_" + hashlib.sha1(url.encode()).hexdigest()[:16] + ext)
    if os.path.exists(p):
        with open(p, "rb") as f:
            return f.read()
    data = _get_bytes(url)
    with open(p, "wb") as f:
        f.write(data)
    return data


@dataclass
class PlateChoice:
    mode: str                       # "real" | "generate"
    image_bytes: Optional[bytes] = None      # set when mode == "real"
    prompt: str = ""                # enriched generation prompt when mode == "generate"
    candidate: Optional[Candidate] = None
    context: List[str] = field(default_factory=list)


def plate_for(query: str, threshold: float = MATCH_THRESHOLD) -> PlateChoice:
    """The 'Both' router. A strong real match returns downloaded photo bytes; a
    weak/no match returns a generation prompt enriched with real-footage tags."""
    best = None
    for c in search(query):
        best = c
        break
    if best and best.score >= threshold and best.kind == "photo":
        try:
            return PlateChoice(mode="real", image_bytes=download(best.url), candidate=best)
        except Exception:
            pass  # download failed -> fall through to generation
    ctx = context_tags(query)
    enriched = query if not ctx else f"{query}, {', '.join(ctx)}"
    return PlateChoice(mode="generate", prompt=enriched, candidate=best, context=ctx)
