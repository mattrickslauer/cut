#!/usr/bin/env python3
"""
Cut! — Audition Room co-star reader (Alibaba Function Compute web function, scale-to-zero).

Self-contained: its own FC function (cut-audition), stdlib-only, holds the DashScope key
server-side. Deploys independently of the director's cut-perceive function.

  GET  /health  -> liveness + config sanity
  GET  /warm    -> no-op that spins a cold instance up before an audition starts
  POST /costar  -> { audio|text, scene, history? } -> the AI scene-partner's turn:
                   ASR the actor's line (or take `text` if the browser already
                   transcribed it — the fast path), generate the character's spoken
                   reply (qwen-flash), voice it in-character. The reply model tags each
                   line with an emotion; we translate that into a delivery instruction and
                   voice it with qwen3-tts-instruct-flash so it acts, not just reads. One
                   round-trip = one beat.
  POST /say     -> { text, voice?, emotion?, instructions?, tone? } -> { audio } : voice
                   arbitrary text (the opening line, a "Line!" prompt), expressively — pass
                   an emotion word or an explicit delivery instruction. Whole scene spoken.
  POST /portrait-> { character, tone? } -> { image, image_url } : a head-and-shoulders
                   portrait of the co-star (qwen-image), framed for talking-head animation.
                   First half of the scripted "compile" pass (avatar video is the second).
  POST /avatar  -> { image, audio|audio_url, prompt?, duration? } -> { task_id } : submit an
                   audio-driven talking-head video (wan2.7-i2v) — portrait as first frame,
                   the line's audio as the lip-sync driver. Pass base64 `audio` and it's hosted
                   on OSS (wan needs a public url); or pass your own `audio_url`. Minutes-scale.
  GET  /avatar?task_id=... -> { status, video?, error? } : poll it; video is an inlined mp4.

WHY TURN-BASED HTTP (not a streaming WebSocket): a scale-to-zero FC function can't hold a
persistent socket without breaking scale-to-zero. A scene partner delivers *lines* with
natural beats, so one POST per turn (ASR -> reply -> TTS, ~1-2s) reads as an acting pause,
not lag. Cold start only hits the first POST after idle — hidden behind GET /warm on
"Start audition". True barge-in/overlap is a v2 off the FC path.

Runs identically locally (`QWEN_API_KEY=... PORT=8787 python3 app.py`) and on FC
(listens on $FC_SERVER_PORT, default 9000).
"""
import os, json, base64, time, hmac, hashlib, urllib.request, urllib.error
from email.utils import formatdate
from urllib.parse import urlparse, parse_qs, quote
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

