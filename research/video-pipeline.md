# "Cut!" — Video Processing Pipeline Research

**Goal:** Take live two-person improv footage → matte the performers off their real background (no green screen) → composite onto an AI-generated environment → apply cinematic virtual camera moves → auto-edit into a cut → mix dialogue + generated score.

**Constraint:** 9-day build, single GPU, near-real-time (live preview + slightly-delayed final render).

**Date:** 2026-07-11

---

## TL;DR — Recommended Stack

| Stage | Pick | Why |
|---|---|---|
| **Matting** | **Robust Video Matting (RVM)** | Trimap-free, temporally stable, real-time (HD 104 fps / 4K 76 fps on a *1080 Ti*), 3-line PyTorch API. No green screen, no background plate. |
| **Hero-quality matte (offline)** | BiRefNet-HR-matting | Best hair/edge alpha for the final render's key shots; too slow for live (~17 fps @1024²). |
| **Compositing** | OpenCV (premultiplied alpha + light-wrap + Reinhard color transfer) | Cheap, full control, sub-10 ms/frame. |
| **Compositing realism (offline)** | Harmonizer | Image-level color harmonization, 56 fps @1080p, video-consistent. |
| **Virtual camera** | **Multiplane 2.5D parallax** (we already have FG/BG layers separated) **+ Ken Burns push-ins** | Nearly free, reads as a real dolly/crane. Optional Depth-Anything-V2 for in-background parallax. |
| **Depth (optional)** | Depth-Anything-V2 | Fast monocular depth for background parallax and layer ordering. |
| **Shot/scene detect** | PySceneDetect (AdaptiveDetector) | For splitting any pre-recorded source; robust to camera motion. |
| **Edit assembly** | ffmpeg `filter_complex` (concat + `xfade` + `lut3d`) with MoviePy for higher-level comp | Deterministic, scriptable EDL → render. |
| **Color grade** | 3D LUT via ffmpeg `lut3d=grade.cube` | Instant "film look," one filter. |
| **Score** | MusicGen (AudioCraft) or royalty-free library | Text-prompt a cue per scene; duck under dialogue with ffmpeg `sidechaincompress`. |

**Feasibility verdict:** Live *preview* at 512–720p on one modern GPU (RTX 4090-class) is realistic. The "cinematic" final is a **render pass measured in seconds per shot, and the single dominant cost is generating the AI backgrounds — not matting or compositing.** Keep backgrounds as pre-generated stills (or a fast image model) and 9 days is achievable. Treat true frame-locked real-time as preview-only.

---

## 1. Human Video Matting / Segmentation (no green screen)

The core problem: produce a per-pixel **soft alpha** (not just a binary mask) for two moving humans, temporally stable (no edge flicker), against an arbitrary real room.

### Comparison

| Model | Output | Quality | Speed | GPU | Python | Verdict for "Cut!" |
|---|---|---|---|---|---|---|
| **RVM** (ByteDance) | Soft alpha + FG, **temporal (recurrent)** | Very good on humans, stable edges, some hair softness | **HD 104 fps, 4K 76 fps @ 1080 Ti**; faster FP16 on Turing+ | Runs on modest GPUs; ~1–2 GB | Trivial (`torch.hub.load`) | **PRIMARY.** Built exactly for this. |
| **BiRefNet** / BiRefNet-HR-matting | Soft alpha (HR-matting variant), **per-frame** | **Best edges** (hair/fur), highest fidelity | ~17 fps @1024², 3.45 GB on RTX 4090 (FP16) | Needs a real GPU | Easy (HF `transformers` / repo) | **Offline hero pass only** — no temporal model → flickers on video unless you add smoothing. |
| **SAM 2** (Meta) | **Binary** mask, video memory, prompt-driven | Excellent *object* masks, not alpha; hard edges, no hair softness | 30–44 fps @A100 (Hiera-L/B+) | Needs strong GPU | Easy (official pkg) | Use only if you need *interactive selection* / rotoscoping — not for clean alpha compositing. |
| **MODNet** | Soft alpha, per-frame (has SOC video trick) | Good, but RVM supersedes it | 67 fps @1080 Ti | Light (MobileNetV2) | Easy | Skip — RVM is strictly better. |
| **BackgroundMattingV2** | Soft alpha | Excellent **but requires a clean background plate** | 4K 30+ fps | Moderate | Easy | Skip — needs a still of the empty set; brittle to any camera move/lighting shift. |
| Green screen (chroma key) | Alpha via `ffmpeg colorkey`/`chromakey`, OBS | Great if you have the physical screen | Free/real-time | None | Trivial | Fallback if a physical screen is available; the brief says *no* screen. |

