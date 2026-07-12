# Pre-rendered co-stars

Each scene in the library can ship a **pre-compiled co-star**: a portrait still plus one lip-synced
talking-head clip per co-star line. When those exist, the Audition Room plays the real face for
every co-star turn instantly — no on-device "Compile" step, no per-line render wait.

## Layout

```
public/costar-clips/
  <scene-id>/
    portrait.jpg      the co-star's face (one still)
    00.mp4            clip for the 1st co-star line
    01.mp4            clip for the 2nd co-star line
    ...
```

`<scene-id>` is the scene's `id` in `lib/audition/scenes.ts` (e.g. `will-hunting`, `casablanca`).
Clips are numbered in the order the co-star's lines appear in that scene's `sides`.

## How scenes pick these up

The files here are referenced by `lib/audition/costars.json`, which maps each scene id to its
`{ portrait, clips[] }`. That manifest is **generated** — don't hand-edit it. Run:

```bash
cd web
node scripts/prerender-costars.mjs            # all scenes with sides
node scripts/prerender-costars.mjs casablanca # just one
```

The script drives the same `cut-api` backend the live app uses (`/portrait` → `/say` → `/avatar`),
writes the rendered files into the folders above, and rewrites `costars.json`. Avatar generation is
slow (~1–5 min per line), so expect a full library run to take a while. Point it at your own backend
with `NEXT_PUBLIC_API_URL` / `API_URL` if you don't want to hit the shared one.

## Graceful fallback

If a clip is missing or fails to load, that co-star line falls back to voice-only automatically, so a
partially-rendered (or un-rendered) scene still reads end to end.