DASHSCOPE_URL = "https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions"
# Text-to-image (async submit + poll) — used to generate the co-star's portrait for the
# talking-head "compile" pass. Same endpoint the perception service uses for backgrounds.
IMG_SUBMIT = "https://dashscope-intl.aliyuncs.com/api/v1/services/aigc/text2image/image-synthesis"
TASK_POLL = "https://dashscope-intl.aliyuncs.com/api/v1/tasks/"
PORTRAIT_MODEL = os.environ.get("PORTRAIT_MODEL", "qwen-image")
# Audio-driven talking-head video for the "compile" pass. On the intl/Singapore key the dedicated
# talking-head models (EMO, wan2.2-s2v) are Beijing-only; wan2.7-i2v is the intl route — it takes a
# first-frame portrait (base64 OK) + a driving_audio track (must be a PUBLIC URL, not base64) and
# lip-syncs the face to it. Minutes-scale + async, so /avatar submits and the browser polls.
VIDEO_SUBMIT = "https://dashscope-intl.aliyuncs.com/api/v1/services/aigc/video-generation/video-synthesis"
AVATAR_MODEL = os.environ.get("AVATAR_MODEL", "wan2.7-i2v-2026-04-25")
AVATAR_RES = os.environ.get("AVATAR_RES", "720P")
AVATAR_PROMPT = os.environ.get(
    "AVATAR_PROMPT",
    "A person speaking directly to camera, natural expression, subtle head movement, lips synced "
    "to the speech, static plain background, single person",
)
# qwen-tts lives on the native multimodal-generation endpoint (synchronous, returns an audio URL).
# Flash and instruct-flash share this endpoint and response shape; instruct-flash additionally
# reads input.instructions for expressive delivery. (Verified against Model Studio qwen-tts docs.)
TTS_SUBMIT = "https://dashscope-intl.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation"
ASR_MODEL = os.environ.get("ASR_MODEL", "qwen3-asr-flash")
COSTAR_MODEL = os.environ.get("COSTAR_MODEL", "qwen-flash")  # fastest good reply (~1.5s vs qwen-max ~2.2s)
TTS_MODEL = os.environ.get("TTS_MODEL", "qwen3-tts-flash")  # verified live on the intl Model Studio key
# Expressive delivery: qwen3-tts-flash IGNORES style — only qwen3-tts-instruct-flash reads a
# natural-language `instructions` string (no emotion enum; you describe the delivery in words).
# Same endpoint + response shape as flash, so we just swap the model and add `instructions`.
TTS_INSTRUCT_MODEL = os.environ.get("TTS_INSTRUCT_MODEL", "qwen3-tts-instruct-flash")
TTS_EXPRESSIVE = os.environ.get("TTS_EXPRESSIVE", "1").strip() not in ("0", "false", "no", "")
TTS_VOICE = os.environ.get("TTS_VOICE", "Cherry")  # per-character voice overrides this
TTS_LANG = os.environ.get("TTS_LANG", "English")   # nudge qwen3-tts-flash toward natural English prosody
API_KEY = os.environ.get("QWEN_API_KEY", "").strip().strip('"').strip("'")

# Alibaba OSS — where a co-star line's TTS WAV is hosted so wan2.7-i2v can fetch it (it requires a
# public url for driving_audio; base64 isn't accepted). We PUT the bytes then hand out a presigned
# GET url, so it works whether or not the bucket allows public-read. Stdlib OSS V1 signing.
OSS_ENDPOINT = os.environ.get("OSS_ENDPOINT", "oss-ap-southeast-1.aliyuncs.com")  # match your DashScope region
OSS_BUCKET = os.environ.get("OSS_BUCKET", "").strip()
OSS_KEY_ID = os.environ.get("OSS_KEY_ID", "").strip()
OSS_KEY_SECRET = os.environ.get("OSS_KEY_SECRET", "").strip()
OSS_PREFIX = os.environ.get("OSS_PREFIX", "cut-audition/")

# One-word emotion labels (from the co-star reply model) → concrete vocal-delivery instructions.
# The docs are explicit: describe pitch/pace/emphasis, not vague mood words. Unknown labels fall
# through to a generic template and rely on optimize_instructions to expand them.
EMOTION_DIRECTION = {
    "angry": "Speak with sharp, forceful anger; raised volume, hard emphasis, fast clipped pace.",
    "furious": "Speak with explosive fury; loud, biting, rapid, barely controlled.",
    "cold": "Speak in a flat, cold, detached tone; low pitch, minimal inflection, deliberate pace.",
    "tender": "Speak softly and warmly, gentle and intimate, slow with a soft breathy tone.",
    "warm": "Speak warmly and openly, relaxed and kind, easy natural rhythm.",
    "sad": "Speak with quiet sadness; low, heavy, slow, a slight tremble.",
    "grief": "Speak through grief; broken, halting, barely holding it together.",
    "anxious": "Speak with nervous anxiety; slightly fast, uneven rhythm, tense higher pitch.",
    "afraid": "Speak with fear; hushed, unsteady, quick shallow breaths between words.",
    "nervous": "Speak nervously; hesitant, uneven, a little too fast.",
    "playful": "Speak in a light, teasing, playful tone with a bright bouncy rhythm and a smile in the voice.",
    "flirty": "Speak with a teasing, flirtatious lilt; warm, unhurried, a smile in the voice.",
    "excited": "Speak with bright excitement; energetic, quick, rising intonation.",
    "joyful": "Speak with open joy; warm, buoyant, lively pace.",
    "desperate": "Speak with raw desperation; urgent, straining, pleading emphasis.",
    "pleading": "Speak pleadingly; soft but urgent, rising, imploring.",
    "sarcastic": "Speak with dry sarcasm; flat exaggerated emphasis, a knowing edge.",
    "menacing": "Speak with quiet menace; low, slow, controlled, dangerous calm.",
    "commanding": "Speak with hard authority; firm, measured, weighted emphasis.",
    "defeated": "Speak defeated; low, drained, slow, without energy.",
    "hopeful": "Speak with cautious hope; gentle warmth, gradually lifting.",
    "confused": "Speak with uncertainty; searching, uneven, trailing intonation.",
    "tense": "Speak with held tension; tight, controlled, clipped.",
    "neutral": "Speak naturally and conversationally, grounded and in character.",
}


