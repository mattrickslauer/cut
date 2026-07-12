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
Browser (web/index.html)
  ── pick sides ──▶ scene config
  ── deliver line ─▶ Web Audio capture → 16 kHz mono WAV → base64
        │  POST /costar  { scene, history, audio }
        ▼
  Alibaba Function Compute  (cut-audition, custom.debian10, scale-to-zero)
        ├─ qwen3-asr-flash   actor's line → text (+ emotion)      [DashScope, HTTP one-shot]
        ├─ qwen-max          in-character reply + coaching note   [DashScope, HTTP one-shot]
        └─ qwen3-tts-flash   voice the reply → audio data URI     [DashScope, HTTP one-shot]
        ▼
  { heard, line, note, stakes, audio }  → render, play, coach
```

**One POST = one acting beat (~1–2s).** A scene partner delivers *lines* with natural beats,
so turn-based HTTP is the right latency target — the pause reads as acting, not lag.

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

## Run it

```bash
# backend (its own function)
cd audition/server
QWEN_API_KEY=sk-xxx PORT=8787 python3 app.py

# frontend: BACKEND_URL in web/audition.js already points at http://localhost:8787
# open audition/web/index.html   (e.g.  python3 -m http.server -d audition/web 5500)

# deploy (independent scale-to-zero function)
cd audition/server && QWEN_API_KEY=sk-xxx s deploy
# then set BACKEND_URL in web/audition.js to the printed cut-audition URL
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
