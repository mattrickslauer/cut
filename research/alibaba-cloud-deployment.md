# Deploying the "Cut!" backend on Alibaba Cloud

Research for hackathon requirement:

> "You must demonstrate that the backend is running on Alibaba Cloud. Proof must be a
> link to a code file in your repo that demonstrates use of Alibaba Cloud services and APIs."

**Bottom line up front:** run the whole Python backend on **one GPU ECS instance** (`ecs.gn6i` T4, or `gn7i` A10) in the **Singapore (ap-southeast-1)** region, store all raw + rendered video in **OSS** via the `oss2` SDK, call **Qwen + Wan** through **DashScope** (`dashscope` SDK, international endpoint `dashscope-intl.aliyuncs.com`), and do the matting/ffmpeg/compositing directly on that GPU box. Everything else (IMS, MPS, PAI, ApsaraVideo Live/RTC) is optional and mostly overkill for a 9-day build. The **proof file** is a single module in the repo (e.g. `backend/aliyun/storage.py` or `backend/services/dashscope_client.py`) that literally does `import oss2` / `import dashscope`, initializes a Singapore-region client, and hits `*.aliyuncs.com` endpoints.

---

## 1. Recommended minimal architecture

```
Browser (getUserMedia: webcam + mic)
   │  MediaRecorder → chunked video/audio blobs
   │  POST /ingest  (HTTP multipart, ~1–2s segments)   ← simplest ingest, no RTC infra
   ▼
GPU ECS instance  (ecs.gn6i / gn7i, Singapore ap-southeast-1)  ← "the backend on Alibaba Cloud"
   ├─ FastAPI ingest endpoint
   ├─ oss2  ──────────────▶ OSS bucket  (raw takes + rendered clips)   [Alibaba Cloud API]
   ├─ dashscope ─────────▶ Qwen-VL / Qwen-Max / Qwen-Plus (director brain) [Alibaba Cloud API]
   ├─ dashscope ─────────▶ Wan VideoSynthesis (backgrounds, cutaways)      [Alibaba Cloud API]
   ├─ RVM / SAM2 matting  (runs on the same NVIDIA GPU)
   ├─ ffmpeg composite + grade + assemble  (same GPU, NVENC)
   └─ Postgres (EDL) — RDS or just a container on the box
   ▼
Rendered cinematic cut → OSS (public-read or signed URL) → optional Alibaba Cloud CDN → browser
```

Why this shape: a single GPU ECS box that runs Python is the *simplest thing that satisfies "backend running on Alibaba Cloud"* while also being where matting+ffmpeg have to live anyway (they need the GPU and local disk). OSS + DashScope calls from that box give you multiple, unambiguous Alibaba Cloud API touchpoints for the proof file.

---

## 2. Service-mapping table

| Cut! need | Alibaba Cloud service | Python / API surface | Verdict |
|---|---|---|---|
| Run the Python backend + GPU matting/ffmpeg | **GPU ECS** (`ecs.gn6i` T4 / `ecs.gn7i` A10), Singapore | SSH box, run FastAPI + CUDA + ffmpeg | **Use — primary compute** |
| Store raw takes + rendered clips | **OSS** (Object Storage Service) | `import oss2` → `Bucket.put_object_from_file`, `sign_url` | **Use — core** |
| Serve rendered clips fast | **Alibaba Cloud CDN** in front of OSS | Bind CNAME to OSS bucket domain | Optional, easy win |
| Director brain (vision + reasoning) | **Model Studio / DashScope** — Qwen-VL, Qwen-Max, Qwen-Plus | `import dashscope` → `Generation.call`, `MultiModalConversation.call` | **Use — core** |
| Environment / cutaway generation | **DashScope** — Wan (`wan2.x-t2v` / `-i2v`) | `dashscope.VideoSynthesis.async_call` | **Use — core (linchpin)** |
| Speech-to-text (ASR) | **DashScope** — Paraformer / Qwen-Audio | `dashscope.audio.asr` | Use if ASR needed |
| Transcoding / timeline video production | **IMS** (Intelligent Media Services) `SubmitMediaProducingJob` | ICE OpenAPI SDK | Overkill — skip; ffmpeg is enough |
| Managed transcode only | **MPS / ApsaraVideo VOD** | MPS SDK | Overkill — skip |
| Real-time browser ingest | **ApsaraVideo Live RTS (WebRTC)** / **Alibaba RTC (ARTC)** | ARTC / RTS SDK | Skip for MVP; chunked HTTP upload is simpler |
| Managed model serving (alt to ECS) | **PAI-EAS** (Elastic Algorithm Service) | Deploy container as REST endpoint | Alternative, heavier setup |
| Serverless GPU (alt to ECS) | **Function Compute GPU** (custom container) | FC container runtime | Alternative; cold starts hurt live UX |

