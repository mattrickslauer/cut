"""ffmpeg / ffprobe I/O — decode a shot's frames as raw RGB, and encode a graded
segment (video from piped frames + the shot's dialogue audio sliced from source).
Keeps the whole renderer dependency-light: just ffmpeg on PATH, numpy, OpenCV.
"""
from __future__ import annotations

import json
import shutil
import subprocess
from dataclasses import dataclass
from typing import Iterator, Optional

import numpy as np

FFMPEG = shutil.which("ffmpeg") or "ffmpeg"
FFPROBE = shutil.which("ffprobe") or "ffprobe"


@dataclass
class VideoInfo:
    width: int
    height: int
    fps: float
    duration: float
    has_audio: bool


def probe(path: str) -> VideoInfo:
    out = subprocess.run(
        [FFPROBE, "-v", "error", "-print_format", "json",
         "-show_streams", "-show_format", path],
        capture_output=True, text=True, check=True).stdout
    data = json.loads(out)
    v = next((s for s in data["streams"] if s["codec_type"] == "video"), None)
    if v is None:
        raise ValueError(f"{path}: no video stream")
    has_audio = any(s["codec_type"] == "audio" for s in data["streams"])
    num, den = (v.get("avg_frame_rate") or v.get("r_frame_rate") or "25/1").split("/")
    fps = (float(num) / float(den)) if float(den) else 25.0
    dur = float(data.get("format", {}).get("duration") or v.get("duration") or 0.0)
    return VideoInfo(int(v["width"]), int(v["height"]), fps or 25.0, dur, has_audio)


def iter_frames(path: str, start: float, end: float,
                width: Optional[int] = None, height: Optional[int] = None) -> Iterator[np.ndarray]:
    """Yield frames in [start, end) as HxWx3 uint8 RGB. Frame-accurate seek."""
    info = probe(path)
    w = width or info.width
    h = height or info.height
    vf = [] if (w == info.width and h == info.height) else ["-vf", f"scale={w}:{h}"]
    cmd = [FFMPEG, "-nostdin", "-v", "error", "-accurate_seek",
           "-ss", f"{start:.4f}", "-to", f"{end:.4f}", "-i", path,
           *vf, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    frame_bytes = w * h * 3
    try:
        while True:
            buf = proc.stdout.read(frame_bytes)
            if len(buf) < frame_bytes:
                break
            yield np.frombuffer(buf, np.uint8).reshape(h, w, 3)
    finally:
        if proc.stdout:
            proc.stdout.close()
        proc.wait()


class SegmentWriter:
    """Pipe composed uint8 RGB frames to ffmpeg; mux the shot's dialogue audio
    (sliced from `source` over [a_start, a_end]) and bake the scene LUT."""

    def __init__(self, out_path: str, width: int, height: int, fps: float,
                 lut_path: Optional[str], source: Optional[str] = None,
                 a_start: float = 0.0, a_end: float = 0.0, crf: int = 18):
        self.width, self.height = width, height
        vfilter = "format=yuv420p"
        if lut_path:
            vfilter = f"lut3d=f='{lut_path}',{vfilter}"
        cmd = [FFMPEG, "-nostdin", "-v", "error", "-y",
               "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{width}x{height}",
               "-r", f"{fps:.6f}", "-i", "-"]
        have_audio = bool(source) and a_end > a_start
        if have_audio:
            cmd += ["-accurate_seek", "-ss", f"{a_start:.4f}", "-to", f"{a_end:.4f}", "-i", source]
        cmd += ["-filter_complex", f"[0:v]{vfilter}[v]", "-map", "[v]"]
        if have_audio:
            cmd += ["-map", "1:a?", "-c:a", "aac", "-b:a", "192k", "-shortest"]
        cmd += ["-c:v", "libx264", "-preset", "veryfast", "-crf", str(crf),
                "-pix_fmt", "yuv420p", out_path]
        self.proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stderr=subprocess.PIPE)
        self.out_path = out_path

    def write(self, rgb01: np.ndarray) -> None:
        u8 = (np.clip(rgb01, 0, 1) * 255.0 + 0.5).astype(np.uint8)
        self.proc.stdin.write(u8.tobytes())

    def close(self) -> None:
        self.proc.stdin.close()
        _, err = self.proc.communicate()
        if self.proc.returncode != 0:
            raise RuntimeError(f"ffmpeg encode failed for {self.out_path}:\n{err.decode()[:800]}")
