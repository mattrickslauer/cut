# Cut! — Director's Brain: Research & Design

**Goal:** A multi-agent system (Director / Cinematographer / Editor) that watches live two-person improv (video + audio), understands the scene, and emits cinematic editing decisions as a structured Edit Decision List. Runs on Qwen models via Alibaba Cloud DashScope.

Date: 2026-07-11. All prices are DashScope International (Singapore) list unless noted; verify against the live pricing page before committing.

---

## 0. TL;DR architecture

```
                 ┌───────────── every ~2–4s "beat" ─────────────┐
 webcam ─frames─▶│  PERCEPTION                                   │
 mic ───audio──▶ │   • Qwen3-VL-Flash  → visual beat digest      │
                 │   • Paraformer/Fun-ASR realtime → live txt    │──▶ WORLD STATE
                 └───────────────────────────────────────────────┘        │
                                                                           ▼
        ┌──── LangGraph cyclic graph (DashScope OpenAI-compat) ────────────────┐
        │  DIRECTOR (Qwen3-Max)  → beat intent, emotion, scene-boundary flag   │
        │        │                                                             │
        │  CINEMATOGRAPHER (Qwen3-VL-Plus) → shot size/angle/move, 180° axis   │
        │        │                                                             │
        │  EDITOR (Qwen3-Max)   → cut timing, transition, grade, music cue     │
        └────────────────────────────────┬─────────────────────────────────────┘
                                          ▼
                                 EDL JSON (one shot object) ──▶ renderer
```

Two clocks: a **fast perception loop** (2–4 s beats, cheap VL + streaming ASR) and a **decision loop** (the LangGraph cycle) that only fully re-runs the Cinematographer/Editor when the Director signals a change worth cutting on. Don't re-plan every frame; plan on *beats* and *boundaries*.

---

## 1. Video / visual understanding with Qwen-VL on DashScope

### Can it take video? Yes — two ways.

DashScope's vision models accept video in **two distinct input modes** ([Model Studio: Image and video understanding](https://www.alibabacloud.com/help/en/model-studio/vision)):

1. **Native video file** — `type: "video_url"` with a URL to an actual video file. The service samples frames server-side.
2. **Frame list ("video as images")** — `type: "video"` with an **array of image URLs** you extracted yourself. This is the mode you want for a live stream: you control which frames go in.

Both accept an **`fps` parameter**: "one frame is extracted every `1/fps` seconds," range **[0.1, 10.0], default 2.0**. The `fps` value is also used by the model as the *temporal scale* so it can reason about timing/timestamps. Higher fps = fast motion capture; lower fps = static scene, cheaper. The frame-list mode's `fps` is supported on **Qwen3-VL, Qwen2.5-VL, and Qwen3.6** series.

The SDK also exposes **`max_frames`**, which "automatically samples frames evenly" when your extracted frames exceed the cap — a safety valve against blowing the token budget.

### Models that support video

