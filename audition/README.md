# Cut! — Audition Room (AI scene partner)

An **audition self-tape studio with an AI reader you act opposite in real time.** Pick your
sides, turn on your webcam, and just act — it's **hands-free**: continuous voice-activity
detection hears when you speak, auto-ends your line on silence, and the scene partner
answers in character (voiced) with a casting-savvy note on your delivery. No push-to-talk.
Record → get notes → re-take → save. The actor-facing wedge of Cut!: a daily-habit
self-tape recorder whose reader-that-reacts is the reason to use it.

Self-contained subfolder — its own scale-to-zero FC function, web app, and docs. Touches
none of the director's files.

```
audition/
  server/   app.py    # cut-audition FC function (stdlib-only, holds the DashScope key)
            s.yaml     # its own scale-to-zero FC resource
  web/      index.html audition.css audition.js   # the recorder UI
  README.md
```

## Architecture — turn-based on scale-to-zero Alibaba FC

```
Browser (web/index.html)  — hands-free; camera previews on page load
  ── pick sides ──▶ scene config
  ── you speak ───▶ energy-VAD on our mic stream detects when you finish
        │           (or press Space / tap the video to send now)
        │  POST /costar  { scene, history, audio }   16 kHz mono WAV
        ▼
  Alibaba Function Compute  (cut-audition, custom.debian10, scale-to-zero)
        ├─ qwen3-asr-flash   actor's line → text (+ emotion)         [DashScope, HTTP one-shot]
        ├─ qwen-flash        in-character reply + coaching note       [DashScope, HTTP one-shot]
        └─ qwen3-tts-flash   voice the reply → base64 data URI         [DashScope, HTTP one-shot]
                             (per-role gender-matched voice; base64 so Web Audio can
                              mix the reader's voice into the recorded tape — OSS URL
                              has no CORS and would taint/silence in Web Audio)
        ▼
  { heard, line, note, stakes, audio }  → render, play, coach
```

**One POST = one acting beat.** A scene partner delivers *lines* with natural beats, so
turn-based HTTP is the right target — the pause reads as acting, not lag.

