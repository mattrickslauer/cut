# DashScope ASR for "Cut!" — Speech-to-Text Research

Endpoint region: **International / Singapore** (`dashscope-intl.aliyuncs.com`).
Constraint: server is a scale-to-zero Alibaba Function Compute HTTP function, zero-dependency Python (stdlib `urllib` only), API key held server-side. Strong preference for a **single HTTPS request** (no persistent WebSocket).

Last verified against Alibaba Cloud Model Studio docs on 2026-07-11.

---

## RECOMMENDED APPROACH (read this first)

**Use `qwen3-asr-flash` over the OpenAI-compatible HTTPS endpoint. HTTP one-shot works — no WebSocket, no dependencies.**

- Model id: **`qwen3-asr-flash`** (pin snapshot `qwen3-asr-flash-2026-02-10` if you want stability).
- One POST per audio chunk; you get the transcript string back in the JSON response. Fits the FC request/response, stdlib-`urllib`, scale-to-zero model perfectly.
- Audio is sent **inline as a base64 data URI** — no need to upload to OSS first, no public URL required. (Max 10 MB base64 payload, max 5 min per clip — chunks are far under this.)
- **Browser must send: a `data:` URI wrapping the audio.** MediaRecorder `audio/webm;codecs=opus` is an accepted container, so you *can* send WebM/Opus directly. BUT see the "Audio format decision" section — for robustness and lowest latency in a chunked live-improv setting, prefer sending **16 kHz mono WAV** built in the browser (Web Audio → downsample → WAV), or at minimum accept that raw MediaRecorder chunks after the first are not standalone-decodable and must be handled with a re-priming trick.

### Why not the alternatives
- **paraformer-realtime-v2** gives lower streaming latency and free word/sentence timestamps, but it is **WebSocket-only** — it needs a persistent connection, which does not fit a scale-to-zero request/response FC function without adding a websocket client dependency. Skip unless you move the audio path off FC.
- **Speaker diarization (telling the two improvisers apart) is NOT available in the real-time / synchronous path.** It exists only in `paraformer-v2` **async batch file transcription** (HTTP submit+poll, public URL only). See section 3 for how to bolt it on if you need speaker labels.

### The near-real-time loop (recommended)
1. Browser records mic continuously, cuts ~2–4 s chunks.
2. Each chunk is encoded to 16 kHz mono WAV (Web Audio API), base64'd, POSTed to the FC function.
3. FC function forwards to `qwen3-asr-flash` via one HTTPS POST, returns `message.content` (the transcript) to the browser.
4. Browser appends transcript to the running dialogue. Optionally overlap chunks by ~0.5 s to avoid clipping words at boundaries.

Latency is chunk length + one model round-trip (typically well under a second of processing for a few-second clip). This is "near-real-time," not true streaming — acceptable for improv dialogue capture; if you need sub-second incremental partials, you must go WebSocket (paraformer / qwen3-asr-flash-realtime).

---

## 1. HTTP one-shot ASR — YES, qwen3-asr-flash

`qwen3-asr-flash` is a synchronous, single-HTTPS-POST ASR model. Two equivalent protocols; both accept a base64 data URI **or** a public URL for the audio.

### Option A — OpenAI-compatible endpoint (recommended; simplest JSON)

```
POST https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions
Authorization: Bearer $DASHSCOPE_API_KEY
Content-Type: application/json
```

Request body:

```json
{
  "model": "qwen3-asr-flash",
  "messages": [
    {
      "role": "user",
      "content": [
        {
          "type": "input_audio",
          "input_audio": {
            "data": "data:audio/wav;base64,<BASE64_AUDIO>"
          }
        }
      ]
    }
  ],
  "stream": false,
  "extra_body": {
    "asr_options": {
      "language": "en",
      "enable_itn": true
    }
  }
}
```

Notes:
- Yes — the OpenAI-compatible endpoint **does** support audio input via an `input_audio` content part, exactly analogous to `image_url`. The audio goes in `input_audio.data` as either a `data:` URI (base64) or an `https://` URL.
- `asr_options.language`: set `"en"` to pin English (improv is English) or omit for auto-detect. Supported codes include zh, en, ja, de, ko, ru, fr, pt, ar, it, es, hi, id, th, tr, uk, vi, cs, da, fil, fi, is, ms, no, pl, sv, yue.
- `enable_itn` (inverse text normalization) → digits/punctuation formatting; en/zh only.

Response (non-streaming):

