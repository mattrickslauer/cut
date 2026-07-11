# Wan / HappyHorse Video Generation via Qwen Cloud (Alibaba Model Studio / DashScope)

Research for **"Cut!"** — live two-person improv → cinematic film. Qwen Cloud Hackathon, Track 2 (AI Showrunner).
Date: 2026-07-11. Primary sources: help.aliyun.com / alibabacloud.com/help/en/model-studio.

---

## FEASIBILITY VERDICT

**Wan and HappyHorse ARE fully available via the DashScope / Model Studio API — that half is a green light.** Both model families are first-class, documented, API-accessible from the international Singapore endpoint, with generous free credits. Text-to-video, image-to-video, first-last-frame, reference-to-video, and video editing modes all exist.

**BUT: this is NOT near-real-time, and that is the linchpin risk for "Cut!".** Every official video endpoint is **asynchronous submit-then-poll**, and the docs quote **1–5 minutes per clip** for Wan/HappyHorse text/image-to-video, and **5–10 minutes** for VACE video editing. There is no streaming/live mode. You cannot generate a shot "as the scene plays." A 5-second cutaway will land 1–5 minutes after you request it.

**Second hard constraint: concurrency is 2–5 tasks per account.** Wan "plus/turbo" variants allow only **2 concurrent jobs**; standard Wan and HappyHorse allow **5**. You cannot fan out 20 shots in parallel to hide latency — the queue is tiny.

**What this means for "Cut!":**
- **Live, reactive shot generation during the improv = infeasible.** The latency and concurrency make true real-time cinematic cutting impossible with these models today.
- **Viable architectures instead:**
  1. **Pre-generate a library** of backgrounds/establishing shots/cutaways *before* the show (batch, offline). At runtime the agent *selects and cuts* among pre-made clips — director/editor logic, not live gen. This is the realistic hackathon demo.
  2. **Image-first, near-real-time-ish.** `qwen-image` / `wan2.6-t2i` run **synchronously in ~10–30s** and cost ~$0.03–0.04/image. Generating cinematic *stills* (parallax'd/Ken-Burns'd for motion) is 10x faster and cheaper than video and is genuinely closer to "near-real-time." Strongly recommended for backgrounds/establishing frames.
  3. **Post-hoc render.** Capture the improv live, then generate the cinematic video pass in the 1–5 min window per shot and stitch — "the film drops minutes after the scene," not live.

**Plan for:** ~$0.08–0.12/sec (720p) to ~$0.12–0.18/sec (1080p) for Wan video; HappyHorse ~2x that. Free credits (~1,650 video-seconds + per-model quotas) comfortably cover hackathon dev/demo. Budget **1–5 min latency per video clip** and **≤5 concurrent jobs** as fixed design constraints.

**Bottom line:** Build "Cut!" as a **director/editor agent over a pre-generated (or image-based) shot library**, with video gen as an *offline/near-line* pass — not a live-in-the-loop renderer. If the pitch hard-requires frame-accurate live generation synced to the actors, that specific framing is not achievable with Wan/HappyHorse latency today; reframe to "the AI showrunner directs and assembles" rather than "generates every frame live."

---

## 1. Availability & Model IDs

Both **Wan (Tongyi Wanxiang / "万相")** and **HappyHorse** are official, documented DashScope models. HappyHorse is Alibaba's newer flagship video model (topped video-arena leaderboards); Wan is the established open+hosted family.

### Video models

| Model ID | Mode | Max duration | Resolutions | Native audio | Concurrency | Notes |
|---|---|---|---|---|---|---|
| `wan2.7-t2v` / `wan2.7-t2v-2026-06-12` | text→video | 2–15s (def 5) | 720P, 1080P; 16:9/9:16/1:1/4:3/3:4 | — | 5 | Latest Wan T2V |
| `wan2.6-t2v` | text→video | 2–15s | 720P/1080P (w×h) | — | 5 | |
| `wan2.2-t2v-plus` | text→video | 5s fixed | 480/720/1080P | — | **2** | plus = 2 concurrent |
| `wan2.1-t2v-turbo` | text→video | 5s fixed | 720P | — | **2** | |
| `wan2.7-i2v` / `wan2.7-i2v-2026-04-25` | image→video (+first/last frame, continuation) | 2–15s (def 5) | 720P/1080P (def 1080P) | supports audio input | 5 | Unified I2V protocol |
| `wan2.2-kf2v-flash` | first+last frame→video | 5s fixed | 480/720/1080P (def 720P) | — | 5 | Keyframe interpolation |
| `wan2.1-kf2v-plus` | first+last frame→video | 5s fixed | 720P | — | 2 | |
| `wanx2.1-vace-plus` | video edit / v2v (repaint, outpaint, ref, extend) | — | 720P fixed, 30fps, MP4/H.264 | — | 2 | VACE all-in-one editor; **5–10 min** |
| `happyhorse-1.1-t2v` / `happyhorse-1.0-t2v` | text→video | 3–15s (def 5) | 720P/1080P (def 1080P) | yes (unified A/V) | 5 | Flagship; joint video+audio |
| `happyhorse-1.1-i2v` / `-1.0-i2v` | image→video | up to 15s | 720P/1080P | yes | 5 | |
| `happyhorse-1.1-r2v` / `-1.0-r2v` | reference→video (up to 9 ref images, subject/scene preservation) | up to 15s | 720P/1080P | yes | 5 | **Great for character/subject consistency** |
| `happyhorse-1.0-video-edit` | video editing | — | — | yes | 5 | |