### Turn detection
The reliable default is an **energy-VAD on our own getUserMedia mic stream** — it waits for a
~1.2s natural pause, with **Space / tap-the-video** as a manual "done" so you're never stuck.
(A browser-`SpeechRecognition` text fast-path exists behind `USE_SR`, but it contends with the
camera/mic capture in Chrome and stalls, so it's **off by default**.)

### Latency (measured on the deployed function)
- Audio path in-region: ASR `qwen3-asr-flash` + reply `qwen-flash` + TTS `qwen3-tts-flash`
  ≈ **~4s** to a voiced reply (co-located with DashScope; negligible cold start).
- Wins applied: `qwen-flash` (not `qwen-max`); replies kept short. (TTS returns base64 so the
  reader's voice can be mixed into the recording — costs a ~0.8s re-host, a deliberate trade.)

### Director's cut — a coherent edited scene, latency removed
We don't record the raw camera. We record a **composited canvas** that cuts between your
shot (camera, on your turns) and the **co-star's shot** (a letterboxed card with their line,
on their turns). The `MediaRecorder` is **paused during "thinking"**, so the AI's latency
never enters the video — the Stop playback is a tight, edited two-shot with no dead air.
A persistent Web Audio graph mixes your mic **and** the reader's TTS into the recorded audio,
so the voice is baked into the tape (not mic bleed). Voices are gender-matched per role
(`qwen3-tts-flash`, English prosody hint): Serena/Cherry female, Ethan/Elias male.

### Scripts
Paste sides into the **Script** box and the co-star follows them (`scene.script` → the reader's
prompt delivers its character's next scripted line, adapting only to keep the scene alive). Blank
= improvise from the premise. Scripted takes let you start (no canned opening).

### Why not a streaming WebSocket?
`research/asr.md` already made this call: a scale-to-zero FC function can't hold a persistent
socket without breaking scale-to-zero, so we use HTTP one-shot models throughout. True
overlap / barge-in (persistent-WS Paraformer + CosyVoice) is a **v2** upgrade *off* the FC
path — only if acting timing proves it's needed.

### Scale-to-zero with no per-turn latency tax
- **Inference (DashScope) is inherently scale-to-zero** — pay-per-call, $0 when idle. The real cost.
- **FC scales to zero** — cold start hits only the *first* POST after idle (session open), never
  per-turn once warm. Hidden behind `GET /warm`, fired on "Start audition".
- COGS tracks the per-minute meter exactly: nothing runs when no one's rehearsing.

## Deployed (Alibaba Function Compute, ap-southeast-1, scale-to-zero)

**Live:** `https://cut-audition-htjhmbyvbv.ap-southeast-1.fcapp.run` — `web/audition.js`
`BACKEND_URL` points here. In-region it runs ~2.5–3s/turn (co-located with DashScope).

```bash
# redeploy after backend changes (injects the DashScope key at deploy; never committed)
cd audition/server && QWEN_API_KEY=sk-xxx s deploy

# local dev instead: run the server and point BACKEND_URL at it
cd audition/server && QWEN_API_KEY=sk-xxx PORT=8787 python3 app.py   # BACKEND_URL=http://localhost:8787
# serve the UI:  python3 -m http.server -d audition/web 5500  → open http://localhost:5500
```

## Endpoints
- `GET  /health` — liveness + which models are wired
- `GET  /warm`   — no-op that spins a cold instance up before an audition
- `POST /costar` — `{ audio: dataURI, scene: {...}, history: [...] }` → `{ heard, line, note, stakes, audio }`
- `POST /say`    — `{ text, voice? }` → `{ audio }` : voices arbitrary text (the opening line) so the whole scene is spoken

## Verified live (against the qwen-cloud intl Model Studio key)
- ASR `qwen3-asr-flash`, reader `qwen-max`, and TTS **`qwen3-tts-flash`** all confirmed
  working end-to-end via `POST /costar` — the reply comes back voiced (`output.audio.url`).
- Note: `qwen-tts` / `cosyvoice-*` are **not** on this account ("Model not exist"); the flash
  models are. All three are env-swappable (`ASR_MODEL`/`COSTAR_MODEL`/`TTS_MODEL`).
- Voices (`Cherry`/`Ethan`/`Chelsie`/`Serena`, per-scene) are accepted by `qwen3-tts-flash`.

## Next wire-ups
- **Save to OSS** — `saveBtn` currently downloads the take (webm + transcript). Add a `/sign`
  route (`oss2` signed PUT) so takes live in the cloud and become the self-tape casting
  reviews. This is the seed of the B2B side.
- **Per-minute metering** — stamp active talk-time per session for billing (the model discussed).
- **Webcam** — add `getUserMedia({video})` + record video alongside audio for a real self-tape.

## Scripted practice studio (v2)

When you paste sides into the Next.js app (`../web`), the reader becomes a full scene partner
you rehearse against — parsed once into speaker-attributed lines that drive four things off one
current-line pointer:

- **Expressive voice** — the reply model tags each line with an emotion; we translate it into a
  delivery instruction and voice it with `qwen3-tts-instruct-flash` (falls back to flat
  `qwen3-tts-flash` if the instruct model isn't on the key). `POST /say` accepts
  `emotion`/`instructions`/`tone`.
- **Teleprompter + line-gating** — the sides scroll on screen with the current line highlighted;
  the co-star only advances once you've delivered your line ("within reason" — fuzzy match), and
  **"Line!"** (button / `L`) prompts your line when you blank.
- **Compile a talking-head co-star** *(optional)* — pre-renders the co-star as a real lip-synced
  face: `POST /portrait` (qwen-image) once, then per line `POST /say` → `POST /avatar` →
  `GET /avatar?task_id=…`. `/avatar` uses **`wan2.7-i2v`** (the intl route; EMO/s2v are Beijing-only)
  and hosts each line's WAV on **OSS** (its `driving_audio` must be a public URL). Clips play into
  the canvas compositor during the take, so the face is baked into the cut — no post-render.
- **Takes + compare** — every Stop archives the take (video + reader notes + stakes) into a
  side-by-side compare gallery.

New env (see `server/s.yaml`): `TTS_INSTRUCT_MODEL`, `TTS_EXPRESSIVE`, `PORTRAIT_MODEL`,
`AVATAR_MODEL`, `AVATAR_RES`, and for the talking-head only `OSS_ENDPOINT` / `OSS_BUCKET` /
`OSS_KEY_ID` / `OSS_KEY_SECRET`. Leave the OSS vars unset to run everything except the video
co-star. Talking-head clips are ~1–5 min each and cost real credits — it's opt-in per scene.