```json
{
  "choices": [
    {
      "finish_reason": "stop",
      "index": 0,
      "message": {
        "role": "assistant",
        "content": "So what are we doing at the beach today?",
        "annotations": [
          { "type": "audio_info", "language": "en", "emotion": "neutral" }
        ]
      }
    }
  ],
  "created": 1767683986,
  "id": "chatcmpl-...",
  "model": "qwen3-asr-flash",
  "object": "chat.completion",
  "usage": { "prompt_tokens": 42, "completion_tokens": 12, "total_tokens": 54, "seconds": 1 }
}
```

Transcript = `choices[0].message.content`. It also returns detected `language` and `emotion` in `message.annotations` (no speaker id, no per-word timestamps here).

### Option B — DashScope-native endpoint (same model, different envelope)

```
POST https://dashscope-intl.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation
Authorization: Bearer $DASHSCOPE_API_KEY
Content-Type: application/json
```

```json
{
  "model": "qwen3-asr-flash",
  "input": {
    "messages": [
      { "role": "user", "content": [ { "audio": "data:audio/wav;base64,<BASE64_AUDIO>" } ] }
    ]
  },
  "parameters": { "asr_options": { "language": "en", "enable_itn": true } }
}
```

Response transcript path: `output.choices[0].message.content[0].text`.

Either works from stdlib `urllib`. Option A is less nesting. Use whichever you prefer; the snippet below uses Option A.

### The other models you asked about
- **`qwen-audio-asr` / `qwen2-audio-instruct`**: older Qwen-Audio generation. Superseded by qwen3-asr-flash for pure ASR. Don't use for this.
- **`qwen3-omni` (qwen3-omni-flash / qwen-omni-turbo)**: multimodal chat that *can* accept `input_audio` and transcribe, but it's a general omni model (higher cost/latency, chattier). Use the dedicated `qwen3-asr-flash` instead.
- **`qwen3-asr-flash-realtime`**: a **WebSocket** streaming variant (`wss://dashscope-intl.aliyuncs.com/api-ws/v1/realtime`). Lower latency but not HTTP — skip for FC.

---

## 2. paraformer-realtime-v2 — WebSocket-only

- **Transport: WebSocket only.** No HTTP one-shot. Confirmed — real-time Paraformer is delivered over a persistent WS connection (`wss://dashscope-intl.aliyuncs.com/api-ws/v1/inference` via the DashScope SDK/WS protocol). Does not fit a stdlib-only, scale-to-zero FC function.
- **Audio format:** raw **PCM** or **WAV**, **16000 Hz**, **16-bit**, **mono** (single channel). Also accepts Opus/Speex framing per the WS spec, but 16 kHz/16-bit/mono PCM is the canonical input. You stream raw audio frames over the socket.
- **Timestamps:** YES — returns **sentence-level and word-level timestamps** by default (begin/end in ms). Good for subtitle alignment, but no speaker labels.

If you ever need true low-latency streaming with timestamps, this is the model — but you'd add a websocket client (e.g. `websocket-client` or `websockets`) to the FC function or run it from a long-lived service instead of FC.

---

## 3. Speaker diarization (telling the two improvisers apart)

- **NOT available in real-time or in qwen3-asr-flash synchronous.** No `speaker_id` in the live path.
- **Available only in `paraformer-v2` async batch file transcription** (recorded-file recognition), which is HTTP (submit task → poll for result), **public URL input only (no base64, no local file)**.

Enable it with parameters:

```json
"parameters": {
  "diarization_enabled": true,
  "speaker_count": 2
}
```

- `speaker_count`: reference number of speakers (2–100). Set `2` for the two-person improv.
- Result JSON then includes `"speaker_id": 0` on each sentence/word object (only present when diarization is enabled).
- **Mono only** — multi-channel audio does not support diarization.
- Flow: upload the finished recording to a public URL (e.g. OSS), POST to
  `https://dashscope-intl.aliyuncs.com/api/v1/services/audio/asr/transcription` (async submit),
  then GET `https://dashscope-intl.aliyuncs.com/api/v1/tasks/{task_id}` until done, then download `transcription_url`.

**Implication for "Cut!":** you cannot get live speaker labels over the HTTP one-shot path. Options:
1. Do live transcription with qwen3-asr-flash (no speaker labels), and separate speakers **client-side** by which mic/track — e.g. give each improviser their own recording track/device and send two independent chunk streams, tagging speaker on the client. This is the cleanest real-time solution.
2. If you need diarized speaker labels but not live, run `paraformer-v2` async diarization as a post-pass on the full recording.

Recommendation: two tracks + client-side speaker tagging for the live view; optional paraformer-v2 diarization pass afterward if you want automatic labeling from a single mixed mic.

---

## 4. Audio formats & the WebM/Opus decision

**What qwen3-asr-flash accepts (container formats):** aac, amr, aiff, flac, m4a, mp3, mpeg, ogg, **opus**, wav, **webm**, wma, plus video containers (avi, flv, mkv, mp4, mov, wmv). MP3 and WAV are the explicitly-documented safe formats.

