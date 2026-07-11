"""Human video matting — produce a soft alpha (not a binary mask) for the moving
performers against an arbitrary real room, temporally stable, no green screen.

Primary: Robust Video Matting (RVM, ByteDance) — recurrent temporal memory gives
frame-to-frame edge stability, trimap-free, real-time at HD (research §1). We use
RVM's estimated foreground `fgr`, NOT the raw camera pixels, to kill edge spill.

`FakeMatte` is a torch-free stand-in (two soft ellipses) so the entire
composite -> camera -> grade -> assemble path is runnable and testable on a CPU
with no model download. Both expose the same interface:

    m.reset()                       # start of a new sequence (per shot)
    fgr, pha = m.matte(rgb01)       # rgb01: HxWx3 float32 in [0,1] -> fgr HxWx3, pha HxW

Feed frames sequentially — never shuffle — or RVM loses its temporal memory.
"""
from __future__ import annotations

from typing import List, Optional, Tuple

import numpy as np

from .device import Device, pick_device


def _downsample_ratio(long_side: int) -> float:
    """RVM works best when the internal pass sees a ~512px long side."""
    return float(min(1.0, max(0.25, 512.0 / max(1, long_side))))


class RVMMatte:
    """Robust Video Matting. Requires torch + torchvision; a GPU for real speed."""

    def __init__(self, variant: str = "mobilenetv3", device: Optional[Device] = None):
        import torch  # local import: the FakeMatte path never needs torch
        self.torch = torch
        self.device = device or pick_device()
        self.model = torch.hub.load("PeterL1n/RobustVideoMatting", variant)
        self.model = self.model.to(self.device.torch_device).eval()
        if self.device.half:
            self.model = self.model.half()
        self._rec: List[Optional["object"]] = [None] * 4  # recurrent temporal state

    def reset(self) -> None:
        self._rec = [None] * 4

    def matte(self, rgb01: np.ndarray) -> Tuple[np.ndarray, np.ndarray]:
        torch = self.torch
        h, w = rgb01.shape[:2]
        dr = _downsample_ratio(max(h, w))
        src = torch.from_numpy(np.ascontiguousarray(rgb01.transpose(2, 0, 1)))[None]
        src = src.to(self.device.torch_device)
        src = src.half() if self.device.half else src.float()
        with torch.no_grad():
            if self.device.autocast:
                with torch.autocast("cuda"):
                    fgr, pha, *self._rec = self.model(src, *self._rec, dr)
            else:
                fgr, pha, *self._rec = self.model(src, *self._rec, dr)
        fgr_np = fgr[0].float().clamp(0, 1).permute(1, 2, 0).cpu().numpy()
        pha_np = pha[0, 0].float().clamp(0, 1).cpu().numpy()
        return fgr_np.astype(np.float32), pha_np.astype(np.float32)


class FakeMatte:
    """Torch-free stand-in: two soft vertical ellipses (a left + a right performer)
    over the real frame. NOT for production — it exists so the composite / camera /
    grade / assembly path can be exercised end-to-end without a GPU or model."""

    def __init__(self, centers=((0.34, 0.55), (0.66, 0.55)),
                 radii=(0.16, 0.42), softness: float = 0.10):
        self.centers = centers
        self.radii = radii
        self.softness = softness
        self._grid = None  # cache (yy,xx) for a given size

    def reset(self) -> None:
        pass

    def matte(self, rgb01: np.ndarray) -> Tuple[np.ndarray, np.ndarray]:
        h, w = rgb01.shape[:2]
        if self._grid is None or self._grid[0].shape != (h, w):
            yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
            self._grid = (yy / h, xx / w)
        ny, nx = self._grid
        rx, ry = self.radii
        alpha = np.zeros((h, w), np.float32)
        for cx, cy in self.centers:
            d = np.sqrt(((nx - cx) / rx) ** 2 + ((ny - cy) / ry) ** 2)
            # smoothstep falloff around d==1
            e = np.clip((1.0 - d) / max(self.softness, 1e-3), 0.0, 1.0)
            alpha = np.maximum(alpha, e * e * (3 - 2 * e))
        return rgb01.astype(np.float32), alpha.astype(np.float32)


def make_matte(fake: bool = False, variant: str = "mobilenetv3",
               device: Optional[Device] = None):
    return FakeMatte() if fake else RVMMatte(variant=variant, device=device)
