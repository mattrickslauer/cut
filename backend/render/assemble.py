"""Stitch the per-shot graded segments into the final cut.

Each transition_in drives one pairwise combine:
  "cut"      -> concat (hard cut)
  otherwise  -> xfade (video) + acrossfade (audio) with the given duration

Segments already share resolution / fps / pixfmt (all produced by the pipeline),
which is exactly what xfade and concat require. Dialogue audio rides along per
segment, so cuts keep the improv's speech continuous.
"""
from __future__ import annotations

import subprocess
from typing import List, Sequence

from . import ffio
from .ffio import FFMPEG

# our EDL transition name -> ffmpeg xfade transition
_XFADE = {"fade": "fade", "dissolve": "dissolve", "wipeleft": "wipeleft",
          "wiperight": "wiperight", "circleopen": "circleopen"}


def stitch(segments: Sequence, out_path: str, fps: float, log=print) -> str:
    paths = [s.path for s in segments]
    n = len(paths)
    if n == 0:
        raise ValueError("no segments to stitch")
    if n == 1:
        subprocess.run([FFMPEG, "-nostdin", "-v", "error", "-y", "-i", paths[0],
                        "-c", "copy", out_path], check=True)
        return out_path

    has_audio = ffio.probe(paths[0]).has_audio
    inputs: List[str] = []
    for p in paths:
        inputs += ["-i", p]

    filt: List[str] = []
    # Normalize every input to a common timebase / fps / SAR first, so concat and
    # xfade can be freely chained (xfade rejects mismatched timebases).
    for i in range(n):
        filt.append(f"[{i}:v]fps={fps:.6f},settb=AVTB,format=yuv420p,setsar=1[nv{i}]")
        if has_audio:
            filt.append(f"[{i}:a]aresample=async=1,asettb=AVTB[na{i}]")

    vcur, acur = "nv0", "na0"
    dur = float(segments[0].duration)
    for i in range(1, n):
        seg = segments[i]
        vout, aout = f"v{i}", f"a{i}"
        if seg.transition_in == "cut":
            filt.append(f"[{vcur}][nv{i}]concat=n=2:v=1:a=0[{vout}]")
            if has_audio:
                filt.append(f"[{acur}][na{i}]concat=n=2:v=0:a=1[{aout}]")
            dur += seg.duration
        else:
            d = max(0.05, min(seg.transition_dur, seg.duration - 0.05, dur - 0.05))
            off = max(0.0, dur - d)
            tname = _XFADE.get(seg.transition_in, "fade")
            filt.append(f"[{vcur}][nv{i}]xfade=transition={tname}:"
                        f"duration={d:.3f}:offset={off:.3f}[{vout}]")
            if has_audio:
                filt.append(f"[{acur}][na{i}]acrossfade=d={d:.3f}[{aout}]")
            dur += seg.duration - d
        vcur = vout
        if has_audio:
            acur = aout

    cmd = [FFMPEG, "-nostdin", "-v", "error", "-y", *inputs,
           "-filter_complex", ";".join(filt), "-map", f"[{vcur}]"]
    if has_audio:
        cmd += ["-map", f"[{acur}]", "-c:a", "aac", "-b:a", "192k"]
    cmd += ["-c:v", "libx264", "-preset", "veryfast", "-crf", "18",
            "-pix_fmt", "yuv420p", "-r", f"{fps:.6f}", out_path]
    proc = subprocess.run(cmd, capture_output=True)
    if proc.returncode != 0:
        raise RuntimeError("ffmpeg stitch failed:\n" + proc.stderr.decode()[:1200])
    return out_path
