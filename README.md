# Cut!

> Two people improvise in front of a camera. An AI director turns it into a cinematic film — live.

**Track:** AI Showrunner (Track 2 — highest token allowance)
**Built on:** Qwen Cloud (Qwen3-VL + Qwen3-Max reasoning + Wan/image generation + Paraformer ASR, via Alibaba Cloud Model Studio / DashScope)

*Working name — "Cut!" (the director's call). Alt: "Riff." This spec is backed by five research briefs in [`/research`](./research): Wan video-gen feasibility, the video pipeline, the director agent, the competitive landscape, and Alibaba Cloud deployment.*

---

## The Idea

Give two people a camera and no script. They improvise. **Cut!** watches the raw performance, *understands the scene* — who's talking, the emotional beat, when the story shifts location — and autonomously **directs and edits it into a cinematic short**: compositing them into generated environments, cutting between shots, moving the camera, grading the color, scoring the music.

It's the **Showrunner inverted.** Everyone else generates video *from a script*. Cut! takes *live human performance* as raw material and does the job of the director, cinematographer, and editor. The hero isn't a video model — it's an **AI filmmaker's brain** making reactive creative calls in real time.

> **The pitch:** "We didn't write a script. They just played. The AI directed the movie."

---

## The White Space (why this is winnable)

Research confirms every *component* exists somewhere, but the **integration is unclaimed**:

- **Wonder Dynamics / Autodesk Flow Studio** — the closest product — is *batch*, *replaces* the actor with a required pre-made CG character, and does **zero creative direction or editing** (Autodesk explicitly leaves the creative work to a human artist).
- Every "AI director" (FilmAgent, MovieAgent, LTX Studio) plans from a **script**. Every performer-compositor (Runway Act-Two, Viggle) **doesn't direct or edit**. Auto-editors (Descript, Gling) optimize for *efficiency*, not *cinematic mood*.
- Live auto-direction of a performance exists **only in research** (Virtual Cinematographer, GAZED, ShotDirector) — unproductized.

**Nobody does live, unscripted improv → AI-directed-and-edited cinematic film.** Three differentiators:

1. **Improv-native, script-free direction** — direct *reactively* from live scene understanding of an unpredictable performance. This is the moat (and the hard part), not the compositing.
2. **Preserve real performers, generate the world around them** — the software-only inverse of an LED volume: virtual-production output with no stage, crew, CG-character pipeline, or script.
3. **End-to-end autonomy to a *finished film*** — owning the creative-decision layer every incumbent leaves to a human.

*(The likely fast-follower is Runway — so we concentrate the moat on the reactive director/editor brain and use the improv/live framing as the wedge.)*

---

## What's Real vs. Generated (the honest core)

The real performers are always the hero footage; generation is reserved for the zones the models are genuinely good at.

| Real (captured / reasoned) | Generated (synthesized) |
|---|---|
| The two performers + their dialogue | Backgrounds & environments (image-gen stills + parallax) |
| Autonomous shot / cut / mood / scene decisions — **the agent brain** | Establishing shots, cutaways, B-roll (Wan video, post pass) |
| Virtual camera moves on real footage (2.5D parallax) | Color grade, transitions, musical score |
| Scene-switch & emotion detection (Qwen3-VL + ASR) | **Never:** the actors' faces re-rendered from new angles |

**Three honest reframes — all confirmed by research:**

1. **Two-tier rendering — image-gen is the live lane, Wan video is the post lane.** Wan video is 1–5 min/clip, async, only 2–5 concurrent jobs — *not* live-syncable. Image generation is ~10–30s, synchronous, ~$0.03/img.
   - **LIVE tier (seconds):** RVM matting → composite performers onto **image-generated backgrounds** → 2.5D parallax camera → real-time preview (~22–30 fps on one GPU). The world-swapping happens live.
   - **CINEMATIC tier (minutes behind):** Wan generates establishing shots, cutaways, and B-roll for the final cut. *"The film drops minutes after the scene."*
2. **"Change perspective" = virtual camera + generated cutaways, not re-shot actors.** Keep performers as hero footage; fake angles with 2.5D parallax; generate *everything except the actors*. Looks multi-angle, stays honest — and never breaks the performers' identity.
3. **Pre-generate a shot/environment library.** Diffusing novel backgrounds *per frame* blows the budget by orders of magnitude — the one real risk. Mitigation: generate environments as high-res **stills/loops** ahead of time and let **parallax supply the motion** (per-frame background cost ≈ 0). The live director *selects and cuts* against the library, reserving fresh generation for the unexpected.

---

## How It Works — The Director's Room

Two decoupled clocks: a **fast perception loop** keeps a rolling world-state; a **decision loop** only fires on beats and scene boundaries.

```
  Two people improv (camera + mic), streamed in beats
        │
        ├─▶ PERCEPTION LOOP (every 2–4s) ─────────────────────────┐
        │     Qwen3-VL (frames) + Paraformer ASR (streaming,       │  rolling
        │     word-timestamped) → who / emotion / action /         │  world-state
        │     setting / scene-switch                                │
        │                                                           ▼
        └─▶ DECISION LOOP (LangGraph, fires on beat/boundary) ◀─────┘
                 DIRECTOR (qwen3-max) — intent, continuity, axis-state,
                            scene-vs-beat classification (hysteresis)
                        │  propose → debate → director judges (FilmAgent pattern)
                 CINEMATOGRAPHER (qwen3-vl-plus, *sees* frames) — shot size/
                            angle/movement, enforces camera_side (180° rule)
                 EDITOR (qwen3-max) — cut timing snapped to ASR timestamps,
                            transition, grade, music cue
                        ▼
                 EDIT DECISION LIST (typed JSON, one shot-object per decision)
                        ▼
  RENDERER  matting (RVM) → composite → 2.5D parallax camera →
            image-gen backgrounds (live) / Wan cutaways (post) →
            grade (LUT) + score (MusicGen, ducked) → assemble (ffmpeg)
                        ▼
  Live preview  +  cinematic cut (minutes behind)
```

Example reactive calls the Director makes from watching the performance:
- *"Tone just turned tense — cut faster, desaturate, push in."*
- *"They've walked into a spaceship — new scene: reset the axis, generate the bridge, establish with a wide."*
- *"That was the emotional beat — hold on a close-up, let it breathe."*

**Scene vs. beat matters:** a *scene* change triggers an establishing shot, a grade/music reset, and a 180°-axis reset; a *beat* triggers ordinary coverage cuts. The 180° rule (`camera_side`) is stored as **state**, not left to vibes.

---

## The Agent Roster

| Agent | Role | Model / tool |
|---|---|---|
| **Perception** | Per-beat visual digest: who/emotion/action/scene | `qwen3-vl-flash` (cheap, every beat) |
| **ASR** | Streaming dialogue transcript with word/sentence timestamps | `paraformer-realtime-v2` (WebSocket) |
| **Director** | Intent, continuity, axis-state, scene-vs-beat, judges the debate | `qwen3-max` |
| **Cinematographer** | Shot size/angle/movement; *sees* frames; enforces `camera_side` | `qwen3-vl-plus` |
| **Editor** | Cut timing (snapped to ASR), transition, grade, music | `qwen3-max` |
| **Renderer** | Matting, composite, parallax, image/Wan gen, assembly | RVM + OpenCV + ffmpeg + Wan/image |

*(Model IDs are the Qwen3 generation confirmed in research; verify exact aliases near demo day — the family moves fast. Free tier: 1M tokens/model + video-seconds, 90 days, Singapore endpoint.)*

---

## The Edit Decision List (the compression layer)

The agents reason over a compact typed **EDL** — not raw frames — which the renderer consumes. One shot-object per decision:

```jsonc
{
  "timecode":    { "cut_in": 12.40, "cut_out": 15.10, "hold_min": 1.2 },
  "framing":     { "shot_size": "CU", "angle": "eye", "movement": "push_in",
                   "subject": "actor_A", "camera_side": "left", "headroom": "tight" },
  "environment": { "background_prompt": "noir interrogation room, single lamp",
                   "continuity_key": "scene_03_interrogation" },
  "transition":  "hard_cut",
  "grade":       "desaturated_cool",
  "audio":       { "music_cue": "tension_rise", "action": "duck_under_dialogue" },
  "intent":      { "director_note": "tension turn", "valence": "negative",
                   "pacing": "accelerating", "confidence": 0.82 },
  "provenance":  { "transcript_span": [42, 48], "vl_ref": "beat_017" }
}
```

`confidence` is **model-emitted** (DashScope compat mode returns null logprobs, confirmed by two agents), and `continuity_key` lets the renderer reuse a generated environment across a whole scene — the token/compute economy that satisfies Track 2's "quality under a limited budget."

---

## Efficient & Creative Qwen Usage (the judging core)

- **Two-tier generation:** fast image-gen (`wan2.6-t2i` / `qwen-image`, ~10–30s) for live backgrounds; Wan video (`wan2.7-t2v/i2v`, `happyhorse`) reserved for the post-render cinematic layer.
- **Tiered VL cascade:** `qwen3-vl-flash` for the every-beat digest (cents), `qwen3-vl-plus` only for the Cinematographer's "deep looks," `qwen3-max` for the hard directorial reasoning.
- **Multimodal orchestration:** vision (Qwen3-VL) + streaming speech (Paraformer) + reasoning (Qwen3-Max) + generation (Wan/image) as one director's mind.
- **The EDL + `continuity_key`** compress the problem: reason over decisions, reuse environments per scene, regenerate only on scene-switch.

---

## Architecture

**All GPU-heavy work is a cloud API (Qwen/Wan/Paraformer on Alibaba's GPUs) or runs client-side. No GPU on our own backend.**

```
  Browser (capture + MediaPipe matting + composite + parallax = live preview)
        │  chunked HTTP: raw beats + EDL requests
        ▼
  FastAPI on CPU ECS / Function Compute (Singapore)  ── the orchestrator
        │
        ├─▶ DashScope APIs:  Qwen3-VL / Qwen3-Max (director's room) ·
        │                    Paraformer (ASR) · Wan + image-gen (the world)
        ├─▶ OSS:             raw + rendered clips; copy 24h Wan URLs here immediately
        └─▶ Tablestore:      EDL store (reused from Hearth — no new DB)
        │
        ▼  LangGraph director's-room graph → EDL
  Live preview (client)  +  final cinematic cut (Wan post-pass, minutes behind)
```

- **Compute:** a small **CPU** box — ECS or Function Compute in Singapore — running FastAPI + LangGraph. **No GPU quota needed:** all heavy generation is DashScope, and matting/compositing runs **in-browser (MediaPipe)** for the live preview or **locally** (RVM on Apple Silicon / any GPU) for the higher-quality final render.
- **Orchestration:** LangGraph (cyclic graph, conditional edges for the debate loop), Qwen via DashScope OpenAI-compatible endpoint (`https://dashscope-intl.aliyuncs.com/compatible-mode/v1`).
- **✅ Model access already verified** on the workspace key: all Qwen3/VL text+vision models and Wan/HappyHorse video generation return live. **Day-1 action reduced to:** create the OSS bucket + point the CPU backend at the existing `QWEN_API_KEY` / `ALI_ACCESS_KEY_*` / Tablestore creds.

---

## Key Features

- 🎬 **Improv in → film out** — no script, no set, no crew.
- 🧠 **An AI that actually directs** — reactive shot, cut, mood, and scene-change decisions from watching you.
- 🌍 **Live world-swapping** — walk "into" a spaceship or a noir alley; the backdrop follows the story (image-gen + parallax, in seconds).
- 🎥 **Virtual cinematography** — close-ups, wides, push-ins conjured from a single camera via 2.5D parallax.
- 🎞️ **Auto-edit** — cut rhythm snapped to the dialogue, transitions, color grade, and a ducked score.
- ⚡ **Near-live** — a preview while you play, the cinematic cut minutes later.

---

## The 3-Minute Demo (shot list)

1. **Cold open (0:00–0:20):** two friends goofing in front of a blank wall. "No script. No set. Watch."
2. **The eye (0:20–0:50):** overlay Cut!'s perception — it labels the emotion, transcribes the line with timestamps, flags "new scene: interrogation room."
3. **The transformation (0:50–2:00):** split screen — left, the plain-wall improv; right, the same beat as a moody noir short: backdrop swaps, camera pushes in on the close-up, a generated wide establishes the room, the cut rhythm tightens as tension rises.
4. **The director's reasoning (2:00–2:30):** surface the Director agent's EDL calls in text — *"tension turn → desaturate, cut faster, push in (conf 0.82)"* — proving it's reasoning, not a filter.
5. **The reveal (2:30–3:00):** play the finished 30-second film straight through. "They just played. The AI made the movie." Running on Alibaba Cloud + Qwen + Wan.

---

## Why This Wins Track 2

- **Technical Depth (30%):** two-clock real-time multimodal perception, a debating director-agent society with axis-state continuity, RVM matting + 2.5D-parallax virtual camera, and a two-tier generation pipeline that respects real latency limits — a genuinely hard systems + creative build.
- **Innovation & AI Creativity (30%):** *inverting* the Showrunner (live performance → direction, not script → video) is confirmed white space; the reactive AI-director brain is the novel core.
- **Problem Value & Impact (25%):** collapses the cost of filmmaking — anyone with a webcam and two friends makes a short. Real creator-economy and pre-viz upside.
- **Presentation (15%):** the demo *is* the output — a plain-wall improv becoming a film is the most watchable 3 minutes in the competition.

---

## 9-Day Build Plan

- **Day 1:** ~~signup + GPU quota + confirm Wan~~ **✅ already done** (key + all Qwen3/VL + Wan verified). Create OSS bucket; stand up the CPU FastAPI box wired to the existing creds. Browser capture → MediaPipe matting on a still background (proves the live spine).
- **Day 2–3:** Perception loop (Qwen3-VL digest + Paraformer ASR) → rolling world-state; image-gen backgrounds + composite + 2.5D parallax live preview.
- **Day 4–5:** Director's room in LangGraph (Director/Cinematographer/Editor debate) → EDL; scene-vs-beat + 180° axis-state.
- **Day 6:** Cinematic post pass — Wan cutaways/establishers, LUT grade, MusicGen score with ducking, ffmpeg assembly.
- **Day 7:** pre-generated environment library + `continuity_key` reuse; polish the two-tier handoff.
- **Day 8:** frontend, live preview UI, the director-reasoning overlay; deploy + Alibaba Cloud proof file.
- **Day 9:** run real improv, record the 3-min video, architecture diagram, docs, license.

---

## Tech Stack

- **Models (DashScope, Singapore intl endpoint):** `qwen3-vl-flash` / `qwen3-vl-plus` (perception/DP), `qwen3-max` (director/editor), `paraformer-realtime-v2` (ASR), `wan2.6-t2i` / `qwen-image` (live backgrounds), `wan2.7-t2v` / `wan2.7-i2v` / `happyhorse` (post video).
- **Orchestration:** LangGraph via the OpenAI-compatible endpoint.
- **Video pipeline:** MediaPipe (in-browser live matting) / RVM (local final hero pass) + BiRefNet-HR · OpenCV compositing (light-wrap, color match, contact shadow) + Harmonizer (offline) · 2.5D multiplane parallax + Depth-Anything-V2 · PySceneDetect · ffmpeg `filter_complex` + MoviePy · MusicGen score with `sidechaincompress` ducking.
- **Backend on Alibaba Cloud:** CPU ECS / Function Compute (Singapore) · OSS (`oss2`) · EDL in **Tablestore** (reused from Hearth).
- **Alibaba Cloud proof file:** `backend/aliyun/storage.py` (OSS) + `backend/services/dashscope_client.py` (Qwen + Wan), with a top-level `alibaba_cloud_proof.py` importing both — `import oss2`, `import dashscope`, `*.aliyuncs.com` endpoints, real `put_object_from_file` / `Generation.call` / `VideoSynthesis.async_call` calls.

---

## License

Open source (MIT or Apache-2.0 — to be added; must be detectable in the repo About section per hackathon rules).

---

*North-star spec, fully backed by the five research briefs in [`/research`](./research).*