---

## 3. GPU compute — the three paths, and which to pick

### Path A — GPU ECS (recommended for the hackathon)
A single GPU virtual machine you SSH into and treat like any Linux GPU box. You install CUDA, PyTorch, RVM/SAM2, ffmpeg, and your FastAPI app. Simplest mental model, full control, no cold starts, local scratch disk for ffmpeg — exactly what a matting→composite→render pipeline wants.

GPU ECS families and their NVIDIA silicon (from the ECS instance-family doc):

| Family | NVIDIA GPU | Notes |
|---|---|---|
| **`gn6i`** | **T4 (16 GB)** | Entry-level inference; cheapest full-GPU; great for RVM/SAM2 + NVENC. **Start here.** |
| `vgn6i-vws` | T4 sliced (vGPU) | Even cheaper (fractional T4) |
| **`gn7i`** | **A10** | Step up if T4 is memory-tight for SAM2 + ffmpeg concurrently |
| `gn6v` / `gn6e` | V100 (16/32 GB) | Older; more FP16 muscle |
| `gn7e` / `gn7` | A100 (80 GB) | Overkill/expensive for this |
| `gn8is` | L20 (48 GB) | AIGC-focused; *available in select regions incl. outside mainland China* |
| `gn8v` | H100-class (HBM3) | Way overkill |
| `gn9gc` | Blackwell | Invitational preview; ticket required |

Cost ballpark: `gn6i` (T4) pay-as-you-go is roughly **~US$1–1.5/hr**; `gn7i` (A10) roughly **~US$1.5–3/hr** (varies by region/spec; the public 2023 China list had `gn6i` from ¥11.63/hr ≈ ~US$1.6/hr). For a hackathon, spin it up only while developing/demoing — a few dozen hours is **tens of dollars**. Verify live numbers in the pricing calculator (link below); international/Singapore pay-as-you-go differs from the China list.

> ⚠️ Some newer families (`gn8is`, `gn8v`, `gn7s`, `gn9gc`) require contacting sales or a ticket, and several are region-restricted. `gn6i`/`gn7i` are the safe, generally-available choices in Singapore.

### Path B — PAI-EAS (Elastic Algorithm Service)
Managed model serving: deploy a container/model as an autoscaling REST endpoint with heterogeneous CPU/GPU support, one-click LLM deploy (vLLM/BladeLLM), canary, monitoring. Good if you wanted the matting model as a scalable microservice, but it's more setup than value for a single-box demo, and it doesn't naturally host the ffmpeg assembly step. **Alternative, not recommended for MVP.**

### Path C — Function Compute GPU (serverless)
GPU-accelerated functions run in **custom container runtimes**, on-demand or provisioned-with-idle. Elegant for bursty async render jobs and you only pay per invocation. But cold starts and the container-only constraint make it awkward for the "near-live preview" UX, and stitching ffmpeg state across invocations is painful. **Alternative; consider only for offline batch cutaway rendering.**

**Pick Path A (GPU ECS).** Simplest path to run a Python GPU pipeline (RVM/SAM2 + ffmpeg) in 9 days.

---

## 4. Object storage — OSS for video

- `pip install oss2` (classic SDK, Python 3.8+) — or `alibabacloud-oss-v2` for the newer V2 SDK.
- Multipart/`Uploader` helpers auto-split large files and upload parts in parallel — ideal for big rendered `.mp4`s.
- Singapore endpoint: `https://oss-ap-southeast-1.aliyuncs.com`.
- Serve rendered clips either via a **signed URL** (`bucket.sign_url`) or make objects public-read; put **Alibaba Cloud CDN** in front of the bucket domain for fast global delivery of finished clips. OSS + CDN is the documented pattern for serving static video.

