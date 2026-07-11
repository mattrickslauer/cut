"""Compositing a matted foreground over a generated background — the realism
layer. Matte quality is necessary but not sufficient; a clean alpha over a
mismatched background still screams "cutout". Realism wins, in order of impact
(research/video-pipeline.md §2):

  (a) color / luminance match   -> reinhard() in Lab, gently
  (b) edge feather + light wrap -> soft rim + ambient bleed from the bg
  (c) contact shadow            -> fake, but sells the grounding
  (d) premultiplied over        -> using RVM's fgr (not raw pixels) kills spill

Everything is float32 RGB in [0,1]; alpha is HxW in [0,1]. Pure numpy/OpenCV,
sub-10 ms/frame at 1080p, no torch — so this whole path is testable on CPU.
"""
from __future__ import annotations

from dataclasses import dataclass

import cv2
import numpy as np


@dataclass
class CompositeParams:
    erode_px: int = 2            # shrink alpha before feather so no 1-px hard rim
    feather_sigma: float = 1.2   # gaussian on the alpha edge
    wrap_sigma: float = 8.0      # how far bg light bleeds onto the subject edge
    wrap_strength: float = 0.9   # 0..1 amount of light wrap
    color_blend: float = 0.55    # 0..1 pull of FG color stats toward the BG
    shadow_offset: tuple = (12, 8)  # (dy, dx) shadow displacement, px
    shadow_sigma: float = 9.0    # shadow softness
    shadow_strength: float = 0.35  # 0..1 darkening under the subject


def _masked_mean_std(img: np.ndarray, w: np.ndarray, eps: float = 1e-5):
    """Per-channel weighted mean/std of img (HxWxC) under weight w (HxW)."""
    wsum = float(w.sum()) + eps
    ww = w[..., None]
    mean = (img * ww).reshape(-1, img.shape[2]).sum(0) / wsum
    var = ((img - mean) ** 2 * ww).reshape(-1, img.shape[2]).sum(0) / wsum
    return mean, np.sqrt(np.maximum(var, 0.0)) + eps


def reinhard(fg: np.ndarray, bg: np.ndarray, mask: np.ndarray) -> np.ndarray:
    """Shift/scale the foreground's Lab stats (within `mask`) toward the
    background's, so the subject reads as lit by the same environment. Gentle by
    construction; blend the result with the original at the call site."""
    if float(mask.sum()) < 1.0:
        return fg
    fg_lab = cv2.cvtColor(fg.astype(np.float32), cv2.COLOR_RGB2Lab)
    bg_lab = cv2.cvtColor(bg.astype(np.float32), cv2.COLOR_RGB2Lab)
    fm, fs = _masked_mean_std(fg_lab, mask)
    bm, bs = _masked_mean_std(bg_lab, np.ones(bg_lab.shape[:2], np.float32))
    out = (fg_lab - fm) * (bs / fs) + bm
    out[..., 0] = np.clip(out[..., 0], 0, 100)
    out[..., 1:] = np.clip(out[..., 1:], -127, 127)
    rgb = cv2.cvtColor(out, cv2.COLOR_Lab2RGB)
    return np.clip(rgb, 0.0, 1.0)


def feather_alpha(pha: np.ndarray, p: CompositeParams) -> np.ndarray:
    """Erode a couple px then blur so the composite has no hard 1-px rim."""
    a = pha.astype(np.float32)
    if p.erode_px > 0:
        k = np.ones((p.erode_px * 2 + 1, p.erode_px * 2 + 1), np.uint8)
        a = cv2.erode(a, k)
    if p.feather_sigma > 0:
        a = cv2.GaussianBlur(a, (0, 0), p.feather_sigma)
    return np.clip(a, 0.0, 1.0)


def composite_frame(fgr: np.ndarray, pha: np.ndarray, bg: np.ndarray,
                    p: CompositeParams = CompositeParams()) -> np.ndarray:
    """Composite estimated-foreground `fgr` (HxWx3) with alpha `pha` (HxW) over
    `bg` (HxWx3). All float32 RGB in [0,1], all the same size. Returns HxWx3."""
    assert fgr.shape == bg.shape, f"fgr {fgr.shape} != bg {bg.shape}"
    assert pha.shape == fgr.shape[:2], f"pha {pha.shape} != {fgr.shape[:2]}"
    fgr = fgr.astype(np.float32, copy=False)
    bg = bg.astype(np.float32, copy=False)

    a = feather_alpha(pha, p)
    a3 = a[..., None]

    # (a) gentle color match — pull FG stats toward the environment
    if p.color_blend > 0:
        matched = reinhard(fgr, bg, a)
        fgr = p.color_blend * matched + (1.0 - p.color_blend) * fgr

    # (b) light wrap — blurred bg light bleeds onto the subject's edge band
    wrap = np.zeros_like(fgr)
    if p.wrap_strength > 0:
        edge = np.clip(cv2.GaussianBlur(a, (0, 0), p.wrap_sigma) - a, 0.0, 1.0)
        wrap = cv2.GaussianBlur(bg, (0, 0), p.wrap_sigma) * (edge[..., None] * p.wrap_strength)

    # (c) fake contact shadow — offset+blur the alpha, darken the bg under it
    bg_sh = bg
    if p.shadow_strength > 0:
        dy, dx = p.shadow_offset
        sh = np.roll(a, (dy, dx), axis=(0, 1))
        sh = cv2.GaussianBlur(sh, (0, 0), p.shadow_sigma) * p.shadow_strength
        bg_sh = bg * (1.0 - sh[..., None])

    # (d) premultiplied over, using fgr (spill-free) + wrapped edge light
    out = (fgr + wrap) * a3 + bg_sh * (1.0 - a3)
    return np.clip(out, 0.0, 1.0)
