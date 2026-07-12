# Cut! — Cinematic Render Service

The **final render lane**: take a recorded two-person improv clip + an Edit
Decision List and produce a finished, graded film. Matte the performers off their
real room, composite them onto generated environments, add a virtual camera, cut
it together with per-scene grades and transitions, keep the dialogue.

This is the batch/"film drops minutes later" lane. The browser app
([`../../app`](../../app)) stays the live preview lane; the matte / composite /
camera modules here are written to be reusable by a future streaming lane.

Design + rationale: [`../../research/video-pipeline.md`](../../research/video-pipeline.md).

## Pipeline

```
clip.mp4 + edl.json
   │  decode shot [start,end]         ffio.iter_frames
   │  RVM matte  → (fgr, pha)         matte.RVMMatte   (temporal, spill-free fgr)
   │  virtual camera: 2.5D parallax + Ken Burns push    camera.ShotCamera
   │  composite  ✦ feather ✦ light-wrap ✦ color-match ✦ contact-shadow   composite
   │  bake scene LUT + mux dialogue audio → segment.mp4  grade + ffio.SegmentWriter
   ▼  (per shot)
stitch: cut = concat, else xfade + acrossfade           assemble.stitch
   ▼
cut.mp4  (graded, cinematic)
```

| Stage | Module | Notes |
|---|---|---|
| Matte | `matte.py` | RVM (torch, GPU). `FakeMatte` = torch-free stand-in for CPU testing. |
| Composite | `composite.py` | numpy/OpenCV, sub-10ms/frame, CPU. Uses RVM `fgr` (no edge spill). |
| Virtual camera | `camera.py` | Multiplane parallax (FG/BG at different rates) + eased Ken Burns. |
| Grade | `grade.py` | Generates `.cube` LUTs per look (Neutral/Noir/Sci-Fi/Golden/Thriller). |
| Backgrounds | `backgrounds.py` | Local still, solid color, or a `prompt` fetched from the perception `/background`. |
| Decode/encode | `ffio.py` | ffmpeg/ffprobe only — no imageio/moviepy. |
| Assembly | `assemble.py` | ffmpeg `concat`/`xfade`+`acrossfade`, timebase-normalized. |
| EDL | `edl.py` | Typed contract from the director agent; clamps to the renderer's vocab. |

## Install

Requires **ffmpeg + ffprobe on PATH**. Then:

```bash
pip install -r render/requirements.txt   # numpy, opencv, torch, torchvision
```

Only `numpy` + `opencv` are needed for the composite/camera/grade/assembly path
(CPU). `torch`/`torchvision` are needed only for the real RVM matte (install the
CUDA build for your driver); RVM weights download from `torch.hub` on first run.

## Quickstart

```bash
cd backend

# 1) torch-free end-to-end smoke test — synthesizes a clip, uses FakeMatte,
#    exercises composite → camera → grade → transitions → audio → mp4.
python -m render.cli selfcheck --out /tmp/cut_selfcheck.mp4

# 2) real render (needs torch + GPU for RVM):
python -m render.cli render --clip take.mp4 --edl render/examples/edl.example.json --out cut.mp4

# 3) same, but force FakeMatte (no GPU) to preview the edit/look/motion:
python -m render.cli render --clip take.mp4 --edl render/examples/edl.example.json --out cut.mp4 --fake

# unit tests (torch-free spine):
python -m unittest render.tests.test_render -v
```

## HTTP service

```bash
CUT_FAKE_MATTE=1 python -m render.server         # :9100 (drop CUT_FAKE_MATTE for real RVM)

curl -s localhost:9100/render -d '{"clip":"take.mp4","edl":{ ...EDL... }}'   # -> {"job_id":"..."}
curl -s localhost:9100/jobs/<id>                                             # -> {"status":"done","out":...}
curl -s localhost:9100/jobs/<id>/download -o cut.mp4
```

`clip` may be a local path or an `http(s)://` URL (downloaded first). Renders run
in a background thread and are serialized (RVM carries recurrent state).

### Env

| Var | Meaning |
|---|---|
| `CUT_DEVICE` | force `cuda`\|`mps`\|`cpu` (default: best available) |
| `CUT_FAKE_MATTE` | `1` → use FakeMatte (server) |
| `CUT_RVM_VARIANT` | `mobilenetv3` (default) or `resnet50` |
| `BG_SERVICE_URL` | perception service base URL for `{"prompt": ...}` backgrounds |
| `CUT_BG_CACHE` | disk cache dir for fetched backgrounds |
| `CUT_OUT_DIR` | server working/output dir |

## EDL

One `Shot` per directorial decision (times in **source** seconds, in order,
contiguous). See [`examples/edl.example.json`](examples/edl.example.json).

```jsonc
{
  "id": "s2", "start": 3.0, "end": 6.2,
  "shot": "MCU",             // WIDE|MS|MCU|CU|OTS   (base framing / zoom)
  "subject": "A",            // A=left, B=right, both, none  (frames the speaker)
  "look": "Thriller",        // Neutral|Noir|Sci-Fi|Golden|Thriller  (scene grade)
  "transition_in": "cut",    // cut|fade|dissolve|wipeleft|wiperight|circleopen
  "transition_dur": 0.4,     // seconds (ignored for cut)
  "move": "push",            // optional: push|static|pan_left|pan_right
  "background": { "prompt": "dim interrogation room" },  // or {"file":..} / {"color":[r,g,b]}
  "note": "push on A as the tone turns"
}
```

The renderer clamps unknown enum values to safe defaults and maps the perception
agent's vocabulary (`closeup`→`CU`, `noir`→`Noir`, …) so a director-produced read
drops straight in.

## Bridge: from a live audition take

The EDL is the shared "final clip" contract, so the browser's live lane now feeds this batch lane
directly — no hand-authored JSON. When you **Stop** an audition take, `web/lib/edl.ts:takeToEdl`
turns its recorded cue track into an EDL (co-star speech spans → `MCU`/subject `B`, the actor gaps →
`MS`/subject `A`, tiled contiguous over the take), and **Render film** ships it here:

```
Audition take (webm)                 web/lib/audition/engine.ts
   │  cues → takeToEdl()             web/lib/edl.ts   (TS mirror of edl.py)
   │  POST /upload  (webm → OSS)     backend/api/app.py   → presigned url
   ▼
POST /render { edl, clip: url } ──►  this service  ──►  graded cut.mp4
```

Because the recorder **pauses during "thinking"**, the take's timeline is shorter than wall-clock;
the engine stamps cues in *recorded-media* seconds so each shot's `[start,end]` lines up with the
webm this service slices. `web/lib/edl.ts` is the TS mirror of `edl.py` — keep the two vocabularies
(shots / subjects / looks / transitions) in lock-step. The round-trip contract is asserted by
`tests/test_edl_bridge.py` against `examples/audition_edl.example.json`.

Set `NEXT_PUBLIC_RENDER_URL` in the web app to this service's base URL (e.g. `http://localhost:9100`
in dev) to light up the **Render film** action; leave it empty and the action stays hidden.

## Deployment

The real matte needs **torch + a GPU** — this service belongs on a GPU instance,
**not** the scale-to-zero perception function in [`../code`](../code). The
`prompt` background path calls that perception service's `/background`, so the two
compose: perception generates environment stills, the render service composites
onto them.