**Copy-paste: OSS upload + signed URL (oss2, Singapore)**

```python
# pip install oss2
import os
import oss2
from oss2.credentials import EnvironmentVariableCredentialsProvider

# Reads OSS_ACCESS_KEY_ID / OSS_ACCESS_KEY_SECRET from the environment
auth = oss2.ProviderAuth(EnvironmentVariableCredentialsProvider())

ENDPOINT = "https://oss-ap-southeast-1.aliyuncs.com"   # Singapore
REGION   = "ap-southeast-1"
BUCKET   = "cut-media"

bucket = oss2.Bucket(auth, ENDPOINT, BUCKET, region=REGION)

def upload_clip(local_path: str, key: str) -> str:
    """Upload a rendered clip to OSS and return a 1-hour signed URL."""
    bucket.put_object_from_file(key, local_path)          # Alibaba Cloud OSS API call
    return bucket.sign_url("GET", key, 3600, slash_safe=True)

if __name__ == "__main__":
    url = upload_clip("/tmp/take01_cut.mp4", "renders/take01_cut.mp4")
    print("Serving from OSS:", url)
```

**OSS V2 SDK** (alternative): `pip install alibabacloud-oss-v2`; configure `config.endpoint = "https://oss-ap-southeast-1.aliyuncs.com"` then `oss.Client(config)`.

---

## 5. Alibaba Cloud media services — IMS / MPS / VOD (worth it?)

- **IMS (Intelligent Media Services)** is genuinely capable: it has a **cloud timeline editing API** — `SubmitMediaProducingJob` combines video/audio/image/subtitle materials on a Timeline (tracks + materials + effects) into a finished video, plus a Web video-editing SDK and text-to-video templates. On paper it overlaps with Cut!'s EDL→render step.
- **MPS / ApsaraVideo VOD** offer managed transcoding and VOD hosting.

**Verdict: overkill for the MVP, and a poor fit for the creative core.** Cut!'s entire differentiator is *the agents' own edit decisions* driving matting + virtual-camera compositing + Wan generation. IMS's timeline is a fixed-schema declarative editor — you'd be fighting it to express matting composites and per-frame grades, and it adds a whole SDK + async job model. Hand-rolled ffmpeg on the GPU box is faster to build, fully controllable, and keeps the "AI filmmaker's brain" honest. Mention IMS as a "could productionize on" note; don't build on it. (If you later want managed transcode of the final master, MPS is the lightweight option.)

---

## 6. Real-time browser ingest

Options, simplest → heaviest:

1. **Chunked HTTP upload (recommended for MVP).** Browser `getUserMedia` + `MediaRecorder` emits ~1–2s blobs; `POST` each to a FastAPI `/ingest` endpoint. Matches Cut!'s own "live = near-live / segmented" design reframe. No extra infra, no RTC servers, trivial to debug. This is what the near-live preview loop wants.
2. **WebSocket streaming.** Push frames/audio over a WS to the backend for lower latency than repeated POSTs; still no managed service needed.
3. **WebRTC via Alibaba Cloud.** `ApsaraVideo Live` supports **RTS stream ingest over WebRTC** (the **ARTC** protocol, evolved from WebRTC), 400–800 ms end-to-end, with live centers in **Singapore, Frankfurt, Tokyo** for streamers outside mainland China. **Alibaba RTC (ARTC)** is the interactive/low-latency product. Powerful, but it's built for *streaming/broadcast*, not for handing raw frames to a Python matting pipeline — you'd still have to pull frames off the stream server-side. **Skip for the hackathon**; it's latency polish, not core function. (Nice "how we'd scale ingest" slide, though.)

---

## 7. DashScope integration (Qwen + Wan), international endpoint

