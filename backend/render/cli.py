"""Command line for the Cut! render service.

  # real render (needs torch + a GPU for RVM):
  python -m render.cli render --clip take.mp4 --edl edl.json --out cut.mp4

  # torch-free end-to-end smoke test (synthesizes a clip, uses FakeMatte):
  python -m render.cli selfcheck --out /tmp/cut_selfcheck.mp4
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import tempfile

from . import edl as edl_mod
from . import pipeline
from .ffio import FFMPEG
from .matte import make_matte


def _cmd_render(a) -> int:
    e = edl_mod.load(a.edl)
    source = a.clip or e.clip
    if a.width:
        e.width = a.width
    if a.height:
        e.height = a.height
    if a.fps:
        e.fps = a.fps
    matte = make_matte(fake=a.fake, variant=a.variant)
    workdir = a.workdir or tempfile.mkdtemp(prefix="cut_render_")
    os.makedirs(workdir, exist_ok=True)
    out = pipeline.render_edl(e, matte, a.out, workdir, source=source)
    print(f"\n✓ wrote {out}")
    return 0


_SELFCHECK_EDL = {
    "width": 1280, "height": 720, "fps": 25,
    "shots": [
        {"id": "s1", "start": 0.0, "end": 2.4, "shot": "WIDE", "subject": "both",
         "look": "Neutral", "transition_in": "cut",
         "background": {"color": [30, 40, 70]}, "note": "establish"},
        {"id": "s2", "start": 2.4, "end": 4.4, "shot": "MCU", "subject": "A",
         "look": "Golden", "transition_in": "cut",
         "background": {"color": [90, 60, 30]}, "note": "push on A"},
        {"id": "s3", "start": 4.4, "end": 6.2, "shot": "CU", "subject": "B",
         "look": "Noir", "transition_in": "dissolve", "transition_dur": 0.5,
         "background": {"color": [20, 20, 24]}, "note": "reaction, dissolve"},
        {"id": "s4", "start": 6.2, "end": 8.0, "shot": "WIDE", "subject": "both",
         "look": "Sci-Fi", "transition_in": "fade", "transition_dur": 0.6,
         "background": {"color": [16, 42, 46]}, "note": "new scene"},
    ],
}


def _synth_clip(path: str, seconds: float = 8.0) -> None:
    """A moving test pattern + a tone → a valid clip with motion and audio."""
    subprocess.run(
        [FFMPEG, "-nostdin", "-v", "error", "-y",
         "-f", "lavfi", "-i", f"testsrc2=size=1280x720:rate=25:duration={seconds}",
         "-f", "lavfi", "-i", f"sine=frequency=220:duration={seconds}",
         "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", path],
        check=True)


def _cmd_selfcheck(a) -> int:
    workdir = tempfile.mkdtemp(prefix="cut_selfcheck_")
    clip = os.path.join(workdir, "synth.mp4")
    print("synthesizing test clip…")
    _synth_clip(clip)
    e = edl_mod.from_dict(dict(_SELFCHECK_EDL, clip=clip))
    matte = make_matte(fake=True)
    out = pipeline.render_edl(e, matte, a.out, workdir, source=clip)
    # verify the output actually decodes
    from .ffio import probe
    info = probe(out)
    print(f"\n✓ selfcheck ok: {out}  "
          f"({info.width}x{info.height} {info.fps:.0f}fps {info.duration:.2f}s "
          f"audio={info.has_audio})")
    return 0


def main(argv=None) -> int:
    p = argparse.ArgumentParser(prog="render", description="Cut! cinematic render")
    sub = p.add_subparsers(dest="cmd", required=True)

    r = sub.add_parser("render", help="render an EDL over a source clip")
    r.add_argument("--clip", help="source video (overrides edl.clip)")
    r.add_argument("--edl", required=True, help="EDL json path")
    r.add_argument("--out", required=True, help="output mp4")
    r.add_argument("--fake", action="store_true", help="use FakeMatte (no torch/GPU)")
    r.add_argument("--variant", default="mobilenetv3", choices=["mobilenetv3", "resnet50"])
    r.add_argument("--workdir", help="scratch dir (default: temp)")
    r.add_argument("--width", type=int)
    r.add_argument("--height", type=int)
    r.add_argument("--fps", type=float)
    r.set_defaults(fn=_cmd_render)

    s = sub.add_parser("selfcheck", help="synthesize a clip and render it with FakeMatte")
    s.add_argument("--out", default=os.path.join(tempfile.gettempdir(), "cut_selfcheck.mp4"))
    s.set_defaults(fn=_cmd_selfcheck)

    a = p.parse_args(argv)
    try:
        return a.fn(a)
    except Exception as exc:  # concise failure for CLI use
        print(f"error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
