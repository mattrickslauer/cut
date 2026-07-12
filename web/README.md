# Cut! — web

The **Director Control Panel** and the **Audition Room**, merged into one Next.js app and
hostable on Vercel. This replaces the two standalone vanilla-JS front-ends (`../app` and
`../audition/web`) with a single React app; the two experiences are now routes.

```
web/
  app/
    page.tsx              landing — links into both rooms
    director/             Director Control Panel  (/director)
    audition/             Audition Room           (/audition)
  lib/
    config.ts             the two backend URLs (env-overridable)
    director/             grades, backgrounds, wav, engine (the real-time pipeline)
    audition/             scenes, script, wav, engine (VAD + audio-mix + compositor + recorder)
```

### Scene library & pre-rendered co-stars

The Audition Room opens on a **full-screen poster carousel** (`app/audition/SceneCarousel.tsx`) of
iconic film two-handers. Each scene in `lib/audition/scenes.ts` carries its **sides baked in** (they
auto-load into the teleprompter and drive the co-star) plus poster art.

A scene can also ship a **pre-compiled co-star** — a portrait + one lip-synced clip per co-star line,
so the partner performs as a real face from the first line with no on-device "Compile" wait. Those
assets live in `public/costar-clips/<scene-id>/` and are referenced by `lib/audition/costars.json`
(generated, not hand-edited). Render them with:

```bash
npm run prerender-costars            # every scene with sides
npm run prerender-costars casablanca # just one
```

The script drives the same `cut-api` backend (`/portrait` → `/say` → `/avatar`). Until a scene is
rendered, its co-star simply reads with the live voice — a missing clip degrades to voice-only, so
scenes always play end to end. See `public/costar-clips/README.md`.

## Architecture

The UI is idiomatic React — declarative state drives every button, list, and panel. Each
experience's **real-time media pipeline** (getUserMedia, an `AudioContext` energy-VAD, a
30–60fps canvas render loop, `MediaRecorder`) lives in a dedicated controller class
(`lib/*/engine.ts`) that a `useEffect` instantiates and drives via refs. React state can't
carry a per-frame VAD loop, so the imperative engine is deliberately kept out of the render
cycle and only pushes a view-model back to the component through an `onChange` callback.

### Backend (one function)

The frontend talks to a single **Alibaba Function Compute** service (scale-to-zero, holding the
DashScope/Qwen key). This app does **not** re-implement it — it points at its URL (`lib/config.ts`,
override with `NEXT_PUBLIC_API_URL`):

| Backend | Source | Endpoints |
| --- | --- | --- |
| `cut-api` | `../backend/api/app.py` | perceive: `POST /perceive`, `POST /transcribe`, `GET /background` · audition: `POST /costar`, `POST /say`, `POST /portrait`, `POST|GET /avatar`, `GET /warm` |

It's CORS-open (`ACAO: *`), so the browser calls it directly. Deploy with `cd ../backend/api && s deploy`.
The heavy offline render pipeline in `../backend/render` is a separate GPU service, not part of this app.

## Develop

```bash
npm install
npm run dev            # http://localhost:3000
```

Camera + mic require a secure context — `localhost` counts, so dev works as-is. The app ships
with the live backend URLs baked in (see `lib/config.ts`), so it runs with **no env at all**.

## Configure

Override the backends with env (e.g. to point at local `python3 app.py` runs):

```bash
cp .env.example .env.local
# NEXT_PUBLIC_PERCEIVE_URL=http://localhost:9000
# NEXT_PUBLIC_AUDITION_URL=http://localhost:8787
```

## Deploy to Vercel

This is a stock Next.js app — deploy the `web/` directory:

1. Import the repo in Vercel and set **Root Directory** to `web`.
2. (Optional) add `NEXT_PUBLIC_PERCEIVE_URL` / `NEXT_PUBLIC_AUDITION_URL` env vars to point
   at your own backend deploys; otherwise the live defaults are used.
3. Deploy. Framework preset **Next.js**, build `next build`, no extra config.

Or from the CLI:

```bash
cd web && vercel        # preview
cd web && vercel --prod # production
```

### A note on latency

The audition reader is co-located with DashScope in `ap-southeast-1` (~4s/turn in region).
Serving the frontend from Vercel doesn't change that — the browser still calls the FC URL
directly — but if you relocate the backend, keep it near DashScope.

## MediaPipe

Matting and character detection load `@mediapipe/tasks-vision` straight from the jsDelivr CDN
at runtime (see `lib/director/engine.ts`), imported with `webpackIgnore`/`turbopackIgnore` so
the bundler leaves the native dynamic import alone. No npm dependency, no wasm to host.
