#!/usr/bin/env python3
"""
Cut! — Perception + Co-star service (Alibaba Function Compute web function, scale-to-zero).

Holds the DashScope key server-side and exposes:
  GET  /health   -> liveness + config sanity
  GET  /warm     -> no-op that spins a cold instance up before an audition starts
  POST /perceive -> { image: <dataURL/base64 jpeg>, prior?: {...} }
                    calls qwen3-vl-flash and returns the Director's read as JSON.
  POST /transcribe -> { audio: <data:audio/wav;base64,...> } -> qwen3-asr-flash text.
  POST /costar   -> { audio, scene, history? } -> the AI scene-partner's turn:
                    ASR the actor's line, generate the character's spoken reply
                    (qwen-max), voice it (qwen-tts). One HTTP round-trip = one beat.

Zero third-party deps (stdlib only) so FC packaging is trivial. Runs identically
locally (`PORT=8787 python3 app.py`) and on FC (listens on $FC_SERVER_PORT, default 9000).

WHY TURN-BASED HTTP (not a streaming WebSocket): a scale-to-zero FC function can't
hold a persistent socket without breaking scale-to-zero. A scene partner delivers
*lines* with natural beats, so one POST per turn (ASR -> reply -> TTS, ~1-2s) reads
as an acting pause, not lag. Cold start only hits the first POST after idle — hidden
behind GET /warm on "Start audition". True barge-in/overlap is a v2 off the FC path.
"""
import os, json, time, base64, urllib.request, urllib.error
from urllib.parse import urlparse, parse_qs
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

DASHSCOPE_URL = "https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions"
IMG_SUBMIT = "https://dashscope-intl.aliyuncs.com/api/v1/services/aigc/text2image/image-synthesis"
IMG_TASK = "https://dashscope-intl.aliyuncs.com/api/v1/tasks/"
# qwen-tts lives on the native multimodal-generation endpoint (synchronous, returns an audio URL).
# NOTE: verify model id / voices / response shape against Model Studio docs like asr.md did for ASR.
TTS_SUBMIT = "https://dashscope-intl.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation"
MODEL = os.environ.get("PERCEPTION_MODEL", "qwen3-vl-flash")
IMAGE_MODEL = os.environ.get("IMAGE_MODEL", "qwen-image")
ASR_MODEL = os.environ.get("ASR_MODEL", "qwen3-asr-flash")
COSTAR_MODEL = os.environ.get("COSTAR_MODEL", "qwen-max")
TTS_MODEL = os.environ.get("TTS_MODEL", "qwen-tts")
TTS_VOICE = os.environ.get("TTS_VOICE", "Cherry")  # per-character voice overrides this
API_KEY = os.environ.get("QWEN_API_KEY", "").strip().strip('"').strip("'")

SYSTEM = (
    "You are the PERCEPTION + DIRECTOR module of Cut!, an AI film director watching a "
    "live improv performance between two people in front of a camera. Given ONE video "
    "frame, read the moment and make a decisive directorial call. Judge from facial "
    "expression, body language, and gesture. Respond ONLY as compact json with keys: "
    "speaker (A|B|both|none), emotion (one word), action (short phrase), "
    "setting (the fictional location the improv implies, e.g. 'interrogation room'), "
    "scene_change (boolean: true if this reads as a new scene/location), "
    "suggested_shot (WIDE|MS|MCU|CU|OTS), "
    "suggested_look (Neutral|Noir|Sci-Fi|Golden|Thriller — match the mood), "
    "director_note (a vivid directing call, max 12 words). Be decisive, never hedge. "
    "Convention: character A is the performer on the LEFT of frame, B is on the RIGHT."
)