def emotion_to_instruction(emotion, tone=None):
    """Turn a one-word emotion (+ optional scene tone) into a concrete delivery instruction.
    Returns None when there's nothing to say, so callers stay on the plain (non-instruct) path."""
    e = (emotion or "").strip().lower()
    if not e or e == "neutral":
        base = EMOTION_DIRECTION["neutral"] if tone else None
    else:
        base = EMOTION_DIRECTION.get(e) or f"Speak with a distinctly {e} tone, in character; let it color pitch, pace, and emphasis."
    if base and tone:
        base += f" Overall register: {str(tone).strip()}."
    return base


def _post(url, payload, headers=None, timeout=30):
    h = {"Authorization": f"Bearer {API_KEY}", "Content-Type": "application/json"}
    if headers:
        h.update(headers)
    req = urllib.request.Request(url, data=json.dumps(payload).encode(), headers=h, method="POST")
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode())


def transcribe(audio_data_url, language="en"):
    """One-shot ASR via qwen3-asr-flash over the OpenAI-compatible endpoint.
    audio_data_url is a 'data:audio/wav;base64,...' URI. Returns text + emotion."""
    body = _post(DASHSCOPE_URL, {
        "model": ASR_MODEL,
        "messages": [{"role": "user", "content": [
            {"type": "input_audio", "input_audio": {"data": audio_data_url}}]}],
        "asr_options": {"language": language, "enable_itn": True},
    })
    msg = body["choices"][0]["message"]
    emotion = None
    for a in (msg.get("annotations") or []):
        if a.get("type") == "audio_info":
            emotion = a.get("emotion")
    return {"text": (msg.get("content") or "").strip(), "emotion": emotion, "usage": body.get("usage", {})}