### Image models (synchronous, fast — recommended for stills/backgrounds)

| Model ID | Type | Price (intl) | Notes |
|---|---|---|---|
| `qwen-image` | text→image | ~$0.035/img | Sync ~10–30s |
| `qwen-image-2.0-pro` | text→image | ~$0.075/img | Higher quality |
| `wan2.6-t2i` | text→image | ~$0.03/img | Latest Wanx image, recommended |
| `wan2.5-t2i-preview` | text→image | — | |
| `wan2.2-t2i-flash` | text→image | ~$0.05/img (plus tier) | Fast |
| `wanx2.0-t2i-turbo` | text→image | — | Legacy turbo |

Image sizes: default 1280×1280, range 1280×1280–1440×1440, aspect ratios 1:4–4:1 (1:1→1280×1280, 16:9→1696×960, 9:16→960×1696, etc.).

---

## 2. Generation Modes Supported

- **Text-to-video** ✓ (Wan T2V, HappyHorse T2V) — good for backgrounds/establishing shots from a prompt.
- **Image-to-video** ✓ (Wan I2V, HappyHorse I2V) — animate a still (e.g., an image-gen background → moving plate).
- **First-and-last-frame** ✓ (`wan2.2-kf2v-flash`, `wan2.1-kf2v-plus`, and within `wan2.7-i2v`) — precise transition control between two keyframes.
- **Reference-to-video** ✓ (`happyhorse-1.1-r2v`, up to **9 reference images**) — **best bet for character/costume/scene consistency across cutaways** (keep the same actor-avatar look).
- **Video editing / video-to-video** ✓ (`wanx2.1-vace-plus`, `happyhorse-1.0-video-edit`) — repaint, outpaint (expand frame), actor/object replacement, masked-region repaint, frame extension. **But 5–10 min latency.**
- **Camera control:** ⚠️ **Not documented** as an explicit parameter on the current Wan/HappyHorse hosted APIs. Camera motion is driven via prompt language ("slow dolly in", "crane shot") rather than structured controls. Do not rely on programmatic camera keyframing.
- **Style/reference conditioning:** partial — via R2V reference images and VACE reference workflows; no separate "style LoRA" knob on the hosted API (that's the open-source local Wan path).
- **Prompt extension:** optional `prompt_extend` param auto-enriches short prompts (adds a few seconds).

---

## 3. API Mechanics

**All video endpoints are asynchronous: POST to create a task → poll `GET /tasks/{task_id}`.** Image gen can run **synchronously**.

### Endpoints (International / Singapore — use this for the hackathon)

Model Studio now recommends the **workspace-scoped Singapore domain** over the old `dashscope-intl.aliyuncs.com`:

```
# Wan/HappyHorse video (T2V, I2V, first/last-frame via 2.7):
POST https://{WorkspaceId}.ap-southeast-1.maas.aliyuncs.com/api/v1/services/aigc/video-generation/video-synthesis

# Legacy image2video path (kf2v flash/plus):
POST https://{WorkspaceId}.ap-southeast-1.maas.aliyuncs.com/api/v1/services/aigc/image2video/video-synthesis

# Poll task status:
GET  https://{WorkspaceId}.ap-southeast-1.maas.aliyuncs.com/api/v1/tasks/{task_id}

# Image generation (sync or async):
POST https://{WorkspaceId}.ap-southeast-1.maas.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation
```

Older global aliases still work: `https://dashscope-intl.aliyuncs.com/api/v1/...` (Singapore), `https://dashscope-us.aliyuncs.com/api/v1/...` (US Virginia — **no free quota**), `https://dashscope.aliyuncs.com/api/v1/...` (Beijing). **The API key, endpoint region, and model region must all match** or calls fail. For SDK, set `DASHSCOPE_API_KEY` and, for intl, `DASHSCOPE_BASE_URL`/`DASH_API_URL=https://dashscope-intl.aliyuncs.com/api/v1`.

### Job lifecycle

`task_status`: `PENDING → RUNNING → SUCCEEDED | FAILED`. On success the response carries a **video URL valid for 24h only** — download and re-host (e.g., OSS) immediately. Task IDs valid 24h. Recommended poll interval: **~15s**.

### Python — submit a video-gen job (raw HTTP, async header)

```python
import os, requests

BASE = f"https://{os.environ['WORKSPACE_ID']}.ap-southeast-1.maas.aliyuncs.com/api/v1"
HEADERS = {
    "Authorization": f"Bearer {os.environ['DASHSCOPE_API_KEY']}",
    "Content-Type": "application/json",
    "X-DashScope-Async": "enable",          # REQUIRED: async submission
}

def submit_t2v(prompt, model="wan2.7-t2v", size="1280*720", duration=5):
    body = {
        "model": model,
        "input": {"prompt": prompt},
        "parameters": {"size": size, "duration": duration, "prompt_extend": True},
    }
    r = requests.post(f"{BASE}/services/aigc/video-generation/video-synthesis",
                      headers=HEADERS, json=body, timeout=30)
    r.raise_for_status()
    return r.json()["output"]["task_id"]

# HappyHorse text-to-video (native audio): model="happyhorse-1.1-t2v", size="1920*1080"
# Image-to-video: model="wan2.7-i2v", input={"prompt":..., "img_url":"https://..."}
# Reference-to-video (subject consistency): model="happyhorse-1.1-r2v",
#     input={"prompt":..., "ref_images_url":["https://a.jpg", ...up to 9]}
```

### Python — poll for the result

```python
import time, requests

def poll(task_id, interval=15, timeout_s=600):
    url = f"{BASE}/tasks/{task_id}"
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        j = requests.get(url, headers={"Authorization": HEADERS["Authorization"]}).json()
        status = j["output"]["task_status"]
        if status == "SUCCEEDED":
            return j["output"]["video_url"]         # 24h-expiry URL — download now
        if status == "FAILED":
            raise RuntimeError(j["output"].get("message", "task failed"))
        time.sleep(interval)
    raise TimeoutError(task_id)

task_id = submit_t2v("empty film-noir diner at night, neon rain, slow dolly in")
video_url = poll(task_id)
```

### Or use the DashScope Python SDK (simpler)

```python
import dashscope
from dashscope import VideoSynthesis
dashscope.base_http_api_url = "https://dashscope-intl.aliyuncs.com/api/v1"   # intl/Singapore

rsp = VideoSynthesis.async_call(model="wan2.7-t2v",
                                prompt="...", size="1280*720", duration=5)
rsp = VideoSynthesis.wait(rsp)          # blocks/polls until done
print(rsp.output.video_url)
```
(SDK covers wan2.6 and earlier cleanly; for `wan2.7`/HappyHorse-latest confirm SDK version or fall back to raw HTTP above. Java SDK ≥ 2.22.6 for 2.7.)

**Output format:** MP4 (H.264). VACE outputs fixed 720P @ 30fps.

---

## 4. Latency (the critical number)

| Task | Official quoted time |
|---|---|
| Wan T2V / I2V (`wan2.7`, `wan2.6`) | **1–5 minutes** per clip |
| HappyHorse T2V/I2V | **1–5 minutes** per clip |
| First/last-frame (kf2v) | few minutes |
| VACE video editing (`wanx2.1-vace-plus`) | **5–10 minutes** |
| **Image gen** (`qwen-image`, `wan2.6-t2i`) | **~10–30 seconds (synchronous)** |

There is **no streaming or low-latency video mode**. Poll cadence itself is ~15s. **Design conclusion: video is a batch/near-line asset, not a live renderer. Images are the only "fast-ish" path (10–30s).**

---

## 5. Cost & Free Credits

- **Billing = output only**, per **second of successfully generated video**: `cost = per-second unit price × duration`. Failed jobs are **not charged** and don't burn free quota. Price scales with resolution tier (1080P > 720P > 480P).
- **Wan video, planning figures:** official DashScope baseline ~**$0.08–0.12/sec at 720P**, ~**$0.12–0.18/sec at 1080P** (Wan 2.5 baseline was quoted ~$0.105/sec ≈ $1.05 per 10s clip). Treat as approximate — check the Model Studio console for the exact posted rate at build time.
- **HappyHorse:** roughly **2x** Wan — third-party resellers quote ≈ **$1.82 / 10s @ 720P (~$0.18/s)** and **$3.12 / 10s @ 1080P (~$0.31/s)**. Native audio is the premium.
- **Image gen:** `wan2.6-t2i` ~$0.03/img, `qwen-image` ~$0.035/img, `qwen-image-2.0-pro` ~$0.075/img. **~3x cheaper per asset than a 1s of video.**
- **Free quota for new accounts (Singapore/international only, 90 days):**
  - ~**1,650 seconds of video generation credit** (spread across models),
  - **per-model free video quota (~50s of 1080P per model)**,
  - image free quota **50–100 images per model**,
  - plus ~1M tokens/model for Qwen LLMs.
  - **US Virginia endpoint has NO free quota** — use **Singapore**.

**Hackathon budget verdict:** free credits are ample for development and a demo. 1,650s ≈ 330 five-second clips free. Even paid, a full demo film of ~30 shots × 5s @ 720P ≈ 150s ≈ **$12–18 on Wan** (or ~$27 on HappyHorse). Cost is a non-issue; **latency and concurrency are the real constraints.**

---

## 6. Image Generation (recommended fast path)

`qwen-image` and `wan2.6-t2i` run **synchronously in ~10–30s** at ~$0.03–0.04/image, up to 1440×1440. For "Cut!", generating **cinematic stills** (backgrounds, establishing frames, cutaway plates) and adding motion cheaply (Ken Burns / parallax / a quick I2V pass only where needed) is dramatically faster and cheaper than full T2V and is the closest thing to "near-real-time" available. **Use image gen as the primary background/establishing-shot engine; reserve video gen for hero moments.**

---

## 7. Rate Limits & Concurrency

Rate limits apply **per Alibaba Cloud account** (aggregated across all API keys/workspaces/RAM users). For video:

| Model class | Submit RPS | **Concurrent tasks** |
|---|---|---|
| HappyHorse (all) | 10 | **5** |
| Wan standard (`wan2.7-t2v`, `wan2.6-t2v`, i2v, kf2v-flash) | 5 | **5** |
| Wan plus/turbo (`wan2.2-t2v-plus`, `wan2.1-t2v-turbo`, `wanx2.1-vace-plus`) | 2 | **2** |
| Image (`wan2.6-t2i`) | 5 (intl) / 1 (Beijing) | n/a (sync) |

**The concurrent-task cap (2–5) is the killer for parallel fan-out.** Combined with 1–5 min/clip, throughput ≈ **~1 clip/minute steady-state at best** (5 concurrent ÷ ~5 min). Pre-generation the night before, or an image-heavy pipeline, is the way to get a rich film without hitting this wall live.

---

## Design recommendations for "Cut!"

1. **Reframe the pitch:** the AI is a **showrunner/director/editor** that *composes and cuts* a film in near-real-time from a **shot library** — not a live frame renderer. This is honest and still impressive.
2. **Pre-generate** backgrounds/establishing/cutaway clips (offline batch) keyed to likely scene beats/genres; runtime = fast selection + cutting + captioning driven by a Qwen LLM analyzing the live improv transcript/audio.
3. **Lean on image gen** (`wan2.6-t2i` / `qwen-image`, 10–30s sync) for anything that must appear responsively; animate with cheap motion or a targeted I2V pass.
4. **Use `happyhorse-*-r2v` (reference-to-video, ≤9 ref images)** to keep character/scene identity consistent across shots.
5. If you want a "generated film" deliverable, do a **post-show render pass** (accept 1–5 min/clip) and present the finished cut minutes after the scene — market it as the payoff.
6. Endpoint: **Singapore** (`*.ap-southeast-1.maas.aliyuncs.com`), for the free quota. Download every result URL immediately (24h expiry).

---

## Sources (primary)
- Wan Text-to-Video API: https://www.alibabacloud.com/help/en/model-studio/text-to-video-api-reference
- Wan Image-to-Video API: https://www.alibabacloud.com/help/en/model-studio/image-to-video-general-api-reference
- First-and-last-frame API: https://www.alibabacloud.com/help/en/model-studio/image-to-video-by-first-and-last-frame-api-reference
- Wan VACE video editing API: https://www.alibabacloud.com/help/en/model-studio/wanx-vace-api-reference
- HappyHorse T2V API: https://www.alibabacloud.com/help/en/model-studio/happyhorse-text-to-video-api-reference
- HappyHorse video edit API: https://www.alibabacloud.com/help/en/model-studio/happyhorse-video-edit-api-reference
- Text-to-image v2 API: https://www.alibabacloud.com/help/en/model-studio/text-to-image-v2-api-reference
- Supported models overview: https://www.alibabacloud.com/help/en/model-studio/models
- Video generation guide: https://www.alibabacloud.com/help/en/model-studio/use-video-generation
- Model pricing: https://www.alibabacloud.com/help/en/model-studio/model-pricing
- Rate limiting: https://www.alibabacloud.com/help/en/model-studio/rate-limit
