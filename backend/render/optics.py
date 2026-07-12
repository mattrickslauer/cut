"""Optical realism passes — the difference between "clean cutout on a poster"
and "molded into a filmed scene." Two families:

  Depth-driven (need a depth map, run once per background plate):
    depth_of_field  — blur the plate by distance from the subject's focal plane.
                      Shallow DoF is the strongest single "shot on a lens" cue;
                      an all-in-focus AI still reads as flat cardboard.
    atmospheric_haze — lift + desaturate far depths toward a haze colour. The
                      cue the brain reads as real distance / real air.

  Shared-lens (per output frame, over the finished composite — so performer and
  environment pass through *one* lens together, research/video-pipeline.md §(d)):
    film_look       — matched grain + vignette + a whisper of chromatic
                      aberration. Unifies FG and BG under one optical signature.

All float32 RGB in [0,1]; depth is HxW in [0,1], 1.0 = nearest. Pure
numpy/OpenCV, no torch — same CPU-testable contract as composite.py.
"""
from __future__ import annotations

import cv2
import numpy as np


def _gblur(img: np.ndarray, sigma: float) -> np.ndarray:
    return cv2.GaussianBlur(img, (0, 0), sigma) if sigma > 0.3 else img


def depth_of_field(bg: np.ndarray, depth: np.ndarray, focal: float = 0.62,
                   strength: float = 0.7, max_blur: float = 8.0,
                   levels: int = 4) -> np.ndarray:
    """Variable defocus: sharp at the focal plane, blurrier with |depth - focal|.
    Approximated by lerping a small blur stack per-pixel (circle of confusion),
    which is ~3 gaussians — cheap and free of ringing."""
    if strength <= 0:
        return bg
    span = max(focal, 1.0 - focal, 1e-3)
    coc = np.clip(np.abs(depth - focal) / span, 0.0, 1.0) * strength   # 0..~1 per pixel

    sigmas = [max_blur * (i / (levels - 1)) for i in range(levels)]     # 0 .. max_blur
    stack = [_gblur(bg, s) for s in sigmas]
    pos = coc * (levels - 1)                                            # index space
    lo = np.floor(pos).astype(np.int32)
    lo = np.clip(lo, 0, levels - 2)
    frac = (pos - lo)[..., None]

    out = np.zeros_like(bg)
    for i in range(levels - 1):
        m = (lo == i)
        if not m.any():
            continue
        m3 = m[..., None]
        out = np.where(m3, stack[i] * (1.0 - frac) + stack[i + 1] * frac, out)
    return np.clip(out, 0.0, 1.0)


def atmospheric_haze(bg: np.ndarray, depth: np.ndarray,
                     haze=(0.72, 0.76, 0.82), strength: float = 0.28,
                     falloff: float = 1.4) -> np.ndarray:
    """Blend far depths toward a pale haze colour — real distance is never fully
    saturated or fully contrasty. Only affects depths behind the subject plane."""
    if strength <= 0:
        return bg
    far = np.clip(1.0 - depth, 0.0, 1.0) ** falloff
    h = (far * strength)[..., None]
    return np.clip(bg * (1.0 - h) + np.array(haze, np.float32) * h, 0.0, 1.0)


def _vignette_mask(h: int, w: int, strength: float) -> np.ndarray:
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    cx, cy = (w - 1) / 2.0, (h - 1) / 2.0
    r = np.sqrt(((xx - cx) / cx) ** 2 + ((yy - cy) / cy) ** 2) / np.sqrt(2.0)  # 0 centre .. 1 corner
    return (1.0 - strength * np.clip(r, 0, 1) ** 2.2).astype(np.float32)


def film_look(out: np.ndarray, grain: float = 0.018, vignette: float = 0.16,
              chroma: float = 0.5, seed: int = 0) -> np.ndarray:
    """One optical signature over the whole frame: luma grain + vignette + a
    sub-pixel chromatic split at the edges. Applied AFTER compositing so FG and
    BG share it — the thing that makes a composite read as one photographed image."""
    h, w = out.shape[:2]
    res = out

    if chroma > 0:
        # radial channel split: push R out and B in, scaled by distance to centre
        yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
        cx, cy = (w - 1) / 2.0, (h - 1) / 2.0
        rx, ry = (xx - cx) / max(cx, 1), (yy - cy) / max(cy, 1)
        shift = chroma
        mapx_r = (xx + rx * shift).astype(np.float32)
        mapy_r = (yy + ry * shift).astype(np.float32)
        mapx_b = (xx - rx * shift).astype(np.float32)
        mapy_b = (yy - ry * shift).astype(np.float32)
        r = cv2.remap(res[..., 0], mapx_r, mapy_r, cv2.INTER_LINEAR, borderMode=cv2.BORDER_REFLECT)
        b = cv2.remap(res[..., 2], mapx_b, mapy_b, cv2.INTER_LINEAR, borderMode=cv2.BORDER_REFLECT)
        res = np.stack([r, res[..., 1], b], axis=-1)

    if vignette > 0:
        res = res * _vignette_mask(h, w, vignette)[..., None]

    if grain > 0:
        rng = np.random.default_rng(seed)          # deterministic per frame → reproducible renders
        noise = rng.standard_normal((h, w, 1)).astype(np.float32) * grain
        # grain rides in the mids, fades in deep shadow/highlight like real film
        luma = (0.2126 * res[..., 0] + 0.7152 * res[..., 1] + 0.0722 * res[..., 2])[..., None]
        weight = 1.0 - np.abs(luma - 0.5) * 1.4
        res = res + noise * np.clip(weight, 0.15, 1.0)

    return np.clip(res, 0.0, 1.0)
