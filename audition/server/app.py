#!/usr/bin/env python3
"""
Cut! — Audition Room co-star reader (Alibaba Function Compute web function, scale-to-zero).

Self-contained: its own FC function (cut-audition), stdlib-only, holds the DashScope key
server-side. Deploys independently of the director's cut-perceive function.

  GET  /health  -> liveness + config sanity
  GET  /warm    -> no-op that spins a cold instance up before an audition starts
  POST /costar  -> { audio, scene, history? } -> the AI scene-partner's turn:
                   ASR the actor's line, generate the character's spoken reply
                   (qwen-max), voice it (qwen-tts). One HTTP round-trip = one beat.

WHY TURN-BASED HTTP (not a streaming WebSocket): a scale-to-zero FC function can't hold a
persistent socket without breaking scale-to-zero. A scene partner delivers *lines* with
natural beats, so one POST per turn (ASR -> reply -> TTS, ~1-2s) reads as an acting pause,
not lag. Cold start only hits the first POST after idle — hidden behind GET /warm on
"Start audition". True barge-in/overlap is a v2 off the FC path.

Runs identically locally (`QWEN_API_KEY=... PORT=8787 python3 app.py`) and on FC
(listens on $FC_SERVER_PORT, default 9000).
"""
import os, json, base64, urllib.request, urllib.error
from urllib.parse import urlparse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

DASHSCOPE_URL = "https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions"
# qwen-tts lives on the native multimodal-generation endpoint (synchronous, returns an audio URL).
# NOTE: verify model id / voices / response shape against Model Studio docs like asr.md did for ASR.
TTS_SUBMIT = "https://dashscope-intl.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation"
ASR_MODEL = os.environ.get("ASR_MODEL", "qwen3-asr-flash")
COSTAR_MODEL = os.environ.get("COSTAR_MODEL", "qwen-max")
TTS_MODEL = os.environ.get("TTS_MODEL", "qwen-tts")
TTS_VOICE = os.environ.get("TTS_VOICE", "Cherry")  # per-character voice overrides this
API_KEY = os.environ.get("QWEN_API_KEY", "").strip().strip('"').strip("'")


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
        lines.append({"role": "assistant", "content": json.dumps(
            {"line": scene["opening"], "emotion": "neutral", "note": "", "stakes": 3})})
    for turn in (history or [])[-8:]:                      # cap context; keep the last few beats
        role = "user" if turn.get("who") == "actor" else "assistant"
        lines.append({"role": role, "content": turn.get("text", "")})
    cue = actor_line + (f"  [delivered {actor_emotion}]" if actor_emotion else "")
    lines.append({"role": "user", "content": cue})
    body = _post(DASHSCOPE_URL, {"model": COSTAR_MODEL, "response_format": {"type": "json_object"},
                                 "max_tokens": 200, "temperature": 0.8, "messages": lines})
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
    out = _post(TTS_SUBMIT, {"model": TTS_MODEL,
                             "input": {"text": text, "voice": voice or TTS_VOICE},
                             "parameters": {}}).get("output", {})
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
    try:
        spoken = synthesize(reply.get("line", ""), scene.get("voice") or TTS_VOICE)
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
        path = urlparse(self.path).path.rstrip("/")
        if path == "/warm":                        # cheap pre-roll: spins a cold instance up
            return self._json(200, {"warm": True})
        if path in ("/health", ""):
            return self._json(200, {"ok": True, "asr_model": ASR_MODEL,
                                    "costar_model": COSTAR_MODEL, "tts_model": TTS_MODEL,
                                    "has_key": bool(API_KEY)})
        self._json(404, {"error": "not found"})

    def do_POST(self):
        path = urlparse(self.path).path.rstrip("/")
        if path != "/costar":
            return self._json(404, {"error": "not found"})
        if not API_KEY:
            return self._json(500, {"error": "QWEN_API_KEY not configured"})
        try:
            n = int(self.headers.get("Content-Length", 0))
            req = json.loads(self.rfile.read(n).decode() or "{}")
        except Exception as e:
            return self._json(400, {"error": f"bad request: {e}"})
        if not req.get("audio"):
            return self._json(400, {"error": "missing 'audio'"})
        if not req.get("scene"):
            return self._json(400, {"error": "missing 'scene'"})
        try:
            return self._json(200, costar(req["scene"], req.get("history") or [], req["audio"]))
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
