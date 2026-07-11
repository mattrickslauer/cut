"""Device / dtype selection for the matting model.

cuda -> fp16 (RVM's target; huge headroom on a 4090)
mps  -> fp32 (Apple Silicon; fp16 matmul on MPS is still flaky)
cpu  -> fp32 (works, slow — fine for a few frames / CI smoke tests)
"""
from __future__ import annotations

import os
from dataclasses import dataclass


@dataclass(frozen=True)
class Device:
    kind: str          # "cuda" | "mps" | "cpu"
    torch_device: str  # what you pass to .to(...)
    half: bool         # use fp16?

    @property
    def autocast(self) -> bool:
        return self.kind == "cuda"


def pick_device(prefer: str | None = None) -> Device:
    """Choose the best available device. `prefer` (or $CUT_DEVICE) forces one."""
    prefer = (prefer or os.environ.get("CUT_DEVICE") or "").strip().lower()
    try:
        import torch
    except Exception:  # torch absent (e.g. FakeMatte smoke test) — report cpu
        return Device("cpu", "cpu", False)

    def available(kind: str) -> bool:
        if kind == "cuda":
            return torch.cuda.is_available()
        if kind == "mps":
            return getattr(torch.backends, "mps", None) is not None and torch.backends.mps.is_available()
        return kind == "cpu"

    order = [prefer] if prefer in ("cuda", "mps", "cpu") else []
    order += ["cuda", "mps", "cpu"]
    for kind in order:
        if kind and available(kind):
            return Device(kind, kind, half=(kind == "cuda"))
    return Device("cpu", "cpu", False)