### Recommendation: **RVM primary, BiRefNet for the final "hero" pass**

RVM is purpose-built: recurrent temporal memory gives frame-to-frame stability (the #1 failure mode of per-frame models is edge crawl), it's trimap-free (no user input), and it hits real-time at HD on a *5-year-old* GPU — huge headroom on a 4090. For the offline final render of close-up shots where hair matters, re-matte just those shots with BiRefNet-HR-matting and temporally smooth the alpha (EMA across frames, or guided filter with the RVM alpha as prior).

### Minimal RVM sketch
```python
import torch
model = torch.hub.load("PeterL1n/RobustVideoMatting", "mobilenetv3").cuda().eval()
rec = [None] * 4                        # recurrent state (temporal memory)
downsample = 0.25                       # 0.25 for HD, 0.125 for 4K

with torch.no_grad():
    for frame in frames:                # frame: [1,3,H,W] float in 0..1, on cuda
        fgr, pha, *rec = model(frame, *rec, downsample)
        # pha = soft alpha [1,1,H,W]; fgr = estimated foreground color
        composite = fgr * pha + bg * (1 - pha)
```
Use the `mobilenetv3` variant for speed; `resnet50` for a touch more quality offline. ONNX/TensorRT exports exist for extra throughput.

**Key gotchas:** feed frames sequentially (never shuffle — you'd lose temporal memory); keep `downsample_ratio` tuned to resolution; RVM estimates FG color too (use `fgr`, not the raw camera pixels, to avoid green/color spill at edges).

---

## 2. Compositing onto a Generated Background

Matte quality is necessary but not sufficient — a good alpha over a mismatched background still screams "cutout." The realism wins are, in order of impact: **(a) color/luminance match, (b) edge treatment (feather + light wrap), (c) contact shadow, (d) grain/optics match.**

### Techniques
1. **Premultiplied-alpha over** using RVM's estimated FG (`fgr`) to kill spill:
   `out = fgr*pha + bg*(1-pha)`.
2. **Edge feather + erode:** erode the alpha 1–2 px then Gaussian-blur the alpha edge so there's no hard 1-px rim. Cheap, massive perceived-quality gain.
3. **Light wrap:** bleed a blurred version of the *background* onto the FG edges (`wrap = blur(bg) * edge_band`), so the subject picks up ambient environment light. This is the single most convincing cheap trick.
4. **Color matching:** Reinhard mean/std transfer in Lab space, or `skimage.exposure.match_histograms`, to push FG color stats toward the BG. Do it *gently* (blend 40–70%) or faces go wrong.
5. **Contact/cast shadow (fake but sells it):** take the alpha, offset + skew it toward the light direction, blur heavily, multiply darken onto the BG before compositing the FG. No physics required.
6. **Grain & optics:** apply the same LUT + a touch of shared noise/blur to FG and BG so they share a "lens."

### Libraries
- **OpenCV** — the workhorse for per-pixel alpha ops, blurs, color-space transforms, warps. Sub-10 ms/frame at 1080p.
- **ffmpeg** — final encode, `overlay`, `colorkey`/`chromakey` if green screen, `lut3d`.
- **MoviePy (v2.x, 2025 rewrite)** — higher-level `CompositeVideoClip` when you want layers/timelines in Python rather than a filtergraph. Good for the edit assembly, not for per-frame heavy math.
- **Pillow** — simple raster/text/title overlays.
- **Harmonizer** (offline realism upgrade) — learned image harmonization; outputs image-level adjustment args, **56 fps @1080p**, temporally consistent across frames. Drop-in "make the FG belong to this BG" pass for the final render.

### Compositing sketch (OpenCV)
```python
import cv2, numpy as np

def composite(fgr, pha, bg):                 # all HxWx3 float 0..1, pha HxW
    # 1) edge feather
    a = cv2.erode(pha, np.ones((3,3), np.uint8))
    a = cv2.GaussianBlur(a, (0,0), 1.2)[..., None]

    # 2) light wrap: bg light bleeds onto subject edge
    edge = cv2.GaussianBlur(a, (0,0), 6) - a
    wrap = cv2.GaussianBlur(bg, (0,0), 8) * np.clip(edge, 0, 1)

    # 3) gentle color match (Reinhard in Lab), blended
    fgr = 0.6*reinhard(fgr, bg, mask=a[...,0]) + 0.4*fgr

    # 4) fake contact shadow
    sh = cv2.GaussianBlur(np.roll(a[...,0], (12,8), (0,1)), (0,0), 9)
    bg = bg * (1 - 0.35*sh[...,None])

    return (fgr + wrap) * a + bg * (1 - a)
```
(`reinhard()` = convert both to Lab, shift/scale FG channels to BG mean/std within the mask, convert back.)

---

## 3. Virtual Camera from a Static Shot

You have a single locked-off two-shot. To make it "cinematic," synthesize camera *motion*. Ranked by cost/payoff:

### A. Ken Burns (crop/pan/zoom) — nearly free, do this first
Composite at higher resolution than the output (e.g. render 1.4×), then animate an output crop rectangle over time: slow push-in, drift-pan, tilt-reveal. Ease with a smooth curve (ease-in-out), never linear. This alone gives punch-ins on the speaking performer and slow pushes that read as intentional coverage. Cost: a `cv2.warpAffine`/resize per frame (~2–5 ms).

### B. Multiplane 2.5D parallax — *free because you already matted the layers* ⭐
This is the key insight for "Cut!": **matting already split the scene into FG (performers) and BG (generated environment).** Move them at *different* rates during a Ken Burns move and you get real parallax — the depth cue the brain reads as a physical camera. Two layers already look 3D. Add mid-ground props as extra planes for more. Cost: same as Ken Burns, one warp per plane.

### C. Depth-based parallax (Depth-Anything-V2) — for in-background depth
If you want the *generated background itself* to have internal parallax (not just FG-vs-BG), run monocular depth on the BG once, then displace pixels by `depth × camera_translation`. Fill small disocclusions by inpainting or by simply limiting move magnitude. Depth-Anything-V2 is fast and robust. Cost: one-time depth (~30–60 ms) + a per-frame grid warp (~10–20 ms).

### D. Full 3D Ken Burns (Niklaus et al., 2019) — highest quality, heaviest
Depth → point cloud → render from a moving virtual camera → context-aware color+depth **inpainting** of disocclusions. Produces true dolly/crane moves from one image. It's the gold standard but the inpainting makes it a per-shot offline render, and it's more integration than a 9-day build wants. Use only if B/C aren't cinematic enough. Reference implementation: `sniklaus/3d-ken-burns`.

### Stabilization
Your source is a static tripod shot, so there's little to stabilize — but if handheld, use `vidstab` (ffmpeg `vidstabdetect`/`vidstabtransform`) or OpenCV feature-tracking + smoothed affine *before* matting. Also: keep virtual moves gentle; sub-pixel jitter on the crop rectangle is the usual culprit, so smooth the crop path with an EMA.

**Recommendation:** Ship **B (multiplane parallax) + A (Ken Burns easing)** as the default look — it's essentially free given your architecture and reads as cinematic. Add **C (Depth-Anything)** as a stretch for hero shots. Skip D unless you have slack.

### Parallax sketch
```python
# fg_layer (RGBA composite of performers), bg_layer (generated env), both oversized
def virtual_dolly(t):                       # t: 0..1 over the shot
    push  = 1.0 + 0.06*ease(t)              # slow push-in
    bg_tx = 40*ease(t); fg_tx = 12*ease(t)  # bg moves MORE slowly than fg → parallax
    bg = translate_scale(bg_layer, bg_tx, push*0.98)
    fg = translate_scale(fg_layer, fg_tx, push)
    return over(fg, bg)                      # alpha-over, then center-crop to output
```

---

## 4. Automatic Shot/Scene-Cut Detection & Edit Assembly

Two different jobs here:

### (a) Detecting cuts in *source* footage — PySceneDetect
If footage arrives as one long take (typical for improv), there are no cuts to detect — instead you *create* them (see (b)). But if you ingest multi-clip or pre-edited source, use PySceneDetect:
- `ContentDetector` — HSV content change, catches hard cuts.
- **`AdaptiveDetector`** — rolling-average of content deltas; **robust to fast camera motion** (fewer false positives). Preferred.
- `ThresholdDetector` — fades to/from black.

```python
from scenedetect import detect, AdaptiveDetector, split_video_ffmpeg
scenes = detect("take.mp4", AdaptiveDetector())
split_video_ffmpeg("take.mp4", scenes)      # writes one file per scene
```

### (b) *Generating* the edit (the real work for "Cut!")
For a two-person improv take, "editing" = choosing framing over time: wide two-shot → punch-in on speaker A → reaction cut to B → back to wide. Drive it from **audio**: detect who's speaking (energy per mic, or diarization) and cut the virtual camera to the active speaker, with rhythm rules (min shot length ~1.5 s, avoid cutting mid-word, insert reaction shots).

Produce an **EDL** (list of `{start, end, shot_type, framing, transition}`), then render each segment from the master composite using the virtual-camera crop for that shot type, and stitch.

### (c) Assembly: EDL → rendered video
Deterministic path is **ffmpeg `filter_complex`**:
- Concatenate shots: `concat` filter.
- Transitions: **`xfade`** (30+ types: `fade`, `dissolve`, `wipeleft`, `circleopen`, …) with `duration` + `offset`; hard cuts are just concatenation.
- Color grade: **`lut3d=grade.cube`** — one filter applies a film-look 3D LUT to everything for consistency.

```bash
# crossfade two shots then grade the result
ffmpeg -i shotA.mp4 -i shotB.mp4 -filter_complex \
 "[0][1]xfade=transition=fade:duration=0.4:offset=3.6,format=yuv420p,lut3d=grade.cube[v]" \
 -map "[v]" out.mp4
```
For programmatic, layered edits (titles, per-shot effects, audio beds) MoviePy v2 is more ergonomic than hand-writing a giant filtergraph:
```python
from moviepy import VideoFileClip, concatenate_videoclips, CompositeVideoClip
clips = [VideoFileClip(s.path).subclipped(s.a, s.b).with_effects([...]) for s in edl]
final = concatenate_videoclips(clips, method="compose")
final.write_videofile("cut.mp4", codec="libx264", audio_codec="aac")
```
**Recommendation:** MoviePy for assembling the timeline + titles; shell out to ffmpeg for `xfade` transitions and the final `lut3d` grade + encode (faster, more transition options). Keep the EDL as JSON so the edit is re-renderable and tweakable.

**Auto color grade:** ship a few `.cube` LUTs (teal-orange, warm film, cool night) and pick per generated-environment mood; optionally auto-white-balance first with OpenCV before the LUT.

---

## 5. Audio: Dialogue, Sync, Score, Sound Design

- **Capture:** record dialogue to the master audio track alongside video (ideally lav/shotgun mics per performer → cleaner speaker separation for auto-editing). Keep it as the spine of the timeline.
- **Sync:** because it's a single continuous take, audio is already frame-synced to the source. Preserve source timecodes through the EDL so every virtual-camera cut lands on the right audio. If mics and camera are separate devices, align once by cross-correlation (`scipy.signal.correlate`) on a clap/onset.
- **Speaker activity (drives the auto-edit):** per-mic energy is the cheap route; `pyannote.audio` diarization if you have one shared mic. Feed this to the shot chooser in §4b.
- **Score:** generate a cue per scene with **MusicGen (Meta AudioCraft)** from a text prompt ("tense sparse piano, 90 bpm"), or pull from a royalty-free library (Mubert/OpenMusic/local pack) if you want to skip GPU time. AudioCraft is a PyTorch lib — a few lines to a wav.
- **Mix / ducking:** sidechain-compress the music under dialogue so speech stays intelligible:
  ```bash
  ffmpeg -i music.wav -i dialogue.wav -filter_complex \
   "[0][1]sidechaincompress=threshold=0.03:ratio=8:attack=20:release=300[m]; \
    [m][1]amix=inputs=2:duration=longest" mix.wav
  ```
- **Simple sound design:** trigger a whoosh on `xfade` transitions and a soft riser under push-ins — a small SFX pack + place-on-transition logic. All schedulable from the EDL with ffmpeg `adelay`/`amix`.

### MusicGen sketch
```python
from audiocraft.models import MusicGen
m = MusicGen.get_pretrained("facebook/musicgen-small")   # small = fast
m.set_generation_params(duration=20)
wav = m.generate(["moody cinematic underscore, sparse strings"])
```

---

## 6. Feasibility & Honest Latency Budget

**Two-tier design** — the only sane way to hit "near-real-time":
- **Live preview:** low-res (512–720p), RVM + cheap OpenCV composite + Ken Burns/parallax + pre-generated still background. Runs interactively.
- **Final render:** full-res, BiRefNet hero mattes + Harmonizer + depth parallax + LUT grade + music mix. A background job, seconds per shot.

### Per-frame latency budget (single RTX 4090-class GPU, 1080p unless noted)

| Stage | Live preview (512–720p) | Final render (1080p+) | Notes |
|---|---|---|---|
| Capture / decode | 2–5 ms | 2–5 ms | |
| **Matting** | RVM ~8–15 ms | RVM ~15–25 ms / BiRefNet ~60 ms | RVM has huge headroom; BiRefNet only for hero shots |
| **Background** | **~0 ms** (pre-gen still) | **0 ms still — or 100 ms–many s if diffusing per frame** | ⚠️ **The real cost. Live diffusion of BG is NOT real-time.** |
| Compositing (OpenCV + light wrap + color) | 3–8 ms | 5–12 ms | |
| Harmonization (Harmonizer) | skip | ~18 ms (56 fps) | offline only |
| Virtual camera (Ken Burns / multiplane) | 2–5 ms | 5–10 ms | parallax is ~free (layers already split) |
| Depth parallax (Depth-Anything) | skip | one-time 30–60 ms + 10–20 ms/frame | hero shots only |
| Encode | 5–10 ms | 8–15 ms | NVENC keeps this cheap |
| Edit/shot decisions | offline | offline | per-frame negligible |
| **Per-frame total** | **~25–45 ms → 22–30 fps** | **~60–120 ms (excl. BG gen) → offline** | |

### Verdict
- **Live preview: YES.** RVM + OpenCV composite + parallax at 512–720p over a *pre-generated* background comfortably hits 20–30 fps on one modern GPU. Matting and compositing are cheap and solved.
- **Final "cinematic" render: YES, as a slightly-delayed pass** measured in **seconds per shot**, dominated entirely by whatever you use for AI backgrounds and the optional harmonization/depth passes.
- **The honest risk is not in this pipeline — it's background generation.** If "AI-generated background" means diffusing novel video per frame, that blows the real-time budget by orders of magnitude and is the thing to descope. Mitigation for 9 days: **pre-generate background environments as high-res stills (or short loops) up front**, use them as static plates, and let multiplane/depth parallax supply the motion. That keeps per-frame background cost at ~0 and makes the whole thing tractable.
- **9-day plan sanity:** Days 1–2 RVM matting + OpenCV composite loop; Days 3–4 multiplane parallax + Ken Burns + LUT grade; Days 5–6 audio-driven auto-edit + EDL→ffmpeg assembly; Day 7 music/mix/SFX; Days 8–9 the BiRefNet+Harmonizer hero-render path and polish. Everything on the critical path has a mature, pip-installable library.

---

## Sources
- Robust Video Matting — https://github.com/PeterL1n/RobustVideoMatting ; paper https://arxiv.org/abs/2108.11515
- SAM 2 — https://arxiv.org/abs/2408.00714 ; https://docs.ultralytics.com/models/sam-2 ; https://blog.roboflow.com/what-is-segment-anything-2/
- BiRefNet — https://github.com/ZhengPeng7/BiRefNet ; https://z.tools/blog/birefnet-background-removal-series ; https://blog.cloudflare.com/background-removal/
- MODNet — https://github.com/ZHKKKe/MODNet ; https://arxiv.org/abs/2011.11961
- BackgroundMattingV2 — https://arxiv.org/pdf/2108.11515 (RVM paper, comparisons)
- Image/Video Harmonization — Harmonizer & Deep Image Harmonization https://arxiv.org/abs/1703.00069 ; PCT-Net https://www.researchgate.net/publication/373318093 ; Deep Video Harmonization https://arxiv.org/pdf/2205.00687
- OpenCV color correction — https://pyimagesearch.com/2021/02/15/automatic-color-correction-with-opencv-and-python/
- Shadow harmonization — https://dl.acm.org/doi/10.1145/3610548.3618227
- 3D Ken Burns — https://arxiv.org/abs/1909.05483 ; https://sniklaus.com/kenburns
- PySceneDetect — https://www.scenedetect.com/ ; API https://www.scenedetect.com/api/ ; detectors https://www.scenedetect.com/docs/latest/api/detectors.html
- ffmpeg LUT / xfade — https://www.jeffgeerling.com/blog/2026/apply-lut-color-grade-with-ffmpeg/ ; https://ottverse.com/crossfade-between-videos-ffmpeg-xfade-filter/ ; https://ffmpeg.org/ffmpeg-filters.html
- MoviePy — https://github.com/zulko/moviepy ; https://pypi.org/project/moviepy/
- MusicGen / AudioCraft — https://audiocraft.metademolab.com/musicgen.html
