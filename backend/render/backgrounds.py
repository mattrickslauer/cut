"""Resolve a shot's background spec to an RGB float image [0,1].

Spec forms (EDL `background` field):
  {"file": "envs/bridge.png"}     local still (pre-generated — the cheap path)
  {"color": [r, g, b]}            solid plate (0..1 or 0..255)
  {"prompt": "spaceship bridge"}  realism-routed still (pixabay.py "Both"): a
                                  matched real Pixabay photo when one fits, else a
                                  generated still (prompt enriched with real-
                                  footage tags) from the perception service's
                                  /background endpoint (env BG_SERVICE_URL)
  {"pixabay": "rainy alley"}      force a real Pixabay photo plate (no generation)
  None                            neutral dark plate

Set env CUT_BG_SOURCE=generate to bypass Pixabay and always text-to-image.

Keeping backgrounds as pre-generated stills (parallax supplies the motion) is the
whole feasibility argument (research §6) — per-frame diffusion is NOT real-time.
Fetched/generated stills are cached on disk by prompt hash.
"""
from __future__ import annotations

import hashlib
import io
import os
import urllib.parse
import urllib.request
from typing import Any, Dict, Optional

import cv2
import numpy as np

from . import pixabay

BG_SERVICE_URL = os.environ.get("BG_SERVICE_URL", "").rstrip("/")
CACHE_DIR = os.environ.get("CUT_BG_CACHE", os.path.expanduser("~/.cache/cut/backgrounds"))
BG_SOURCE = os.environ.get("CUT_BG_SOURCE", "auto").lower()   # auto (pixabay+gen) | generate


def _to01(img_u8: np.ndarray) -> np.ndarray:
    return img_u8.astype(np.float32) / 255.0


def _decode(data: bytes) -> np.ndarray:
    arr = np.frombuffer(data, np.uint8)
    bgr = cv2.imdecode(arr, cv2.IMREAD_COLOR)
    if bgr is None:
        raise ValueError("could not decode background image bytes")
    return _to01(cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB))


def _solid(color, w: int, h: int) -> np.ndarray:
    c = np.array(color, np.float32)
    if c.max() > 1.0:
        c = c / 255.0
    return np.ones((h, w, 3), np.float32) * c[:3]


def _generate(prompt: str) -> np.ndarray:
    """Text-to-image still via the perception service's /background endpoint,
    cached on disk by prompt hash."""
    if not BG_SERVICE_URL:
        raise RuntimeError("background prompt given but BG_SERVICE_URL is not set")
    os.makedirs(CACHE_DIR, exist_ok=True)
    key = hashlib.sha1(prompt.encode()).hexdigest()[:16]
    cached = os.path.join(CACHE_DIR, key + ".png")
    if os.path.exists(cached):
        with open(cached, "rb") as f:
            return _decode(f.read())
    url = f"{BG_SERVICE_URL}/background?prompt=" + urllib.parse.quote(prompt)
    with urllib.request.urlopen(url, timeout=90) as r:
        data = r.read()
    with open(cached, "wb") as f:
        f.write(data)
    return _decode(data)


def _fetch_prompt(prompt: str) -> np.ndarray:
    """The realism router: a matched real Pixabay photo when one fits, else a
    generated still whose prompt is enriched with real-footage context tags.
    Env CUT_BG_SOURCE=generate skips Pixabay entirely."""
    if BG_SOURCE == "generate":
        return _generate(prompt)
    choice = pixabay.plate_for(prompt)
    if choice.mode == "real" and choice.image_bytes:
        return _decode(choice.image_bytes)          # real photographed plate
    return _generate(choice.prompt or prompt)       # generation, grounded in Pixabay tags


def _pixabay_plate(query: str) -> np.ndarray:
    """Force a real Pixabay photo plate ({"pixabay": ...}); fall back to
    generation only if no real match is found."""
    for c in pixabay.search(query):
        if c.kind == "photo":
            try:
                return _decode(pixabay.download(c.url))
            except Exception:
                break
    return _generate(query)


def resolve(spec: Optional[Dict[str, Any]], w: int, h: int) -> np.ndarray:
    """Return an RGB float [0,1] background sized at least (h, w). Callers
    (camera) may further oversize; here we cover-fit to (w, h)."""
    if not spec:
        return _solid([0.05, 0.06, 0.08], w, h)
    if "file" in spec:
        bgr = cv2.imread(spec["file"], cv2.IMREAD_COLOR)
        if bgr is None:
            raise FileNotFoundError(f"background file not found: {spec['file']}")
        img = _to01(cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB))
    elif "color" in spec:
        return _solid(spec["color"], w, h)
    elif "pixabay" in spec:
        img = _pixabay_plate(spec["pixabay"])
    elif "prompt" in spec:
        img = _fetch_prompt(spec["prompt"])
    else:
        return _solid([0.05, 0.06, 0.08], w, h)
    return _cover_fit(img, w, h)


def _cover_fit(img: np.ndarray, w: int, h: int) -> np.ndarray:
    ih, iw = img.shape[:2]
    scale = max(w / iw, h / ih)
    rw, rh = max(w, int(round(iw * scale))), max(h, int(round(ih * scale)))
    r = cv2.resize(img, (rw, rh), interpolation=cv2.INTER_LINEAR)
    x0 = (rw - w) // 2
    y0 = (rh - h) // 2
    return r[y0:y0 + h, x0:x0 + w]
