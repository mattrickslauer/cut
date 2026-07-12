// Cut! — the Edit Decision List, shared "final clip" contract.
//
// This is the TypeScript mirror of the renderer's typed contract in
// backend/render/edl.py — SAME field names, SAME vocabulary, SAME defaults — so an
// EDL produced here in the browser drops straight into `edl.from_dict(...)` on the
// render service (POST /render {edl, clip}). backend/render/edl.py is the source of
// truth; keep the enums below in lock-step with it.
//
// One Shot per directorial decision. Times are in *source* seconds (relative to the
// recorded take), in order and contiguous — a coverage-cut of a single take.

export const SHOTS = ["WIDE", "MS", "MCU", "CU", "OTS"] as const;
export const SUBJECTS = ["A", "B", "both", "none"] as const; // A = performer on LEFT, B = RIGHT
export const LOOKS = ["Neutral", "Noir", "Sci-Fi", "Golden", "Thriller"] as const;
export const TRANSITIONS = ["cut", "fade", "dissolve", "wipeleft", "wiperight", "circleopen"] as const;

export type ShotKind = (typeof SHOTS)[number];
export type Subject = (typeof SUBJECTS)[number];
export type Look = (typeof LOOKS)[number];
export type Transition = (typeof TRANSITIONS)[number];

// Mirrors render/edl.py:Shot (field names must match exactly).
export type Shot = {
  id: string;
  start: number; // source seconds, inclusive
  end: number; // source seconds, exclusive (must be > start)
  shot: ShotKind;
  subject: Subject;
  look: Look;
  transition_in: Transition;
  transition_dur: number; // seconds; ignored for "cut"
  move?: string; // push|static|pan_left|pan_right
  background?: { file?: string; prompt?: string; color?: [number, number, number] } | null;
  note: string;
};

// Mirrors render/edl.py:EDL.
export type Edl = {
  clip: string; // source path/URL; may be "" — the render POST carries `clip` separately
  width: number;
  height: number;
  fps: number | null;
  shots: Shot[];
  meta: Record<string, unknown>;
};

// A caption cue as the Audition engine records them: a co-star speech span in
// *recorded-media* seconds. (Actor lines produce no cue — they are the gaps.)
export type Cue = { t: number; end: number; text: string; who: string };

export type TakeToEdlOpts = {
  durationSec: number; // total recorded-media length of the take
  look?: Look; // per-scene grade (default Neutral)
  width?: number;
  height?: number;
  fps?: number;
  meta?: Record<string, unknown>;
};

// A loose tone → look mapping so a scene's mood picks a sensible grade. Deterministic;
// unknown tones fall back to Neutral. Callers may override with opts.look.
export function lookForTone(tone: string | undefined): Look {
  const t = (tone || "").toLowerCase();
  if (/noir|shadow|smok|bruised|jaded/.test(t)) return "Noir";
  if (/thrill|combust|tense|high-stakes|contempt|danger/.test(t)) return "Thriller";
  if (/golden|warm|tender|aching|nostalg/.test(t)) return "Golden";
  if (/sci-?fi|cold|clinical|glacial|icy/.test(t)) return "Sci-Fi";
  return "Neutral";
}

const EPS = 0.08; // ignore sub-frame slivers (~2 frames @ 30fps)

// Turn a recorded take's cue track into a valid, contiguous EDL the renderer accepts.
//
// Cues mark the co-star's speech spans; the gaps between them (and the lead-in / tail)
// are the actor's turns. We tile the whole [0, durationSec] timeline into alternating
// segments — actor → subject "A" (framed MS), co-star → subject "B" (framed MCU) — so
// coverage is complete, source-ordered, and every shot has end > start.
export function takeToEdl(cues: Cue[], opts: TakeToEdlOpts): Edl {
  const look: Look = opts.look ?? "Neutral";
  const duration = Math.max(0, opts.durationSec);
  const width = opts.width ?? 1280;
  const height = opts.height ?? 720;
  const fps = opts.fps ?? 30;

  type Seg = { start: number; end: number; subject: Subject; note: string };
  const segs: Seg[] = [];
  const sorted = [...cues].sort((a, b) => a.t - b.t);
  let cursor = 0;

  const pushActor = (start: number, end: number) => {
    if (end - start > EPS) segs.push({ start, end, subject: "A", note: "" });
  };

  for (const cue of sorted) {
    const cs = Math.max(cursor, Math.min(cue.t, duration));
    // a well-formed cue has end > t; interrupted cues (end 0) get a short default beat
    const rawEnd = cue.end > cue.t ? cue.end : cue.t + 2;
    const ce = Math.min(Math.max(rawEnd, cs), duration);
    pushActor(cursor, cs); // actor turn before this co-star line
    if (ce - cs > EPS) segs.push({ start: cs, end: ce, subject: "B", note: cue.text });
    cursor = Math.max(cursor, ce);
  }
  pushActor(cursor, duration); // trailing actor beat / silence

  // Degenerate take (no usable spans): one WIDE covering whatever we have.
  if (segs.length === 0 && duration > EPS) {
    segs.push({ start: 0, end: duration, subject: "both", note: "" });
  }

  const shots: Shot[] = segs.map((s, i) => ({
    id: `s${i}`,
    start: round(s.start),
    end: round(s.end),
    shot: s.subject === "B" ? "MCU" : s.subject === "both" ? "WIDE" : "MS",
    subject: s.subject,
    look,
    transition_in: "cut", // first shot must be a cut anyway; keep dialogue continuous
    transition_dur: 0.4,
    note: s.note,
  }));

  return {
    clip: "",
    width,
    height,
    fps,
    shots,
    meta: { source: "audition", ...(opts.meta ?? {}) },
  };
}

function round(x: number): number {
  return Math.round(x * 1000) / 1000;
}