**Sample rate:** the model internally handles decoding of container formats. Docs describe the model targeting **16 kHz mono**; for raw/PCM you must supply 16 kHz mono 16-bit. For compressed containers (mp3/webm/opus/wav) the service decodes them, but sending 16 kHz mono avoids any resampling ambiguity and shrinks payloads.

**Limits (synchronous):** ≤ 10 MB payload, ≤ 5 minutes per clip.

### Can I send MediaRecorder WebM/Opus directly?
- **Format-wise: yes** — `webm`/`opus` are accepted containers, so a *complete, self-contained* WebM/Opus blob can be base64'd and sent.
- **The real gotcha is chunked recording, not the codec.** `MediaRecorder` with `timeslice` emits the WebM header/metadata only in the **first** `dataavailable` blob; subsequent blobs are mid-stream fragments that are **not independently decodable**. If you POST chunk #2 alone, it will fail to decode. Workarounds:
  - (a) Start a fresh `MediaRecorder` per chunk (`start()` → `stop()` each ~2–4 s window) so every blob is a complete file. Simple, but you lose a few ms at each restart (mitigate with overlap).
  - (b) Keep the first header blob and prepend it to every later chunk before sending.
  - (c) **Recommended:** bypass MediaRecorder for chunking and use the **Web Audio API** (`AudioContext` + `AudioWorklet`/`ScriptProcessor`) to grab Float32 PCM, downsample to **16 kHz mono**, and encode a tiny **WAV** per chunk in JS. Every chunk is then a valid standalone 16 kHz mono WAV — smallest, most predictable, zero decode ambiguity. This is the format the browser should send.

**Audio-format decision:** send **16 kHz, mono, 16-bit WAV** as `data:audio/wav;base64,...`. Build it in the browser from Web Audio PCM. This is the most reliable choice for chunked, near-real-time capture and keeps chunks small. WebM/Opus is *possible* but only safe if you guarantee each POSTed blob is a complete file (per-chunk MediaRecorder or header re-priming).

---

## 5. Model ids, pricing, free tier (Singapore endpoint)

| Model | id | Transport | Diarization | Timestamps |
|---|---|---|---|---|
| Qwen3-ASR-Flash (recommended) | `qwen3-asr-flash` (`-2026-02-10`) | HTTP one-shot | No | No |
| Qwen3-ASR-Flash file transcription | `qwen3-asr-flash-filetrans` | HTTP async (poll) | — | word/sentence |
| Paraformer real-time | `paraformer-realtime-v2` | WebSocket only | No | word/sentence |
| Paraformer recorded-file | `paraformer-v2` | HTTP async (poll) | **Yes** (`diarization_enabled`,`speaker_count`) | word/sentence |
| Qwen3-ASR-Flash realtime | `qwen3-asr-flash-realtime` | WebSocket | No | — |

**Pricing (qwen3-asr-flash):** billed by audio duration — the model tokenizes audio at ~25 tokens/second. Third-party (OpenRouter) effective rate quoted at **$0.000035/second (~$0.126/hour)** of audio; Alibaba's official Model Studio ASR rate is in the same ballpark. Output text tokens are effectively free for ASR. Confirm exact RMB/USD/second in the Model Studio console pricing page for your account (the public pricing table does not always list the ASR SKUs explicitly).

**Free tier (International/Singapore):** new Alibaba Cloud accounts get **1,000,000 free tokens per eligible model**, valid **90 days** after activating Model Studio. At ~25 tokens/sec that is roughly **~11 hours** of free qwen3-asr-flash audio — plenty for hackathon/dev.

---

## 6. Copy-pasteable server side (FC, stdlib urllib only)

Browser sends JSON `{"audio_b64": "<base64 wav>", "mime": "audio/wav"}` (or the full data URI). Server calls qwen3-asr-flash and returns `{"text": "..."}`.