def costar_reply(scene, history, actor_line, actor_emotion=None):
    """The AI scene-partner's turn. Given the scene setup, the dialogue so far, and the
    actor's just-delivered line (+ detected emotion), stay in character and return ONE
    spoken line — plus a private coaching note on the delivery (the 'tune' half of the
    product). qwen-max, json out, short reply for low latency."""
    ai_char = scene.get("ai_character", "the scene partner")
    human_char = scene.get("human_character", "the actor")
    system = (
        f"You are a professional acting scene-partner AI for a self-tape audition. You play "
        f"the character '{ai_char}'. The actor auditioning plays '{human_char}'. "
        f"SCENE: {scene.get('premise', 'an unscripted improv')}. "
        f"TONE: {scene.get('tone', 'natural, grounded')}. "
        + (f"SCRIPT — follow it: deliver {ai_char}'s next line from this script, in order, staying on the "
           f"written words as closely as a natural performance allows. If the actor drifts, bridge briefly "
           f"and steer back to the script. SCRIPT:\n{(scene.get('script') or '').strip()[:2500]}\n "
           if (scene.get('script') or '').strip() else "") +
        "Stay fully in character. Respond with ONE natural spoken line that reacts truthfully "
        "to what the actor just said and keeps the scene alive — never narrate, never break "
        "character, no stage directions inside the spoken line, no emojis. Match the scene's "
        "emotional temperature; if the actor plays big, meet them; if they underplay, hold the "
        "tension. Keep the line to one or two short sentences — say it in a breath — for a fast, "
        "snappy exchange, unless a big moment earns more. "
        "SEPARATELY, as a casting-savvy reader, give a one-sentence private 'note' on the actor's "
        "delivery (specific and useful — pace, choice, listening, stakes), and rate 'stakes' 1-5. "
        "Respond ONLY as compact json: {\"line\": string, \"emotion\": one word for how you say it, "
        "\"note\": string, \"stakes\": integer 1-5}."
    )
    lines = [{"role": "system", "content": system}]
    if scene.get("opening"):
        lines.append({"role": "assistant", "content": json.dumps(
            {"line": scene["opening"], "emotion": "neutral", "note": "", "stakes": 3})})
    for turn in (history or [])[-8:]:                      # cap context; keep the last few beats
        role = "user" if turn.get("who") == "actor" else "assistant"
        lines.append({"role": role, "content": turn.get("text", "")})
    cue = actor_line + (f"  [delivered {actor_emotion}]" if actor_emotion else "")
    lines.append({"role": "user", "content": cue})
    body = _post(DASHSCOPE_URL, {"model": COSTAR_MODEL, "response_format": {"type": "json_object"},
                                 "max_tokens": 120, "temperature": 0.8, "messages": lines})
    content = body["choices"][0]["message"]["content"]
    try:
        out = json.loads(content)
    except json.JSONDecodeError:
        out = {"line": content.strip()[:200], "emotion": "neutral", "note": "", "stakes": 3}
    out["_usage"] = body.get("usage", {})
    return out


# Latched to False the first time the instruct model 4xx's, so an unavailable instruct model
# costs one failed call, not one per line. Wrapped in a list for cheap mutation from synthesize().
_INSTRUCT_OK = [True]


def _tts_call(model, text, voice, instruction=None):
    inp = {"text": text, "voice": voice or TTS_VOICE, "language_type": TTS_LANG}
    if instruction:
        inp["instructions"] = instruction       # only qwen3-tts-instruct-flash reads this
        inp["optimize_instructions"] = True      # let the model expand a terse instruction well
    out = _post(TTS_SUBMIT, {"model": model, "input": inp, "parameters": {}}).get("output", {})
    audio = out.get("audio", {}) or {}
    if audio.get("data"):                                  # inline base64 (streamed models)
        return "data:audio/wav;base64," + audio["data"]
    if audio.get("url"):                                   # fetch + inline the bytes (mixable, no CORS taint)
        with urllib.request.urlopen(audio["url"], timeout=30) as r:
            raw, ctype = r.read(), r.headers.get("Content-Type", "audio/wav")
        return "data:%s;base64,%s" % (ctype, base64.b64encode(raw).decode())
    raise RuntimeError("tts returned no audio: " + json.dumps(out)[:200])


def synthesize(text, voice=None, emotion=None, instruction=None, tone=None):
    """Voice a line, in character. Returns a same-origin 'data:audio/...;base64,...' URI — we
    re-host the OSS bytes on purpose: the OSS URL sends no CORS headers, so the browser can't
    route it through Web Audio without tainting, and we need it mixable into the recorded tape.

    Expressive path: when a delivery cue exists (an explicit `instruction`, or an `emotion`
    label we translate into one) and TTS_EXPRESSIVE is on, voice it with the instruct model.
    If that model 4xx's (unavailable / bad param), fall back to plain qwen3-tts-flash so a line
    is never lost to a style hiccup."""
    direction = instruction or (emotion_to_instruction(emotion, tone) if TTS_EXPRESSIVE else None)
    if direction and _INSTRUCT_OK[0]:
        try:
            return _tts_call(TTS_INSTRUCT_MODEL, text, voice, direction)
        except urllib.error.HTTPError as e:
            if e.code >= 500:                              # server hiccup, not a bad request — surface it
                raise
            # 4xx: instruct model/param unavailable on this key. Degrade to plain voice, and latch
            # instruct off so we don't burn a failed round-trip on every subsequent line.
            _INSTRUCT_OK[0] = False
    return _tts_call(TTS_MODEL, text, voice)