- `pip install dashscope`.
- **International endpoint:** set `dashscope.base_http_api_url = "https://dashscope-intl.aliyuncs.com/api/v1"` (native SDK). OpenAI-compatible base URL: `https://dashscope-intl.aliyuncs.com/compatible-mode/v1`.
- API key from an **international Model Studio account**, in env var `DASHSCOPE_API_KEY`.
- Qwen text/reasoning: `dashscope.Generation.call(model="qwen-max"/"qwen-plus", ...)`.
- Qwen vision (perception): `dashscope.MultiModalConversation.call(model="qwen-vl-max", ...)`.
- Wan video (the linchpin): `dashscope.VideoSynthesis.async_call(model="wan2.x-t2v"/"-i2v", prompt=...)` → poll with `VideoSynthesis.wait(...)`; result `video_url` **expires in 24h — download to OSS immediately**.

**Copy-paste: Qwen (director brain) + Wan (generation), intl endpoint**

```python
# pip install dashscope
import os
from http import HTTPStatus
import dashscope
from dashscope import Generation, MultiModalConversation, VideoSynthesis

# International (non-China) endpoint — REQUIRED for alibabacloud.com accounts
dashscope.base_http_api_url = "https://dashscope-intl.aliyuncs.com/api/v1"
API_KEY = os.getenv("DASHSCOPE_API_KEY")

def director_decision(scene_summary: str) -> str:
    """Qwen-Max makes a creative call (genre/mood/cut)."""
    resp = Generation.call(
        api_key=API_KEY,
        model="qwen-max",
        messages=[
            {"role": "system", "content": "You are the Director agent for an AI film editor."},
            {"role": "user", "content": scene_summary},
        ],
        result_format="message",
    )
    return resp.output.choices[0].message.content

def perceive_frame(image_url: str) -> str:
    """Qwen-VL perceives who/emotion/action/setting in a frame."""
    resp = MultiModalConversation.call(
        api_key=API_KEY,
        model="qwen-vl-max",
        messages=[{"role": "user", "content": [
            {"image": image_url},
            {"text": "Who is present, the emotional beat, and the setting?"},
        ]}],
    )
    return resp.output.choices[0].message.content[0]["text"]

def generate_background(prompt: str) -> str:
    """Wan text-to-video for a generated environment / cutaway."""
    task = VideoSynthesis.async_call(api_key=API_KEY, model="wan2.2-t2v", prompt=prompt)
    result = VideoSynthesis.wait(task)          # poll to completion
    if result.status_code == HTTPStatus.OK:
        return result.output.video_url          # expires in 24h → copy to OSS now
    raise RuntimeError(f"Wan failed: {result.status_code} {result.code}")
```

---

## 8. International (non-China) account considerations

- **Sign up on `alibabacloud.com`** (the international portal), *not* `aliyun.com` (mainland China). This gives you the international console, USD billing, and the `dashscope-intl.aliyuncs.com` endpoint. The two account systems are separate — don't cross them.
- **Region:** deploy everything in **Singapore (`ap-southeast-1`)** — closest well-stocked international region, good GPU + OSS + DashScope availability. Keep ECS, OSS bucket, and (optionally) CDN in the same region to avoid cross-region latency/egress.
- **GPU availability internationally:** `gn6i` (T4) and `gn7i` (A10) are generally available in Singapore. Newer families (`gn8is` L20, `gn8v` H100, `gn7s`, `gn9gc`) are region-restricted and/or require contacting sales or filing a ticket for access — **don't** design the MVP around them. If you need a specific GPU and the console says "sold out," file a ticket early or try another zone within the region.
- **Gotchas:**
  - Real-name/identity verification and a payment method are required before you can launch GPU ECS; do this on day 1.
  - GPU instances may need a **quota increase** (vCPU quota per instance family) — request it early.
  - DashScope model access can be region/allowlist gated (esp. newest Wan versions) — verify the **linchpin** (Wan on your intl account) *first*, as the README already flags.
  - OSS keys should come from a **RAM user** with least-privilege, not the root account; load via env vars (`OSS_ACCESS_KEY_ID`/`OSS_ACCESS_KEY_SECRET`, `DASHSCOPE_API_KEY`).

---

## 9. What serves as the Alibaba Cloud proof file

The requirement is satisfied by **a real, committed source file that imports an Alibaba Cloud SDK and calls Alibaba Cloud APIs against `*.aliyuncs.com`.** You already have two natural ones from the snippets above. Recommended primary proof file:

**`backend/aliyun/storage.py`** (or `backend/services/oss_client.py`) — the OSS module above. It:
- `import oss2` (Alibaba Cloud SDK),
- initializes a **Singapore-region** OSS client against `https://oss-ap-southeast-1.aliyuncs.com`,
- calls `bucket.put_object_from_file(...)` and `bucket.sign_url(...)` (Alibaba Cloud OSS APIs).

Strong secondary proof file:

**`backend/services/dashscope_client.py`** — the DashScope module above. It `import dashscope`, sets `dashscope.base_http_api_url = "https://dashscope-intl.aliyuncs.com/api/v1"`, and calls `Generation.call` / `MultiModalConversation.call` / `VideoSynthesis.async_call` (Qwen + Wan on Alibaba Cloud).

For an unmissable proof, make a tiny top-level file, e.g. **`alibaba_cloud_proof.py`**, that imports both modules and, in a `__main__` block, does one OSS round-trip and one Qwen call — the judge can open one file and see `import oss2`, `import dashscope`, and `*.aliyuncs.com` endpoints together. Link that file's GitHub URL as the submission proof.

Checklist for the proof file to be airtight:
- [ ] `import oss2` and/or `import dashscope` visible at top.
- [ ] An `*.aliyuncs.com` endpoint literal (`oss-ap-southeast-1.aliyuncs.com`, `dashscope-intl.aliyuncs.com`).
- [ ] An actual API call (`put_object_from_file`, `Generation.call`, `VideoSynthesis.async_call`).
- [ ] Credentials via env vars (no secrets committed).
- [ ] Committed to the repo `main` branch; link is a permalink to the file.

---

## Sources

- ECS GPU instance families (gn6i/gn7i/gn8is + NVIDIA GPUs, regional notes): https://www.alibabacloud.com/help/en/ecs/user-guide/gpu-accelerated-compute-optimized-and-vgpu-accelerated-instance-families-1
- Create/purchase a GPU instance (Elastic GPU Service): https://www.alibabacloud.com/help/en/egs/user-guide/create-a-gpu-instance
- ECS pricing list (intl): https://www.alibabacloud.com/en/product/ecs-pricing-list/en and calculator: https://www.alibabacloud.com/en/pricing-calculator
- Function Compute GPU real-time inference: https://www.alibabacloud.com/help/en/functioncompute/fc-3-0/user-guide/real-time-inference-scenarios-1
- Function Compute GPU container function: https://www.alibabacloud.com/help/en/functioncompute/fc/user-guide/creating-a-gpu-function/
- PAI-EAS overview: https://www.alibabacloud.com/help/en/pai/user-guide/overview-2
- OSS Python SDK V2 getting started (Singapore endpoint): https://www.alibabacloud.com/help/en/oss/developer-reference/get-started-with-oss-sdk-for-python-v2
- oss2 (V1) on PyPI: https://pypi.org/project/oss2/ ; OSS V2 on PyPI: https://pypi.org/project/alibabacloud-oss-v2/
- OSS simple upload reference: https://www.alibabacloud.com/help/en/oss/developer-reference/simple-upload-1
- IMS timeline / SubmitMediaProducingJob (cloud editing via OpenAPI): https://www.alibabacloud.com/help/en/ims/user-guide/cloud-clip ; What is IMS: https://www.alibabacloud.com/help/en/ims/what-is-smart-media-services
- ApsaraVideo Live RTS stream ingest over WebRTC/ARTC: https://www.alibabacloud.com/help/en/live/developer-reference/stream-ingest-over-rts-or-webrtc ; cross-border live (Singapore/Frankfurt/Tokyo): https://www.alibabacloud.com/help/en/live/use-cases/how-to-get-started-with-live-streaming-outside-the-chinese-mainland
- Alibaba RTC (ARTC) product: https://www.alibabacloud.com/en/product/interactive_streaming
- DashScope / Qwen API reference (intl endpoint, OpenAI-compat): https://www.alibabacloud.com/help/en/model-studio/qwen-api-via-dashscope
- Wan text-to-video API reference: https://www.alibabacloud.com/help/en/model-studio/text-to-video-api-reference ; image-to-video: https://www.alibabacloud.com/help/en/model-studio/image-to-video-general-api-reference
- dashscope Python SDK: https://pypi.org/project/dashscope/ and https://github.com/dashscope/dashscope-sdk-python