- **`qwen3-vl-plus`** — flagship VL, best scene/emotion reasoning. $0.20 in / $1.60 out per 1M tokens (0–32K tier; rises to $0.60/$4.80 at 128–256K). Native 256K context (expandable to 1M). ([pricing](https://www.alibabacloud.com/help/en/model-studio/model-pricing))
- **`qwen3-vl-flash`** — cheap/fast, ideal for the per-beat perception loop. **$0.05 in / $0.40 out** per 1M tokens. ~4× cheaper than Plus.
- **`qwen2.5-vl`** — prior gen, still solid, good fallback.
- **`qwen-vl-max`** — older flagship, flat $0.80 in / $3.20 out; prefer qwen3-vl-plus.
- Every model above gets **1M free tokens for 90 days** — enough to prototype the whole hackathon on the free tier.

### How video becomes tokens (the cost model that actually matters)

Qwen3-VL runs each frame through `smart_resize` + normalization, then emits vision tokens per frame under a pixel budget ([Qwen3-VL video understanding, DeepWiki](https://deepwiki.com/QwenLM/Qwen3-VL/5.4-video-understanding)):

| Knob | Default | Meaning |
|------|---------|---------|
| `min_pixels` | 4 × 32×32 | floor per frame |
| `max_pixels` | 256 × 32×32 (~262K px) | **ceiling per frame** |
| `total_pixels` | 20480 × 32×32 | overall token budget across all frames |

Rule of thumb from the docs: a 5–30 min video lands at **~4K–20K tokens**; hour-long at ~24K tokens @ 0.25–0.5 fps. For our **2–4 s beat** at 2 fps that's only **4–8 frames per call** ≈ a few hundred to low-thousands of tokens. At qwen3-vl-flash prices this is fractions of a cent per beat.

**2D spatial grounding is robust in the 480×480 → 2560×2560 resolution band**; accuracy falls off outside it. Keep webcam frames ~720p and downscale, don't upscale.

### How good is it at emotion / action / scene?

Qwen3-VL is genuinely strong at **action and scene description, temporal localization ("what happens between 0:03 and 0:06"), and spatial grounding**. Video understanding explicitly supports "locating specific events and obtaining timestamps" and generating summaries of time spans. Emotion is the softer edge: it reads **coarse affect** (laughing, angry posture, crying, tense body language) reliably from face + body, but fine-grained emotion is better sourced from **paralinguistic cues in the audio** (see ASR emotion below). **Design decision: fuse VL body/face read with ASR prosody/emotion for the affect signal — don't rely on VL alone.**

### Latency / streaming reality

DashScope VL is **request/response, not a persistent video stream.** There is no "push a live RTSP feed and get a running commentary" endpoint. You build the loop yourself:

1. Ring-buffer webcam frames locally.
2. Every beat (2–4 s), pull the last N frames (e.g., 6 @ 2 fps), upload/encode them, and fire one `qwen3-vl-flash` call with a tight structured prompt ("Return JSON: dominant_action, subject_positions, gaze, affect, framing_notes").
3. Expect **~1–3 s** round-trip for a small-frame call. That's why the perception beat and the cut decision are decoupled — perception feeds a rolling world-state; the Editor cuts off world-state, not off the raw API latency.

**Opinion:** Use **qwen3-vl-flash for the every-beat perception digest** and reserve **qwen3-vl-plus** for occasional "deep look" calls the Director requests when something ambiguous happens (a prop reveal, a big status shift). Two-tier VL keeps cost and latency down.

---

## 2. Speech-to-text (ASR): live transcripts of the improv

Alibaba has a real, mature **real-time streaming ASR** product over **WebSocket** — this is a genuine strength, not a gap ([Real-time speech recognition](https://www.alibabacloud.com/help/en/model-studio/real-time-speech-recognition), [WebSocket user guide](https://www.alibabacloud.com/help/en/model-studio/real-time-speech-recognition-user-guide)).

### The options

| Model | Family | Notes |
|-------|--------|-------|
| **`paraformer-realtime-v2`** | Paraformer | Streaming, **word + sentence timestamps** (ms precision), VAD, disfluency removal, custom hotwords. Multilingual (Chinese+dialects, **English**, JA/KO/DE/FR/RU). Battle-tested. |
| `paraformer-realtime-8k-v2` | Paraformer | Tuned for 8kHz telephony; not needed for webcam mic. |
| **`fun-asr-realtime`** | Fun-ASR | Newer streaming model, similar envelope. |
| **`qwen3-asr-flash-realtime`** | Qwen-ASR | LLM-grade ASR, **7 fine-grained emotions**, automatic language detection. **But currently returns *no timestamps*** and is priced per-token (~$35/1M input tokens). |
| SenseVoice | — | Exists in the ecosystem (FunAudioLLM) but the first-class *hosted realtime* path on Model Studio is Paraformer / Fun-ASR / Qwen-ASR. |

### Protocol & specs

- **WebSocket bidirectional streaming.** Client streams PCM chunks up; server pushes partial + final transcripts down via callbacks. First-package / last-package delay are the tracked latency metrics — sub-second partials in practice for short utterances.
- Audio: **16 kHz, 16-bit, mono PCM** (also WAV/Opus/Speex/AAC/AMR). Feed straight from the mic.
- **VAD mode (default):** server auto-detects utterance start/end — perfect for turn-taking in a two-hander. You get a clean "who just finished a line" event.
- SDKs: Python, Java, Go.

### The pick

**Primary: `paraformer-realtime-v2` over WebSocket.** Reasons: (1) it emits **word + sentence timestamps**, which the Editor needs to cut *on the line* ("cut to the reverse on the last word of B's setup"); (2) VAD gives free turn segmentation; (3) low, predictable latency; (4) hotwords let you bias toward character names the performers establish.

**Emotion augment:** run **`qwen3-asr-flash-realtime` in parallel on the same audio** (or periodically) purely for its **7-emotion paralinguistic read**, and fuse that into affect — accept that it won't give you timestamps. If cost/complexity matters, skip it and lean on VL body-language + text sentiment from the Director.

**Batch fallback:** for post-show re-cuts, Paraformer recording-file recognition gives cleaner transcripts.

**Design decision: Paraformer-realtime-v2 (WebSocket, VAD, timestamps) is the ASR backbone; Qwen-ASR emotion is an optional affect side-channel.**

---

## 3. Semantic scene-boundary detection

The hard part: performers "change scene" **narratively** — new location, new time, new premise — with **no visual cut** (same two people, same black-box stage). Pure visual shot-change detection (histogram/PySceneDetect) is useless here; it fires on nothing. Research confirms visual-similarity methods "under-detect boundaries" exactly when "semantic transitions do not align with visual changes" ([Scene-VLM, arXiv 2512.21778](https://arxiv.org/html/2512.21778); [Chapter-LLaMA discussion](https://openreview.net/forum?id=c8r3lzyVTS)).

**Approach — LLM boundary classifier over a sliding window of world-state.** The Director agent, each beat, sees the last ~30–60 s of fused transcript + VL digests and answers a cheap structured question:

```
Given the running transcript and visual notes, has the scene changed?
A scene change = a shift in ANY of: location, time, the fictional premise/game,
or the relationship being played. A new *joke beat* is NOT a scene change.
Return {scene_change: bool, confidence: 0-1, new_scene_summary: str|null,
        boundary_reason: "location|time|premise|relationship|none"}.
```

Signals that fire the boundary (encode these as few-shot examples in the prompt):
- **Explicit verbal reframing** — improv performers narrate transitions: "Later that day…", "Meanwhile, at the hospital…", a physical "wipe" gesture, or a hard tonal reset. ASR catches these first.
- **Premise/relationship swap** — the "game of the scene" changes; detectable from dialogue semantics.
- **Physical reset** — both performers break contact, reposition, restart energy (VL: subject_positions jump + gaze reset).

**Two-boundary model — separate the narrative boundary from the edit boundary:**
- **Scene boundary** (narrative) → triggers an *establishing shot* + possible grade/music-cue change + resets the 180° axis.
- **Beat boundary** (within-scene) → triggers ordinary coverage cuts (shot/reverse-shot, punch-in on a laugh line).

Use **hysteresis**: require confidence > 0.7 sustained across 2 consecutive beats before committing a scene change, so a mid-sentence "meanwhile…" joke doesn't trigger a spurious establishing shot. This mirrors how boundary detectors debounce.

---

## 4. Encoding cinematography into the agents

### Prior art to steal from

- **FilmAgent** (SIGGRAPH Asia 2024, [arXiv 2501.12909](https://arxiv.org/html/2501.12909v1), [site](https://filmagent.github.io/)) — LLM multi-agent film crew (director, screenwriter, actor, cinematographer) in Unity. **Directly relevant.** It defines **9 shot types**: static — **Close-Up (CU)**, **Medium Shot (MS)**, **Long Shot (LS)**; dynamic — **Pan, Zoom, Tracking, Curve Surround, 360° Arc, Truck**. Cinematographer agents each propose a shot per line, then **debate discrepancies**, and the **Director judges/finalizes** (max 3 iterations). It encodes the **180° rule** as a *usage guideline* per shot (e.g., a tracking shot is rejected when the subject isn't moving). Scriptwriting uses a **Critique–Correct–Verify** loop; cinematography uses **Debate–Judge**. FilmAgent scored 3.98/5 in human eval and beat single-agent baselines.
- **MovieAgent** ([arXiv 2503.07314](https://arxiv.org/html/2503.07314)) — hierarchical CoT planning that structures scenes → camera settings → shots for multi-shot long-form video with character consistency.
- **Mind-of-Director** ([arXiv 2603.14790](https://arxiv.org/pdf/2603.14790)) — multimodal agents for previz; a dedicated **camera-planning module optimizes framing, movement, composition**.
- **Cutscene Agent** ([arXiv 2604.25318](https://arxiv.org/pdf/2604.25318)) — LLM agent framework emphasizing **editable production assets** (closer to our EDL-consumed-by-renderer model).

**Takeaway:** the winning pattern everywhere is **propose → debate/critique → director-judges**, with cinematography knowledge injected as **explicit per-shot usage rules**, not free-form vibes. Adopt exactly that.

### The three agents

**DIRECTOR (Qwen3-Max) — intent & continuity.** Owns the *story* read, not the lens. Inputs: fused world-state (transcript + VL digest + affect + ASR emotion). Outputs: `beat_intent` (who's driving, what's the emotional charge, whose reaction matters), `emotional_valence`, `scene_change` flag + boundary reason, `focus_subject` (whose face we care about now), and `pacing` (calm/building/frantic). The Director is the **judge** in every debate and the **owner of continuity state** (current 180° axis, established geography, characters, running grade/music mood).

**CINEMATOGRAPHER / DP (Qwen3-VL-Plus) — the lens.** It's a VL model so it can *see* the actual framing and staging, not just read a description. Inputs: latest frames + Director's `beat_intent` + continuity state (current axis). Outputs a shot spec: `shot_size` (ECU/CU/MCU/MS/MLS/LS/WS), `angle` (eye/high/low/OTS), `movement` (static/pan/tilt/push-in/pull-out/track/arc), `subject`, and a hard-enforced **`camera_side` on the 180° axis**. Encode the film-grammar as an explicit rubric in its system prompt:

> *Match shot size to emotional intensity: intimacy/revelation → push in to CU; status/power → low angle; vulnerability → high angle. Dialogue default is shot/reverse-shot in matched sizes across the axis. On a laugh/reveal, punch in. Never cross the established 180° axis unless the Director declares a new scene. Vary shots — no two consecutive identical static sizes. Establishing/wide on every new scene.*

**EDITOR (Qwen3-Max) — rhythm & finish.** Owns *when to cut and the polish*. Inputs: DP's shot spec + ASR word timestamps + pacing. Outputs: `cut_in`/`cut_out` timing (snapped to line boundaries from ASR timestamps), `transition` (cut/dissolve/wipe/smash — hard cut is the default; dissolve only on scene/time change), `hold_min_ms` (rhythm — fast montage vs. let-it-breathe), `grade` (mood LUT), and `music_cue`. Editor enforces **cut rhythm**: comedic timing = cut *on* or just after the punch, hold reactions a beat; tension = longer holds, fewer cuts.

**Debate step (optional but high-value):** when Director confidence is low or DP proposes an axis-crossing move, run one FilmAgent-style **Debate–Judge** round: DP restates, Editor objects on rhythm/continuity grounds, Director rules. Cap at 1–2 rounds for latency.

**Coverage & the 180° rule as *state*, not vibes:** store the axis as a first-class field (`axis_degrees`, `camera_side ∈ {A,B}`) in continuity state. Every shot the DP emits must carry its side; the renderer/validator rejects a flip unless `scene_change=true`. This makes the "don't cross the line" rule mechanical instead of hoping the LLM remembers.

---

## 5. The output contract: Edit Decision List (EDL) schema

Each decision cycle emits **one shot object** appended to a running EDL. Keep it compact — the renderer consumes it, and small = cheap to generate and fast to validate. Proposed schema:

```jsonc
{
  "edl_version": "1.0",
  "shot_id": "s_0042",
  "scene_id": "sc_007",                 // increments on narrative scene change
  "beat_id": "b_0113",
  "timecode": {
    "cut_in_ms": 128400,                // when this shot starts (show clock)
    "cut_out_ms": 131200,               // Editor sets; may be open-ended live
    "hold_min_ms": 900                  // minimum on-screen time (rhythm guard)
  },
  "framing": {
    "shot_size": "MCU",                 // ECU|CU|MCU|MS|MLS|LS|WS|EWS
    "angle": "eye",                     // eye|high|low|dutch|OTS_A|OTS_B|top
    "movement": "push_in",              // static|pan|tilt|push_in|pull_out|track|arc|handheld
    "subject": "performer_B",           // performer_A|performer_B|both|hands|prop:<x>|environment
    "camera_side": "A",                 // 180-rule: which side of the axis {A|B}
    "headroom": "tight"                 // loose|neutral|tight  (composition hint)
  },
  "environment": {
    "background_prompt": "dim hospital corridor, fluorescent flicker, night",
    "continuity_key": "sc_007_hospital"  // stable id so renderer reuses same BG within scene
  },
  "transition": {
    "in": "cut",                        // cut|dissolve|wipe|smash|fade_in
    "out": "cut",
    "duration_ms": 0
  },
  "grade": {
    "lut": "cool_clinical",             // mood LUT name
    "intensity": 0.6
  },
  "audio": {
    "music_cue": "tension_bed_lowstrings",  // cue id | null
    "music_action": "start",            // start|swell|duck|stop|none
    "diegetic_ducking": true
  },
  "intent": {
    "director_note": "B realizes the diagnosis — isolate reaction",
    "emotional_valence": "dread",
    "pacing": "building",
    "confidence": 0.82
  },
  "provenance": {
    "from_transcript_span": [126100, 128300],  // ASR ms window that justified this
    "vl_digest_ref": "vd_0091"
  }
}
```

Design notes:
- **`camera_side` is load-bearing** — it's how the 180° rule is enforced downstream.
- **`continuity_key`** lets the renderer reuse a generated background across all shots in a scene instead of re-generating (consistency + cost).
- **`hold_min_ms`** protects comedic/emotional rhythm from over-cutting.
- **`provenance`** ties every shot back to the transcript/VL evidence — invaluable for debugging why the system cut where it did, and for post-hoc re-cuts.
- Live vs. batch: live shots can carry `cut_out_ms: null` (open until the next shot supersedes); a finalize pass closes them.
- Keep it **flat-ish and typed** — enums everywhere so a JSON-schema validator can reject illegal shots (e.g., axis flip without scene change) *before* the renderer sees them.

---

## 6. Orchestration: LangGraph over DashScope OpenAI-compat

### The endpoint

Point everything at the **OpenAI-compatible base URL** ([compat docs](https://www.alibabacloud.com/help/en/model-studio/compatibility-of-openai-with-dashscope)):

```
base_url = "https://dashscope-intl.aliyuncs.com/compatible-mode/v1"   # Singapore/intl
api_key  = <DASHSCOPE_API_KEY>
```

Qwen is OpenAI-compatible, so **LangGraph works out of the box** via `langchain_openai.ChatOpenAI` (or `ChatQwen`) pointed at that URL. Confirmed integration paths exist for LangGraph/LangChain with Qwen ([AgentScope Runtime LangGraph guide](https://runtime.agentscope.io/en/langgraph_guidelines.html), [ChatQwen integration](https://docs.langchain.com/oss/python/integrations/chat/qwen)).

### ⚠️ Known gotcha: null logprobs

DashScope's OpenAI-compat mode **returns `null` for `logprobs`.** Consequences for design:
- **Don't build confidence/uncertainty gating on token logprobs.** Any agent "confidence" must be an **explicit field the model outputs** in its JSON (as in the EDL `intent.confidence`), not derived from logprobs.
- Anything in your stack (some routing/guardrail libs, self-consistency scorers) that silently expects logprobs will get `None` — guard it.
- For structured output, rely on **JSON mode / response_format + a schema validator**, not logprob-based parse repair.

### The cyclic graph

LangGraph shines here because the loop is **cyclic**, not a DAG:

```
STATE (typed dict): world_state, continuity, edl, pending_debate

     ┌─────────────┐
     │ PERCEPTION  │◀── external: frame buffer + ASR partials (async, non-LLM node
     └──────┬──────┘    that just folds latest webcam/ASR into world_state)
            ▼
     ┌─────────────┐   scene_change? emotional read, focus_subject, pacing
     │  DIRECTOR   │
     └──────┬──────┘
            ▼
     ┌─────────────┐   sees frames; shot_size/angle/move; stamps camera_side
     │ CINEMATOGR. │
     └──────┬──────┘
            │  conditional edge:
            │   if axis_conflict or low confidence → DEBATE node → back to DIRECTOR (≤2x)
            ▼
     ┌─────────────┐   cut timing (snap to ASR ts), transition, grade, music
     │   EDITOR    │
     └──────┬──────┘
            ▼
     append shot → EDL ──▶ renderer/queue
            │
            └──── loop back to PERCEPTION on next beat/boundary
```

Implementation notes:
- **Perception is a non-LLM node** that just merges the latest async webcam digest + ASR into `world_state`. Keep the VL/ASR calls off the critical LangGraph path (run them in background tasks writing into a shared buffer); the graph reads the freshest snapshot. This is what keeps the decision loop from stalling on API latency.
- **Conditional edges** implement the FilmAgent-style Debate–Judge: DP→(conflict?)→Debate→Director→DP, capped by an iteration counter in state to bound latency.
- **Two trigger rates:** run the full Director→DP→Editor cycle on **beat boundaries** and **scene boundaries**; on quiet beats, skip DP/Editor and just extend the current shot (`hold`). Saves tokens and avoids twitchy cutting.
- **Model routing:** Director + Editor on **qwen3-max** (reasoning/timing), DP on **qwen3-vl-plus** (needs to see), perception digest on **qwen3-vl-flash** (cheap/fast). All through the one compat endpoint, just different `model=` strings.
- **Structured output:** give each node a JSON schema; validate before writing to state. Reject axis flips without `scene_change`, reject shot sizes out of enum, etc. — mechanical film-grammar enforcement.

---

## Sources

- Qwen video/vision on DashScope: https://www.alibabacloud.com/help/en/model-studio/vision
- Qwen3-VL video tokenization: https://deepwiki.com/QwenLM/Qwen3-VL/5.4-video-understanding
- Qwen3-VL repo: https://github.com/QwenLM/Qwen3-VL
- Model Studio pricing: https://www.alibabacloud.com/help/en/model-studio/model-pricing
- Real-time speech recognition (Fun-ASR/Paraformer/Qwen-ASR): https://www.alibabacloud.com/help/en/model-studio/real-time-speech-recognition
- Real-time ASR WebSocket user guide: https://www.alibabacloud.com/help/en/model-studio/real-time-speech-recognition-user-guide
- Paraformer real-time Python SDK: https://www.alibabacloud.com/help/en/model-studio/paraformer-real-time-speech-recognition-python-sdk
- Paraformer WebSocket API: https://www.alibabacloud.com/help/en/model-studio/websocket-for-paraformer-real-time-service
- OpenAI-compat mode: https://www.alibabacloud.com/help/en/model-studio/compatibility-of-openai-with-dashscope
- FilmAgent: https://filmagent.github.io/ · https://arxiv.org/html/2501.12909v1
- MovieAgent (multi-agent CoT film gen): https://arxiv.org/html/2503.07314
- Mind-of-Director (previz camera planning): https://arxiv.org/pdf/2603.14790
- Cutscene Agent (editable production assets): https://arxiv.org/pdf/2604.25318
- Scene-VLM (semantic scene segmentation): https://arxiv.org/html/2512.21778
- Chapter-LLaMA / transcript-based boundaries: https://openreview.net/forum?id=c8r3lzyVTS
- LangGraph + Qwen: https://runtime.agentscope.io/en/langgraph_guidelines.html · https://docs.langchain.com/oss/python/integrations/chat/qwen
