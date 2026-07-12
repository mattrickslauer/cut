"""Monocular depth for a background still — the cue that turns a flat plate into
a scene with *air* in it. Depth drives three realism passes (see optics.py):
defocus (DoF), atmospheric haze, and — later — in-background parallax
(research/video-pipeline.md §C, "Depth-based parallax").

Backgrounds are pre-generated stills, so depth is a *one-time per-plate* cost,
cached to disk exactly like the plate itself — it never touches the per-frame
budget. Two backends, chosen by env `CUT_DEPTH_BACKEND` (default: auto):

  heuristic      no deps — a ground-near / sky-far prior modulated by local
                 detail. Serviceable for establishing plates; ships today.
  depth-anything Depth-Anything-V2 via transformers, if importable. The hero
                 path; upgrades automatically once torch is installed.

Contract: estimate(img01[, cache_key]) -> float32 HxW in [0,1], 1.0 = NEAREST,
0.0 = FARTHEST. Same convention everywhere downstream.
"""
from __future__ import annotations

import hashlib
import os
from typing import Optional

import cv2
import numpy as np

CACHE_DIR = os.environ.get("CUT_DEPTH_CACHE", os.path.expanduser("~/.cache/cut/depth"))
BACKEND = os.environ.get("CUT_DEPTH_BACKEND", "auto").lower()

_da_pipe = None            # lazily-built Depth-Anything pipeline (or False if unavailable)


def _luma(rgb: np.ndarray) -> np.ndarray:
    return 0.2126 * rgb[..., 0] + 0.7152 * rgb[..., 1] + 0.0722 * rgb[..., 2]


def _norm01(x: np.ndarray) -> np.ndarray:
    lo, hi = float(x.min()), float(x.max())
    if hi - lo < 1e-6:
        return np.full_like(x, 0.5, dtype=np.float32)
    return ((x - lo) / (hi - lo)).astype(np.float32)


def _heuristic(img01: np.ndarray) -> np.ndarray:
    """Depth prior with no learned model. Two monotonic cues that hold for most
    establishing shots: (1) vertical position — the ground is near, the sky/back
    is far; (2) local detail — sharp, textured regions read as nearer than the
    smooth washes of distant walls and sky. Blend, smooth, normalise."""
    g = _luma(img01).astype(np.float32)
    h, w = g.shape

    # (1) vertical prior: bottom rows near (→1), top rows far (→~0.15)
    vert = np.linspace(0.15, 1.0, h, dtype=np.float32)[:, None] * np.ones((1, w), np.float32)

    # (2) local detail: |g - blur(g)| as a nearness cue
    detail = np.abs(g - cv2.GaussianBlur(g, (0, 0), 3.0))
    detail = _norm01(cv2.GaussianBlur(detail, (0, 0), 6.0))

    depth = 0.62 * vert + 0.38 * detail
    depth = cv2.GaussianBlur(depth, (0, 0), max(2.0, min(h, w) / 180.0))  # smooth transitions
    return _norm01(depth)


def _depth_anything(img01: np.ndarray) -> Optional[np.ndarray]:
    """Depth-Anything-V2 via transformers, if the stack is importable. Returns
    None (→ caller falls back to heuristic) if torch/transformers are absent."""
    global _da_pipe
    if _da_pipe is False:
        return None
    if _da_pipe is None:
        try:
            from transformers import pipeline as hf_pipeline
            model = os.environ.get("CUT_DEPTH_MODEL", "depth-anything/Depth-Anything-V2-Small-hf")
            _da_pipe = hf_pipeline("depth-estimation", model=model)
        except Exception:
            _da_pipe = False
            return None
    try:
        from PIL import Image
        rgb8 = (np.clip(img01, 0, 1) * 255).astype(np.uint8)
        out = _da_pipe(Image.fromarray(rgb8))["depth"]
        d = np.asarray(out, np.float32)
        if d.shape != img01.shape[:2]:
            d = cv2.resize(d, (img01.shape[1], img01.shape[0]), interpolation=cv2.INTER_LINEAR)
        return _norm01(d)          # transformers returns near-bright → already 1=near after norm
    except Exception:
        return None


def _compute(img01: np.ndarray) -> np.ndarray:
    if BACKEND in ("depth-anything", "auto"):
        d = _depth_anything(img01)
        if d is not None:
            return d
        if BACKEND == "depth-anything":
            # explicit request but unavailable — warn once via env, still fall back
            pass
    return _heuristic(img01)


def estimate(img01: np.ndarray, cache_key: Optional[str] = None) -> np.ndarray:
    """Depth for an RGB float [0,1] plate. `cache_key` (e.g. the background spec)
    plus the pixel content key the disk cache; pass it for generated plates so a
    reused environment pays depth only once."""
    key_src = (cache_key or "") + "|" + hashlib.sha1(np.ascontiguousarray(img01)).hexdigest()[:16]
    key = BACKEND + "-" + hashlib.sha1(key_src.encode()).hexdigest()[:16]
    cached = os.path.join(CACHE_DIR, key + ".npy")
    if os.path.exists(cached):
        try:
            return np.load(cached)
        except Exception:
            pass
    depth = _compute(img01)
    try:
        os.makedirs(CACHE_DIR, exist_ok=True)
        np.save(cached, depth)
    except Exception:
        pass
    return depth