```python
import os
import json
import urllib.request
import urllib.error

DASHSCOPE_API_KEY = os.environ["DASHSCOPE_API_KEY"]  # set in FC env, never sent to client
ASR_URL = "https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions"
MODEL = "qwen3-asr-flash"


def transcribe(audio_b64: str, mime: str = "audio/wav", language: str = "en") -> str:
    """One HTTPS POST -> transcript string. No WebSocket, no third-party deps."""
    data_uri = f"data:{mime};base64,{audio_b64}"
    payload = {
        "model": MODEL,
        "messages": [
            {
                "role": "user",
                "content": [
                    {"type": "input_audio", "input_audio": {"data": data_uri}}
                ],
            }
        ],
        "stream": False,
        "extra_body": {
            "asr_options": {"language": language, "enable_itn": True}
        },
    }
    req = urllib.request.Request(
        ASR_URL,
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {DASHSCOPE_API_KEY}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            body = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"DashScope {e.code}: {e.read().decode('utf-8')}") from e

    return body["choices"][0]["message"]["content"]


# ---- Alibaba Function Compute HTTP handler (event/context signature) ----
def handler(environ, start_response):
    # For FC HTTP functions using the WSGI-style signature; adapt to your runtime.
    length = int(environ.get("CONTENT_LENGTH") or 0)
    req_body = json.loads(environ["wsgi.input"].read(length) or "{}")
    audio_b64 = req_body["audio_b64"]
    mime = req_body.get("mime", "audio/wav")
    lang = req_body.get("language", "en")

    try:
        text = transcribe(audio_b64, mime=mime, language=lang)
        status, out = "200 OK", {"text": text}
    except Exception as ex:  # noqa: BLE001
        status, out = "500 Internal Server Error", {"error": str(ex)}

    payload = json.dumps(out).encode("utf-8")
    start_response(status, [("Content-Type", "application/json"),
                            ("Access-Control-Allow-Origin", "*")])
    return [payload]
```

(Adjust the handler signature to your FC runtime — event-based `def handler(event, context)` where `event` is the raw HTTP request JSON, or the WSGI form above. The `transcribe()` function is what matters and is runtime-agnostic.)

### Browser side — produce 16 kHz mono WAV per chunk (recommended encoding)

```js
// Capture mic -> Web Audio -> downsample to 16kHz mono -> WAV -> base64 -> POST.
const ctx = new AudioContext();
const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
const src = ctx.createMediaStreamSource(stream);
const node = ctx.createScriptProcessor(4096, 1, 1); // or AudioWorklet in prod
let buf = [];
node.onaudioprocess = (e) => buf.push(...e.inputBuffer.getChannelData(0));
src.connect(node); node.connect(ctx.destination);

function floatTo16kWav(float32, inRate) {
  const outRate = 16000;
  const ratio = inRate / outRate;
  const outLen = Math.floor(float32.length / ratio);
  const pcm = new Int16Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const s = Math.max(-1, Math.min(1, float32[Math.floor(i * ratio)]));
    pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  const bytes = new Uint8Array(44 + pcm.length * 2);
  const dv = new DataView(bytes.buffer);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
  w(0, "RIFF"); dv.setUint32(4, 36 + pcm.length * 2, true); w(8, "WAVE");
  w(12, "fmt "); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true);
  dv.setUint16(22, 1, true); dv.setUint32(24, outRate, true);
  dv.setUint32(28, outRate * 2, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
  w(36, "data"); dv.setUint32(40, pcm.length * 2, true);
  new Int16Array(bytes.buffer, 44).set(pcm);
  return bytes;
}

// Every ~3s, flush `buf` -> WAV -> base64 -> POST to the FC function:
setInterval(async () => {
  if (!buf.length) return;
  const wav = floatTo16kWav(Float32Array.from(buf), ctx.sampleRate);
  buf = [];
  const b64 = btoa(String.fromCharCode(...wav));
  const r = await fetch(FC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ audio_b64: b64, mime: "audio/wav", language: "en" }),
  });
  const { text } = await r.json();
  appendTranscript(text);
}, 3000);
```

The browser must send **base64 of a complete 16 kHz mono 16-bit WAV** as `audio_b64`. That is the exact encoding the server snippet expects.

---

## Sources
- Qwen-ASR API reference (OpenAI-compatible + DashScope, request/response, asr_options): https://www.alibabacloud.com/help/en/model-studio/qwen-asr-api-reference
- Audio file recognition (qwen3-asr-flash / qwen3-asr-flash-filetrans, formats, limits): https://www.alibabacloud.com/help/en/model-studio/qwen-speech-recognition
- Paraformer real-time (WebSocket, 16 kHz PCM, timestamps): https://www.alibabacloud.com/help/en/model-studio/websocket-for-paraformer-real-time-service
- Paraformer recorded-file RESTful API (diarization_enabled / speaker_count / speaker_id, public URL only): https://www.alibabacloud.com/help/en/model-studio/paraformer-recorded-speech-recognition-restful-api
- OpenAI-compatible base URL (dashscope-intl.aliyuncs.com/compatible-mode/v1): https://www.alibabacloud.com/help/en/model-studio/compatibility-of-openai-with-dashscope
- Pricing / free tier: https://www.alibabacloud.com/help/en/model-studio/model-pricing , https://openrouter.ai/qwen/qwen3-asr-flash-2026-02-10/pricing
- Formats list (webm/opus/aac etc.): https://www.xugj520.cn/en/archives/qwen3-asr-vs-qwen-audio-asr-guide.html