def perceive(image_data_url, prior=None):
    hint = ""
    if prior:
        hint = f" Prior read for continuity: {json.dumps(prior)[:300]}."
    payload = {
        "model": MODEL,
        "response_format": {"type": "json_object"},
        "max_tokens": 220,
        "temperature": 0.4,
        "messages": [
            {"role": "system", "content": SYSTEM},
            {"role": "user", "content": [
                {"type": "text", "text": "Direct this frame. Return json." + hint},
                {"type": "image_url", "image_url": {"url": image_data_url}},
            ]},
        ],
    }
    req = urllib.request.Request(
        DASHSCOPE_URL,
        data=json.dumps(payload).encode(),
        headers={"Authorization": f"Bearer {API_KEY}", "Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=30) as r:
        body = json.loads(r.read().decode())
    content = body["choices"][0]["message"]["content"]
    try:
        read = json.loads(content)
    except json.JSONDecodeError:
        read = {"director_note": content[:120], "_unparsed": True}
    read["_usage"] = body.get("usage", {})
    read["_model"] = MODEL
    return read


def transcribe(audio_data_url, language="en"):
    """One-shot ASR via qwen3-asr-flash over the OpenAI-compatible endpoint.
    audio_data_url is a 'data:audio/wav;base64,...' URI. Returns text + emotion."""
    payload = {
        "model": ASR_MODEL,
        "messages": [
            {"role": "user", "content": [
                {"type": "input_audio", "input_audio": {"data": audio_data_url}},
            ]},
        ],
        "asr_options": {"language": language, "enable_itn": True},
    }
    req = urllib.request.Request(
        DASHSCOPE_URL, data=json.dumps(payload).encode(),
        headers={"Authorization": f"Bearer {API_KEY}", "Content-Type": "application/json"},
        method="POST")
    with urllib.request.urlopen(req, timeout=30) as r:
        body = json.loads(r.read().decode())
    msg = body["choices"][0]["message"]
    emotion = None
    for a in (msg.get("annotations") or []):
        if a.get("type") == "audio_info":
            emotion = a.get("emotion")
    return {"text": (msg.get("content") or "").strip(), "emotion": emotion, "usage": body.get("usage", {})}


def costar_reply(scene, history, actor_line, actor_emotion=None):
    """The AI scene-partner's turn. Given the scene setup, the dialogue so far, and
    the actor's just-delivered line (+ detected emotion), stay in character and return
    ONE spoken line — plus a private coaching note on the actor's delivery (the 'tune'
    half of the product). qwen-max, json out, low latency (short reply)."""
    ai_char = scene.get("ai_character", "the scene partner")
    human_char = scene.get("human_character", "the actor")
    system = (
        f"You are a professional acting scene-partner AI for a self-tape audition. You play "
        f"the character '{ai_char}'. The actor auditioning plays '{human_char}'. "
        f"SCENE: {scene.get('premise', 'an unscripted improv')}. "
        f"TONE: {scene.get('tone', 'natural, grounded')}. "
        "Stay fully in character. Respond with ONE natural spoken line that reacts truthfully "
        "to what the actor just said and keeps the scene alive — never narrate, never break "
        "character, no stage directions inside the spoken line, no emojis. Match the scene's "
        "emotional temperature; if the actor plays big, meet them; if they underplay, hold the "
        "tension. Keep the line short enough to say in one breath unless the moment earns more. "
        "SEPARATELY, as a casting-savvy reader, give a one-sentence private 'note' on the actor's "
        "delivery (specific and useful — pace, choice, listening, stakes), and rate 'stakes' 1-5. "
        "Respond ONLY as compact json: {\"line\": string, \"emotion\": one word for how you say it, "
        "\"note\": string, \"stakes\": integer 1-5}."
    )
    lines = [{"role": "system", "content": system}]
    if scene.get("opening"):
        lines.append({"role": "assistant", "content": json.dumps({"line": scene["opening"], "emotion": "neutral", "note": "", "stakes": 3})})
    for turn in (history or [])[-8:]:                      # cap context; keep the last few beats
        role = "user" if turn.get("who") == "actor" else "assistant"
        lines.append({"role": role, "content": turn.get("text", "")})
    cue = actor_line + (f"  [delivered {actor_emotion}]" if actor_emotion else "")
    lines.append({"role": "user", "content": cue})
    payload = {"model": COSTAR_MODEL, "response_format": {"type": "json_object"},
               "max_tokens": 200, "temperature": 0.8, "messages": lines}
    req = urllib.request.Request(
        DASHSCOPE_URL, data=json.dumps(payload).encode(),
        headers={"Authorization": f"Bearer {API_KEY}", "Content-Type": "application/json"},
        method="POST")
    with urllib.request.urlopen(req, timeout=30) as r:
        body = json.loads(r.read().decode())
    content = body["choices"][0]["message"]["content"]
    try:
        out = json.loads(content)
    except json.JSONDecodeError:
        out = {"line": content.strip()[:200], "emotion": "neutral", "note": "", "stakes": 3}
    out["_usage"] = body.get("usage", {})
    return out


def synthesize(text, voice=None):
    """Voice a line via qwen-tts (synchronous multimodal-generation). Returns a
    'data:audio/...;base64,...' URI the browser can play directly. Re-hosts the bytes
    because DashScope audio URLs expire. NOTE: verify model/voice/shape vs Model Studio."""
    payload = {"model": TTS_MODEL,
               "input": {"text": text, "voice": voice or TTS_VOICE},
               "parameters": {}}
    req = urllib.request.Request(
        TTS_SUBMIT, data=json.dumps(payload).encode(),
        headers={"Authorization": f"Bearer {API_KEY}", "Content-Type": "application/json"},
        method="POST")
    with urllib.request.urlopen(req, timeout=30) as r:
        out = json.loads(r.read().decode()).get("output", {})
    audio = out.get("audio", {}) or {}
    if audio.get("data"):                                  # inline base64 (some models)
        b64, ctype = audio["data"], "audio/wav"
    elif audio.get("url"):                                 # fetch + inline the bytes
        with urllib.request.urlopen(audio["url"], timeout=30) as r:
            raw, ctype = r.read(), r.headers.get("Content-Type", "audio/wav")
        b64 = base64.b64encode(raw).decode()
    else:
        raise RuntimeError("tts returned no audio: " + json.dumps(out)[:200])
    return f"data:{ctype};base64,{b64}"


def costar(scene, history, audio_data_url):
    """One audition beat: hear the actor -> reply in character -> voice it."""
    heard = transcribe(audio_data_url, scene.get("language", "en"))
    reply = costar_reply(scene, history, heard.get("text", ""), heard.get("emotion"))
    voice = (scene.get("voice") or TTS_VOICE)
    try:
        spoken = synthesize(reply["line"], voice)
    except Exception as e:                                 # never lose the line if TTS hiccups
        spoken, reply["_tts_error"] = None, str(e)[:200]
    return {"heard": heard, "line": reply.get("line", ""), "emotion": reply.get("emotion"),
            "note": reply.get("note", ""), "stakes": reply.get("stakes"), "audio": spoken}


def generate_image(prompt):
    """Text -> cinematic 16:9 environment still via qwen-image (async submit + poll).
    Returns (image_bytes, content_type). Styled to be an empty world (no people),
    since we composite the real performers on top."""
    styled = (prompt or "a cinematic empty stage").strip() + (
        ", cinematic establishing shot, empty environment, no people, no person, "
        "atmospheric dramatic lighting, film still, wide angle, photographic"
    )
    body = {"model": IMAGE_MODEL, "input": {"prompt": styled},
            "parameters": {"size": "1280*720", "n": 1}}
    req = urllib.request.Request(
        IMG_SUBMIT, data=json.dumps(body).encode(),
        headers={"Authorization": f"Bearer {API_KEY}", "Content-Type": "application/json",
                 "X-DashScope-Async": "enable"}, method="POST")
    with urllib.request.urlopen(req, timeout=30) as r:
        task_id = json.loads(r.read().decode())["output"]["task_id"]
    url = None
    for _ in range(35):                       # ~ up to 50s
        time.sleep(1.5)
        preq = urllib.request.Request(IMG_TASK + task_id,
                                      headers={"Authorization": f"Bearer {API_KEY}"})
        with urllib.request.urlopen(preq, timeout=30) as r:
            out = json.loads(r.read().decode())["output"]
        st = out.get("task_status")
        if st == "SUCCEEDED":
            url = out["results"][0]["url"]; break
        if st == "FAILED":
            raise RuntimeError("image gen failed: " + json.dumps(out)[:200])
    if not url:
        raise TimeoutError("image gen timed out")
    with urllib.request.urlopen(url, timeout=30) as r:   # re-host bytes (OSS url expires in 24h)
        return r.read(), r.headers.get("Content-Type", "image/png")


class Handler(BaseHTTPRequestHandler):
    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def _json(self, code, obj):
        data = json.dumps(obj).encode()
        self.send_response(code)
        self._cors()
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _bytes(self, code, data, ctype):
        self.send_response(code); self._cors()
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "public, max-age=86400")
        self.end_headers()
        self.wfile.write(data)

    def do_OPTIONS(self):
        self.send_response(204); self._cors(); self.end_headers()

    def do_GET(self):
        path = urlparse(self.path).path.rstrip("/")
        if path == "/background":
            if not API_KEY:
                return self._json(500, {"error": "QWEN_API_KEY not configured"})
            q = parse_qs(urlparse(self.path).query)
            prompt = (q.get("prompt", [""])[0] or q.get("q", [""])[0]).strip()
            try:
                data, ctype = generate_image(prompt)
                return self._bytes(200, data, ctype)
            except Exception as e:
                return self._json(502, {"error": str(e)[:200]})
        if path == "/warm":                        # cheap pre-roll: spins a cold instance up
            return self._json(200, {"warm": True})
        if path in ("/health", ""):
            return self._json(200, {"ok": True, "model": MODEL, "image_model": IMAGE_MODEL,
                                    "costar_model": COSTAR_MODEL, "tts_model": TTS_MODEL,
                                    "has_key": bool(API_KEY)})
        self._json(404, {"error": "not found"})

    def do_POST(self):
        path = urlparse(self.path).path.rstrip("/")
        if path not in ("/perceive", "/transcribe", "/costar"):
            return self._json(404, {"error": "not found"})
        if not API_KEY:
            return self._json(500, {"error": "QWEN_API_KEY not configured"})
        try:
            n = int(self.headers.get("Content-Length", 0))
            req = json.loads(self.rfile.read(n).decode() or "{}")
        except Exception as e:
            return self._json(400, {"error": f"bad request: {e}"})
        try:
            if path == "/perceive":
                image = req.get("image")
                if not image:
                    return self._json(400, {"error": "missing 'image'"})
                return self._json(200, perceive(image, req.get("prior")))
            elif path == "/costar":
                audio = req.get("audio")
                if not audio:
                    return self._json(400, {"error": "missing 'audio'"})
                if not req.get("scene"):
                    return self._json(400, {"error": "missing 'scene'"})
                return self._json(200, costar(req["scene"], req.get("history") or [], audio))
            else:  # /transcribe
                audio = req.get("audio")
                if not audio:
                    return self._json(400, {"error": "missing 'audio'"})
                return self._json(200, transcribe(audio, req.get("language", "en")))
        except urllib.error.HTTPError as e:
            return self._json(502, {"error": "dashscope", "detail": e.read().decode()[:300]})
        except Exception as e:
            return self._json(500, {"error": str(e)})

    def log_message(self, *a):  # quieter logs
        pass


if __name__ == "__main__":
    port = int(os.environ.get("FC_SERVER_PORT") or os.environ.get("PORT") or 9000)
    print(f"cut perception service on :{port}  model={MODEL}  key={'set' if API_KEY else 'MISSING'}")
    ThreadingHTTPServer(("0.0.0.0", port), Handler).serve_forever()
