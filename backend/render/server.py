"""HTTP wrapper for the render service — POST an EDL, poll for the finished film.

  GET  /health              -> liveness + device/matte info
  POST /render              -> { edl: {...}, clip: "path-or-url" } -> { job_id }
  GET  /jobs/<id>           -> { status, out?, error? }
  GET  /jobs/<id>/download  -> the mp4 when done

Renders run in a background thread (one job registry, in-process). This mirrors
the stdlib style of ../code/app.py so it deploys the same way — but note the real
matte path needs torch + a GPU, so this belongs on a GPU instance, not the
scale-to-zero perception function.
"""
from __future__ import annotations

import json
import os
import tempfile
import threading
import time
import urllib.request
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

from . import edl as edl_mod
from . import pipeline
from .matte import make_matte

FAKE = os.environ.get("CUT_FAKE_MATTE", "").strip() in ("1", "true", "yes")
VARIANT = os.environ.get("CUT_RVM_VARIANT", "mobilenetv3")
OUT_DIR = os.environ.get("CUT_OUT_DIR", tempfile.gettempdir())

_JOBS = {}
_LOCK = threading.Lock()
_MATTE = None
_MATTE_LOCK = threading.Lock()


def _get_matte():
    """Lazily build one matte and reuse it (RVM load is expensive). Serialized:
    RVM keeps recurrent state, so renders must not interleave on one instance."""
    global _MATTE
    with _MATTE_LOCK:
        if _MATTE is None:
            _MATTE = make_matte(fake=FAKE, variant=VARIANT)
        return _MATTE


def _resolve_clip(clip: str) -> str:
    if clip.startswith("http://") or clip.startswith("https://"):
        dst = os.path.join(OUT_DIR, f"src_{uuid.uuid4().hex[:8]}.mp4")
        urllib.request.urlretrieve(clip, dst)
        return dst
    return clip


def _run_job(job_id: str, edl_dict: dict, clip: str):
    try:
        e = edl_mod.from_dict(edl_dict)
        source = _resolve_clip(clip or e.clip)
        workdir = os.path.join(OUT_DIR, f"job_{job_id}")
        os.makedirs(workdir, exist_ok=True)
        out = os.path.join(workdir, "cut.mp4")
        matte = _get_matte()
        with _MATTE_LOCK:  # serialize renders on the shared matte
            pipeline.render_edl(e, matte, out, workdir, source=source,
                                log=lambda m: _log(job_id, m))
        _update(job_id, status="done", out=out)
    except Exception as exc:
        _update(job_id, status="error", error=str(exc)[:500])


def _log(job_id, msg):
    _update(job_id, last=msg)


def _update(job_id, **kw):
    with _LOCK:
        _JOBS.setdefault(job_id, {}).update(kw)


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
        if path in ("/health", ""):
            return self._json(200, {"ok": True, "fake_matte": FAKE, "variant": VARIANT})
        if path.startswith("/jobs/") and path.endswith("/download"):
            job_id = path[len("/jobs/"):-len("/download")]
            job = _JOBS.get(job_id)
            if not job or job.get("status") != "done":
                return self._json(404, {"error": "not ready"})
            return self._send_file(job["out"])
        if path.startswith("/jobs/"):
            job = _JOBS.get(path[len("/jobs/"):])
            return self._json(200 if job else 404, job or {"error": "unknown job"})
        return self._json(404, {"error": "not found"})

    def do_POST(self):
        path = urlparse(self.path).path.rstrip("/")
        if path != "/render":
            return self._json(404, {"error": "not found"})
        try:
            n = int(self.headers.get("Content-Length", 0))
            body = json.loads(self.rfile.read(n).decode() or "{}")
        except Exception as e:
            return self._json(400, {"error": f"bad request: {e}"})
        if "edl" not in body:
            return self._json(400, {"error": "missing 'edl'"})
        job_id = uuid.uuid4().hex[:12]
        _update(job_id, status="queued", created=time.time())
        threading.Thread(target=_run_job,
                         args=(job_id, body["edl"], body.get("clip", "")),
                         daemon=True).start()
        return self._json(202, {"job_id": job_id})

    def _send_file(self, fpath):
        with open(fpath, "rb") as f:
            data = f.read()
        self.send_response(200); self._cors()
        self.send_header("Content-Type", "video/mp4")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *a):
        pass


if __name__ == "__main__":
    port = int(os.environ.get("FC_SERVER_PORT") or os.environ.get("PORT") or 9100)
    print(f"cut render service on :{port}  fake_matte={FAKE}  variant={VARIANT}")
    ThreadingHTTPServer(("0.0.0.0", port), Handler).serve_forever()
