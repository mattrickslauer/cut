"""Virtual camera from a locked-off two-shot.

Matting already split the scene into FG (performers, with alpha) and BG
(generated environment). Moving them at *different* rates during a Ken Burns
push gives real 2.5D parallax — the depth cue the brain reads as a physical
dolly. That's free given our architecture (research/video-pipeline.md §3, B+A).

`ShotCamera` yields, per output frame, the FG color, FG alpha and BG all
positioned at output size — ready for composite_frame(). Framing (WIDE..CU) sets
the base FG scale; `subject` (A=left, B=right) biases the horizontal center so a
close-up lands on the speaker.
"""
from __future__ import annotations

from dataclasses import dataclass

import cv2
import numpy as np

# Base FG zoom per framing. WIDE keeps the whole two-shot; tighter shots push in.
_SHOT_SCALE = {"WIDE": 1.0, "MS": 1.28, "MCU": 1.62, "CU": 2.05, "OTS": 1.5}
# Fraction of frame width to bias toward a single subject (A left / B right).
_SUBJECT_BIAS = {"A": -0.18, "B": 0.18, "both": 0.0, "none": 0.0}

BG_OVERSCAN = 1.30   # bg is rendered larger than output so it can drift without exposing edges


def ease_in_out(t: float) -> float:
    """Smooth cubic ease — never linear (linear reads as a robotic slide)."""
    t = min(1.0, max(0.0, t))
    return 3 * t * t - 2 * t * t * t


def _affine(img: np.ndarray, scale: float, tx: float, ty: float,
            out_w: int, out_h: int, border) -> np.ndarray:
    """Scale `img` about the OUTPUT center and translate, sampling into out_w×out_h."""
    h, w = img.shape[:2]
    cx, cy = out_w / 2.0, out_h / 2.0
    # map output center to source center, then scale about it, then translate
    m = np.array([
        [scale, 0.0, cx - scale * (w / 2.0) + tx],
        [0.0, scale, cy - scale * (h / 2.0) + ty],
    ], dtype=np.float32)
    flags = cv2.INTER_LINEAR
    return cv2.warpAffine(img, m, (out_w, out_h), flags=flags,
                          borderMode=cv2.BORDER_CONSTANT if border is not None else cv2.BORDER_REFLECT,
                          borderValue=border if border is not None else 0)


@dataclass
class ShotCamera:
    out_w: int
    out_h: int
    shot: str = "WIDE"
    subject: str = "both"
    move: str = "push"          # push | static | pan_left | pan_right
    push: float = 0.06          # extra zoom over the shot (fraction)
    parallax: float = 34.0      # px of FG travel; BG travels ~0.35× -> parallax

    def _bg_prepared(self, bg: np.ndarray) -> np.ndarray:
        """Resize bg to output*overscan once, so per-frame is just a warp."""
        tw, th = int(self.out_w * BG_OVERSCAN), int(self.out_h * BG_OVERSCAN)
        return cv2.resize(bg, (tw, th), interpolation=cv2.INTER_LINEAR)

    def _fg_prepared(self, fgr: np.ndarray, pha: np.ndarray):
        """Fit FG (color+alpha) to output size (source is same aspect as output)."""
        if fgr.shape[1] != self.out_w or fgr.shape[0] != self.out_h:
            fgr = cv2.resize(fgr, (self.out_w, self.out_h), interpolation=cv2.INTER_LINEAR)
            pha = cv2.resize(pha, (self.out_w, self.out_h), interpolation=cv2.INTER_LINEAR)
        return fgr, pha

    def frame(self, fgr: np.ndarray, pha: np.ndarray, bg_prepared: np.ndarray, t: float):
        """Return (fg_pos, alpha_pos, bg_pos) at output size for normalized time t∈[0,1]."""
        e = ease_in_out(t)
        base = _SHOT_SCALE.get(self.shot, 1.0)
        bias_x = _SUBJECT_BIAS.get(self.subject, 0.0) * self.out_w

        # Ken Burns push: FG zooms in, BG zooms slightly less (depth).
        fg_scale = base * (1.0 + self.push * e)
        bg_zoom = 1.0 + self.push * 0.6 * e

        # Lateral move -> parallax (FG travels more than BG).
        if self.move == "pan_left":
            dir_ = -1.0
        elif self.move == "pan_right":
            dir_ = 1.0
        else:
            dir_ = 0.0
        fg_tx = bias_x + dir_ * self.parallax * e
        bg_tx = dir_ * self.parallax * 0.35 * e

        fgr2, pha2 = self._fg_prepared(fgr, pha)
        fg_pos = _affine(fgr2, fg_scale, fg_tx, 0.0, self.out_w, self.out_h, border=0.0)
        a_pos = _affine(pha2, fg_scale, fg_tx, 0.0, self.out_w, self.out_h, border=0.0)

        # bg_prepared is output*overscan; scale it down to output, then apply zoom/drift.
        bg_base = (1.0 / BG_OVERSCAN)
        bg_pos = _affine(bg_prepared, bg_base * bg_zoom, bg_tx, 0.0,
                         self.out_w, self.out_h, border=None)  # reflect: never expose edge
        return np.clip(fg_pos, 0, 1), np.clip(a_pos, 0, 1), np.clip(bg_pos, 0, 1)
