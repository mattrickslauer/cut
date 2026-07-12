"""Orchestration: EDL + source clip -> finished, graded film.

Per shot (streamed, memory-bounded):
    decode [start,end] -> RVM matte (fgr,pha) -> virtual camera (parallax+push)
    -> composite over the resolved background -> pipe to a graded segment mp4
    (scene LUT baked in, dialogue audio sliced from source).
Then assemble stitches the segments with the EDL's transitions.
"""
from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Callable, List, Optional

import numpy as np

from . import assemble, backgrounds, depth, ffio, grade, optics
from .camera import BG_OVERSCAN, ShotCamera
from .composite import CompositeParams, composite_frame
from .edl import EDL, Shot


def _bg_key(spec) -> str:
    """Stable cache key for a shot's background spec, so a reused environment
    estimates depth only once."""
    if not spec:
        return "none"
    return str(spec.get("file") or spec.get("prompt") or spec.get("color") or "none")


@dataclass
class Segment:
    path: str
    transition_in: str
    transition_dur: float
    duration: float


def render_shot(edl: EDL, shot: Shot, matte, seg_path: str, lut_dir: str,
                cparams: CompositeParams, source: str,
                on_progress: Optional[Callable[[int, int], None]] = None) -> Segment:
    info = ffio.probe(source)
    out_w, out_h = edl.size
    fps = float(edl.fps or info.fps)
    n = max(1, int(round(shot.duration * fps)))

    cam = ShotCamera(out_w, out_h, shot=shot.shot, subject=shot.subject,
                     move=(shot.move or "push"))
    bg = backgrounds.resolve(shot.background,
                             int(out_w * BG_OVERSCAN), int(out_h * BG_OVERSCAN))
    # Depth-driven realism: estimate depth once, then defocus + haze the plate so
    # the environment has air in it and reads as shot on a lens (optics.py).
    if cparams.depth_realism and (cparams.dof > 0 or cparams.haze > 0):
        dmap = depth.estimate(bg, cache_key=_bg_key(shot.background))
        bg = optics.atmospheric_haze(bg, dmap, strength=cparams.haze)
        bg = optics.depth_of_field(bg, dmap, focal=cparams.focal_depth, strength=cparams.dof)
    bg_prepared = cam.prepare_bg(bg)
    lut_path = grade.ensure_lut(shot.look, lut_dir)

    writer = ffio.SegmentWriter(seg_path, out_w, out_h, fps, lut_path,
                                source=source, a_start=shot.start, a_end=shot.end)
    matte.reset()  # new sequence -> reset RVM temporal memory
    i = 0
    try:
        for frame in ffio.iter_frames(source, shot.start, shot.end,
                                      width=info.width, height=info.height):
            t = i / max(1, n - 1)
            fgr, pha = matte.matte(frame.astype(np.float32) / 255.0)
            fg_pos, a_pos, bg_pos = cam.frame(fgr, pha, bg_prepared, t)
            out01 = composite_frame(fg_pos, a_pos, bg_pos, cparams)
            # shared-lens pass: one grain/vignette/aberration signature over the
            # whole frame so performer and environment feel photographed together.
            if cparams.grain > 0 or cparams.vignette > 0 or cparams.chroma > 0:
                out01 = optics.film_look(out01, grain=cparams.grain,
                                         vignette=cparams.vignette,
                                         chroma=cparams.chroma, seed=i)
            writer.write(out01)
            i += 1
            if on_progress and i % 15 == 0:
                on_progress(i, n)
    finally:
        writer.close()
    realized = i / fps if fps else shot.duration
    return Segment(seg_path, shot.transition_in, shot.transition_dur, realized)


def render_edl(edl: EDL, matte, out_path: str, workdir: str,
               cparams: Optional[CompositeParams] = None,
               source: Optional[str] = None,
               log: Callable[[str], None] = print) -> str:
    cparams = cparams or CompositeParams()
    source = source or edl.clip
    if not source or not os.path.exists(source):
        raise FileNotFoundError(f"source clip not found: {source!r}")
    seg_dir = os.path.join(workdir, "segments")
    lut_dir = os.path.join(workdir, "luts")
    os.makedirs(seg_dir, exist_ok=True)

    segments: List[Segment] = []
    for idx, shot in enumerate(edl.shots):
        seg_path = os.path.join(seg_dir, f"seg_{idx:03d}.mp4")
        log(f"[{idx + 1}/{len(edl.shots)}] shot {shot.id} "
            f"{shot.shot}/{shot.subject} look={shot.look} "
            f"{shot.duration:.2f}s <-{shot.transition_in}")
        seg = render_shot(edl, shot, matte, seg_path, lut_dir, cparams, source)
        segments.append(seg)

    log(f"assembling {len(segments)} shots -> {out_path}")
    assemble.stitch(segments, out_path,
                    fps=float(edl.fps or ffio.probe(source).fps), log=log)
    return out_path
