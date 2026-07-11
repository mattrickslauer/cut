"""The Edit Decision List — the compact, typed contract between the director
agent and the renderer. One Shot per directorial decision; the renderer turns
each into a virtual-camera move over the matted composite, then stitches them
with the given transitions and per-scene grade.

Times are in *source* seconds. Shots are expected in source-time order and
contiguous (coverage-cut of a single take); the assembler keeps the dialogue
audio continuous across cuts.
"""
from __future__ import annotations

import json
from dataclasses import dataclass, field, asdict
from typing import Any, Dict, List, Optional

SHOTS = ("WIDE", "MS", "MCU", "CU", "OTS")
SUBJECTS = ("A", "B", "both", "none")          # A = performer on LEFT, B = RIGHT
LOOKS = ("Neutral", "Noir", "Sci-Fi", "Golden", "Thriller")
TRANSITIONS = ("cut", "fade", "dissolve", "wipeleft", "wiperight", "circleopen")

# Perception agent vocab -> renderer vocab (so a director-produced read drops in)
_LOOK_ALIASES = {"neutral": "Neutral", "noir": "Noir", "sci-fi": "Sci-Fi",
                 "scifi": "Sci-Fi", "golden": "Golden", "thriller": "Thriller"}
_SHOT_ALIASES = {"wide": "WIDE", "ms": "MS", "medium": "MS", "mcu": "MCU",
                 "cu": "CU", "closeup": "CU", "close-up": "CU", "ots": "OTS"}


def _clamp_enum(value: Optional[str], allowed, default: str, aliases=None) -> str:
    if value is None:
        return default
    v = str(value).strip()
    if aliases and v.lower() in aliases:
        return aliases[v.lower()]
    return v if v in allowed else default


@dataclass
class Shot:
    id: str
    start: float                       # source seconds, inclusive
    end: float                         # source seconds, exclusive
    shot: str = "WIDE"                 # framing (SHOTS)
    subject: str = "both"             # who to frame on (SUBJECTS)
    look: str = "Neutral"             # per-scene grade (LOOKS)
    transition_in: str = "cut"        # how this shot begins vs the previous (TRANSITIONS)
    transition_dur: float = 0.4        # seconds; ignored for "cut"
    move: Optional[str] = None         # optional camera override: push|static|pan_left|pan_right
    background: Optional[Dict[str, Any]] = None  # {"file":..} | {"prompt":..} | {"color":[r,g,b]} | None
    note: str = ""                     # director_note, carried for overlays/debug

    def __post_init__(self):
        self.start = float(self.start)
        self.end = float(self.end)
        if self.end <= self.start:
            raise ValueError(f"shot {self.id!r}: end ({self.end}) must be > start ({self.start})")
        self.shot = _clamp_enum(self.shot, SHOTS, "WIDE", _SHOT_ALIASES)
        self.subject = _clamp_enum(self.subject, SUBJECTS, "both")
        self.look = _clamp_enum(self.look, LOOKS, "Neutral", _LOOK_ALIASES)
        self.transition_in = _clamp_enum(self.transition_in, TRANSITIONS, "cut")
        self.transition_dur = max(0.0, float(self.transition_dur))

    @property
    def duration(self) -> float:
        return self.end - self.start


@dataclass
class EDL:
    clip: str = ""                     # source video path (CLI --clip overrides)
    width: int = 1280
    height: int = 720
    fps: Optional[float] = None        # output fps; None -> source fps
    shots: List[Shot] = field(default_factory=list)
    meta: Dict[str, Any] = field(default_factory=dict)

    @property
    def size(self):
        return (int(self.width), int(self.height))

    def validate(self) -> "EDL":
        if not self.shots:
            raise ValueError("EDL has no shots")
        if self.width <= 0 or self.height <= 0:
            raise ValueError(f"bad output size {self.width}x{self.height}")
        # first shot can't dissolve from nothing
        self.shots[0].transition_in = "cut"
        return self

    def to_json(self, indent=2) -> str:
        d = asdict(self)
        return json.dumps(d, indent=indent)


def from_dict(d: Dict[str, Any]) -> EDL:
    shots = [Shot(**s) if not isinstance(s, Shot) else s for s in d.get("shots", [])]
    return EDL(
        clip=d.get("clip", ""),
        width=int(d.get("width", 1280)),
        height=int(d.get("height", 720)),
        fps=d.get("fps"),
        shots=shots,
        meta=d.get("meta", {}),
    ).validate()


def load(path: str) -> EDL:
    with open(path, "r") as f:
        return from_dict(json.load(f))