def _submit_task(url, body):
    """Submit an async DashScope task (X-DashScope-Async) and return its task_id."""
    req = urllib.request.Request(
        url, data=json.dumps(body).encode(),
        headers={"Authorization": f"Bearer {API_KEY}", "Content-Type": "application/json",
                 "X-DashScope-Async": "enable"}, method="POST")
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read().decode())["output"]["task_id"]


def _task_output(task_id):
    """One poll of /tasks/{id}; returns the output object (task_status + results/urls)."""
    req = urllib.request.Request(TASK_POLL + task_id, headers={"Authorization": f"Bearer {API_KEY}"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read().decode())["output"]


def _submit_and_poll(url, body, tries=40, interval=1.5):
    """Submit + block-poll until SUCCEEDED — for fast tasks (images, ~10-30s). Long tasks (video)
    submit via _submit_task and let the caller poll so the HTTP request isn't held for minutes."""
    task_id = _submit_task(url, body)
    for _ in range(tries):
        time.sleep(interval)
        out = _task_output(task_id)
        st = out.get("task_status")
        if st == "SUCCEEDED":
            return out
        if st == "FAILED":
            raise RuntimeError("task failed: " + json.dumps(out)[:200])
    raise TimeoutError("task timed out: " + task_id)


def _rehost(url, timeout=60):
    """Inline an OSS result URL as a same-origin data URI (OSS urls expire in 24h + send no CORS)."""
    with urllib.request.urlopen(url, timeout=timeout) as r:
        raw, ctype = r.read(), r.headers.get("Content-Type", "application/octet-stream")
    return "data:%s;base64,%s" % (ctype, base64.b64encode(raw).decode())


def generate_portrait(character, tone=None):
    """A head-and-shoulders portrait of the co-star, framed for talking-head animation (front
    view, plain background, mouth closed). Returns the inlined image plus the source OSS url —
    some avatar models want a public url rather than base64."""
    desc = (character or "a person").split(",")
    who = desc[0].strip() or "a person"
    detail = ", ".join(d.strip() for d in desc[1:]).strip()
    prompt = (
        f"Cinematic head-and-shoulders portrait photograph of {who}"
        + (f" — {detail}" if detail else "")
        + ". Front view, looking straight at camera, neutral plain studio background, soft key "
        "light, natural skin texture, photographic, shallow depth of field, single person, "
        "centered, head and shoulders in frame, mouth closed, calm neutral expression"
        + (f". Mood: {tone}." if tone else ".")
    )
    out = _submit_and_poll(IMG_SUBMIT, {"model": PORTRAIT_MODEL, "input": {"prompt": prompt},
                                        "parameters": {"size": "1024*1024", "n": 1}})
    url = out["results"][0]["url"]
    return {"image": _rehost(url), "image_url": url}


def _decode_data_uri(uri):
    """'data:audio/wav;base64,AAAA' -> (raw_bytes, content_type, ext)."""
    head, _, b64 = (uri or "").partition(",")
    ctype = "application/octet-stream"
    if head.startswith("data:"):
        ctype = head[5:].split(";")[0] or ctype
    ext = {"audio/wav": "wav", "audio/x-wav": "wav", "audio/mpeg": "mp3", "audio/mp3": "mp3",
           "image/png": "png", "image/jpeg": "jpg"}.get(ctype, "bin")
    return base64.b64decode(b64), ctype, ext


def oss_enabled():
    return bool(OSS_BUCKET and OSS_KEY_ID and OSS_KEY_SECRET)


def _oss_sign(string_to_sign):
    return base64.b64encode(
        hmac.new(OSS_KEY_SECRET.encode(), string_to_sign.encode(), hashlib.sha1).digest()
    ).decode()


def oss_host(raw, content_type, ext, ttl=7200):
    """PUT bytes to OSS (key = content hash, so identical audio de-dupes) and return a presigned
    GET url valid `ttl` seconds — long enough for the minutes-scale video task to fetch it."""
    if not oss_enabled():
        raise RuntimeError("OSS not configured — set OSS_BUCKET / OSS_KEY_ID / OSS_KEY_SECRET")
    key = OSS_PREFIX + hashlib.sha1(raw).hexdigest() + "." + ext
    host = f"{OSS_BUCKET}.{OSS_ENDPOINT}"
    date = formatdate(usegmt=True)
    # NB: keep the string-to-sign in its own variable — a backslash inside an f-string
    # expression is a SyntaxError before Python 3.12 (the FC custom runtime is older).
    put_sts = f"PUT\n\n{content_type}\n{date}\n/{OSS_BUCKET}/{key}"
    put = urllib.request.Request(
        f"https://{host}/{key}", data=raw, method="PUT",
        headers={"Authorization": f"OSS {OSS_KEY_ID}:{_oss_sign(put_sts)}",
                 "Date": date, "Content-Type": content_type, "Host": host})
    with urllib.request.urlopen(put, timeout=60) as r:
        r.read()
    expires = int(time.time()) + ttl
    sig = quote(_oss_sign(f"GET\n\n\n{expires}\n/{OSS_BUCKET}/{key}"), safe="")
    return f"https://{host}/{key}?OSSAccessKeyId={OSS_KEY_ID}&Expires={expires}&Signature={sig}"


def submit_avatar(image, audio_url, prompt=None, duration=None):
    """Kick off an audio-driven talking-head video (wan2.7-i2v): the portrait as the first frame,
    the co-star line's audio as the lip-sync driver. Returns a task_id — the browser polls it.
    `image` may be a base64 data URI; `audio_url` MUST be a public URL DashScope can fetch."""
    body = {
        "model": AVATAR_MODEL,
        "input": {
            "prompt": prompt or AVATAR_PROMPT,
            "media": [
                {"type": "first_frame", "url": image},
                {"type": "driving_audio", "url": audio_url},
            ],
        },
        "parameters": {"resolution": AVATAR_RES, "prompt_extend": True,
                       **({"duration": int(duration)} if duration else {})},
    }
    return _submit_task(VIDEO_SUBMIT, body)


def avatar_status(task_id):
    """Poll a talking-head task once. When done, inline the resulting mp4 as a data URI so the
    browser can composite it into the take without CORS taint."""
    out = _task_output(task_id)
    st = out.get("task_status")
    res = {"status": st}
    if st == "SUCCEEDED":
        url = out.get("video_url") or ((out.get("results") or [{}])[0] or {}).get("url")
        res["video"] = _rehost(url) if url else None
        res["video_url"] = url
    elif st in ("FAILED", "CANCELED", "UNKNOWN"):
        res["error"] = out.get("message") or json.dumps(out)[:200]
    return res


def costar(scene, history, audio_data_url=None, text=None):
    """One audition beat: hear the actor -> reply in character -> voice it.
    `text` skips ASR entirely (the browser already transcribed the line) — the fast path."""
    if text is not None:
        heard = {"text": text, "emotion": None}
    else:
        heard = transcribe(audio_data_url, scene.get("language", "en"))
    reply = costar_reply(scene, history, heard.get("text", ""), heard.get("emotion"))
    try:
        spoken = synthesize(reply.get("line", ""), scene.get("voice") or TTS_VOICE,
                            emotion=reply.get("emotion"), tone=scene.get("tone"))
    except Exception as e:                                 # never lose the line if TTS hiccups
        spoken, reply["_tts_error"] = None, str(e)[:200]
    return {"heard": heard, "line": reply.get("line", ""), "emotion": reply.get("emotion"),
            "note": reply.get("note", ""), "stakes": reply.get("stakes"), "audio": spoken}


class Handler(BaseHTTPRequestHandler):
    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def _json(self, code, obj):
        data = json.dumps(obj).encode()
        self.send_response(code); self._cors()
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_OPTIONS(self):
        self.send_response(204); self._cors(); self.end_headers()

    def do_GET(self):
        u = urlparse(self.path)
        path = u.path.rstrip("/")
        if path == "/warm":                        # cheap pre-roll: spins a cold instance up
            return self._json(200, {"warm": True})
        if path == "/avatar":                      # poll a talking-head task: /avatar?task_id=...
            tid = (parse_qs(u.query).get("task_id") or [""])[0]
            if not tid:
                return self._json(400, {"error": "missing 'task_id'"})
            if not API_KEY:
                return self._json(500, {"error": "QWEN_API_KEY not configured"})
            try:
                return self._json(200, avatar_status(tid))
            except urllib.error.HTTPError as e:
                return self._json(502, {"error": "dashscope", "detail": e.read().decode()[:300]})
            except Exception as e:
                return self._json(500, {"error": str(e)})
        if path in ("/health", ""):
            return self._json(200, {"ok": True, "asr_model": ASR_MODEL,
                                    "costar_model": COSTAR_MODEL, "tts_model": TTS_MODEL,
                                    "tts_instruct_model": TTS_INSTRUCT_MODEL,
                                    "expressive": TTS_EXPRESSIVE, "has_key": bool(API_KEY),
                                    "avatar_model": AVATAR_MODEL, "oss": oss_enabled()})
        self._json(404, {"error": "not found"})

    def do_POST(self):
        path = urlparse(self.path).path.rstrip("/")
        if path not in ("/costar", "/say", "/portrait", "/avatar"):
            return self._json(404, {"error": "not found"})
        if not API_KEY:
            return self._json(500, {"error": "QWEN_API_KEY not configured"})
        try:
            n = int(self.headers.get("Content-Length", 0))
            req = json.loads(self.rfile.read(n).decode() or "{}")
        except Exception as e:
            return self._json(400, {"error": f"bad request: {e}"})
        try:
            if path == "/say":                             # voice arbitrary text (e.g. the opening line)
                if not req.get("text"):
                    return self._json(400, {"error": "missing 'text'"})
                return self._json(200, {"audio": synthesize(
                    req["text"], req.get("voice"),
                    emotion=req.get("emotion"), instruction=req.get("instructions"),
                    tone=req.get("tone"))})
            if path == "/portrait":                        # co-star's face for the talking-head compile
                if not req.get("character"):
                    return self._json(400, {"error": "missing 'character'"})
                return self._json(200, generate_portrait(req["character"], req.get("tone")))
            if path == "/avatar":                          # submit a talking-head video → { task_id }
                if not req.get("image"):
                    return self._json(400, {"error": "missing 'image'"})
                audio_url = req.get("audio_url")
                if not audio_url and req.get("audio"):      # base64 WAV → host on OSS → public url
                    raw, ctype, ext = _decode_data_uri(req["audio"])
                    audio_url = oss_host(raw, ctype, ext)
                if not audio_url:
                    return self._json(400, {"error": "need 'audio' (base64) or public 'audio_url'"})
                tid = submit_avatar(req["image"], audio_url, req.get("prompt"), req.get("duration"))
                return self._json(202, {"task_id": tid})
            if not req.get("audio") and not req.get("text"):
                return self._json(400, {"error": "missing 'audio' or 'text'"})
            if not req.get("scene"):
                return self._json(400, {"error": "missing 'scene'"})
            return self._json(200, costar(req["scene"], req.get("history") or [],
                                          req.get("audio"), req.get("text")))
        except urllib.error.HTTPError as e:
            return self._json(502, {"error": "dashscope", "detail": e.read().decode()[:300]})
        except Exception as e:
            return self._json(500, {"error": str(e)})

    def log_message(self, *a):  # quieter logs
        pass


if __name__ == "__main__":
    port = int(os.environ.get("FC_SERVER_PORT") or os.environ.get("PORT") or 9000)
    print(f"cut audition co-star on :{port}  reader={COSTAR_MODEL}  tts={TTS_MODEL}  key={'set' if API_KEY else 'MISSING'}")
    ThreadingHTTPServer(("0.0.0.0", port), Handler).serve_forever()
