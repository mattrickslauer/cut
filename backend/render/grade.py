"""Color grade — the instant "film look". Each scene `look` maps to a 3D LUT
(.cube) that ffmpeg applies with `lut3d` in one filter (research §4). We generate
the .cube files procedurally on first use, so there are no binary LUT assets to
ship and the looks are tweakable in code.

Looks match the perception agent's `suggested_look` vocabulary:
  Neutral · Noir · Sci-Fi · Golden · Thriller
"""
from __future__ import annotations

import os
from typing import Callable, Dict

import numpy as np

LUT_SIZE = 17  # 17^3 grid — plenty for a tone/color look, tiny file


def _luma(rgb: np.ndarray) -> np.ndarray:
    return (0.2126 * rgb[..., 0] + 0.7152 * rgb[..., 1] + 0.0722 * rgb[..., 2])[..., None]


def _apply(rgb, *, sat=1.0, contrast=1.0, lift=(0, 0, 0), gain=(1, 1, 1), gamma=(1, 1, 1)):
    c = rgb.copy()
    c = _luma(c) + (c - _luma(c)) * sat              # saturation
    c = (c - 0.5) * contrast + 0.5                    # contrast about mid
    c = np.clip(c, 0, 1)
    c = c * np.array(gain) + np.array(lift)           # lift/gain (color balance)
    c = np.clip(c, 1e-6, 1)
    c = c ** (1.0 / np.array(gamma))                  # per-channel gamma
    return np.clip(c, 0, 1)


# Each look: rgb (…x3, 0..1) -> graded rgb. Tasteful, gentle.
LOOKS: Dict[str, Callable[[np.ndarray], np.ndarray]] = {
    "Neutral": lambda c: c,
    "Noir":    lambda c: _apply(c, sat=0.12, contrast=1.28, gain=(0.98, 1.0, 1.06), gamma=(0.92, 0.92, 0.92)),
    "Sci-Fi":  lambda c: _apply(c, sat=1.12, contrast=1.12, lift=(-0.01, 0.0, 0.03),
                                gain=(0.96, 1.02, 1.10), gamma=(1.0, 1.0, 1.05)),  # teal shadows
    "Golden":  lambda c: _apply(c, sat=1.08, contrast=1.06, gain=(1.10, 1.02, 0.90), gamma=(1.02, 1.0, 0.96)),
    "Thriller": lambda c: _apply(c, sat=0.82, contrast=1.22, lift=(-0.01, 0.0, 0.01),
                                 gain=(0.97, 1.0, 1.02), gamma=(0.9, 0.92, 0.94)),
}


def _write_cube(path: str, fn: Callable[[np.ndarray], np.ndarray]) -> None:
    n = LUT_SIZE
    axis = np.linspace(0.0, 1.0, n, dtype=np.float32)
    # .cube: red varies fastest, then green, then blue
    b, g, r = np.meshgrid(axis, axis, axis, indexing="ij")
    grid = np.stack([r, g, b], axis=-1).reshape(-1, 3)   # order: r fastest
    out = fn(grid.astype(np.float32)).reshape(-1, 3)
    lines = [f'TITLE "cut-{os.path.splitext(os.path.basename(path))[0]}"',
             f"LUT_3D_SIZE {n}", "DOMAIN_MIN 0.0 0.0 0.0", "DOMAIN_MAX 1.0 1.0 1.0"]
    lines += [f"{v[0]:.6f} {v[1]:.6f} {v[2]:.6f}" for v in out]
    with open(path, "w") as f:
        f.write("\n".join(lines) + "\n")


def ensure_lut(look: str, lut_dir: str) -> str:
    """Return a path to the .cube for `look`, generating it if missing."""
    look = look if look in LOOKS else "Neutral"
    os.makedirs(lut_dir, exist_ok=True)
    path = os.path.join(lut_dir, f"{look}.cube")
    if not os.path.exists(path):
        _write_cube(path, LOOKS[look])
    return path


def build_all(lut_dir: str) -> Dict[str, str]:
    return {look: ensure_lut(look, lut_dir) for look in LOOKS}
