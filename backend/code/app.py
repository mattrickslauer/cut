#!/usr/bin/env python3
"""
Cut! — Perception service (Alibaba Function Compute web function, scale-to-zero).

Holds the DashScope key server-side and exposes:
  GET  /health   -> liveness + config sanity
  POST /perceive -> { image: <dataURL/base64 jpeg>, prior?: {...} }
                    calls qwen3-vl-flash and returns the Director's read as JSON.

Zero third-party deps (stdlib only) so FC packaging is trivial. Runs identically
locally (`PORT=8787 python3 app.py`) and on FC (listens on $FC_SERVER_PORT, default 9000).
"""
import os, json, time, urllib.request, urllib.error
from urllib.parse import urlparse, parse_qs
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

DASHSCOPE_URL = "https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions"
IMG_SUBMIT = "https://dashscope-intl.aliyuncs.com/api/v1/services/aigc/text2image/image-synthesis"
IMG_TASK = "https://dashscope-intl.aliyuncs.com/api/v1/tasks/"
MODEL = os.environ.get("PERCEPTION_MODEL", "qwen3-vl-flash")
IMAGE_MODEL = os.environ.get("IMAGE_MODEL", "qwen-image")
ASR_MODEL = os.environ.get("ASR_MODEL", "qwen3-asr-flash")
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
        if path in ("/health", ""):
            return self._json(200, {"ok": True, "model": MODEL, "image_model": IMAGE_MODEL, "has_key": bool(API_KEY)})
        self._json(404, {"error": "not found"})

    def do_POST(self):
        path = urlparse(self.path).path.rstrip("/")
        if path not in ("/perceive", "/transcribe"):
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
