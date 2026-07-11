"""Cut! — cinematic render service.

Turns a recorded two-person improv clip + an Edit Decision List into a finished,
graded film: RVM matte -> OpenCV composite (light-wrap / color-match / contact
shadow) -> 2.5D multiplane parallax + Ken Burns -> per-scene LUT grade -> xfade
assembly. See README.md and ../../research/video-pipeline.md.

This is the batch "final render" lane. The browser app (../../app) remains the
live preview lane; matte/composite/camera here are written to be reusable by a
future streaming lane.
"""

__all__ = [
    "device",
    "edl",
    "matte",
    "composite",
    "camera",
    "grade",
    "assemble",
    "pipeline",
]
