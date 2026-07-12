#!/usr/bin/env node
// Pre-render ("pre-compile") each library scene's co-star into a portrait + one lip-synced clip per
// co-star line, using the same cut-api backend the live app calls (/portrait -> /say -> /avatar).
// Writes the files into web/public/costar-clips/<id>/ and rewrites lib/audition/costars.json so the
// scenes bind them automatically. Avatar render is slow (~1-5 min/line), so a full run takes a while.
//
//   node scripts/prerender-costars.mjs                # every scene that has sides
//   node scripts/prerender-costars.mjs casablanca     # just one (or several) scene ids
//
// Backend: override the default with API_URL or NEXT_PUBLIC_API_URL.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.resolve(HERE, "..");
const API =
  process.env.API_URL ||
  process.env.NEXT_PUBLIC_API_URL ||
  "https://cut-api-rjnhudrcgv.ap-southeast-1.fcapp.run";

// Load the scene library straight out of the TS source (no TS runtime): the LIBRARY array is plain
// JS object/string/template literals, so slice it out and evaluate just that expression.
async function loadScenes() {
  const src = await readFile(path.join(WEB, "lib/audition/scenes.ts"), "utf8");
  const m = src.match(/const LIBRARY[^=]*=\s*(\[[\s\S]*?\n\]);/);
  if (!m) throw new Error("could not locate the LIBRARY array in scenes.ts");
  return new Function(`return ${m[1]}`)();
}

// Minimal inline-sides parser mirroring lib/audition/script.ts: the co-star's lines are the ones
// whose "SPEAKER:" matches the scene's ai_character (first word), in script order.
const norm = (s) => s.trim().toUpperCase().replace(/[^A-Z0-9 ]/g, "").replace(/\s+/g, " ").trim();
function costarLines(scene) {
  const ai = norm((scene.ai_character || "").split(",")[0]);
  const out = [];
  for (const raw of (scene.sides || "").split("\n")) {
    const mm = raw.trim().match(/^([A-Za-z][A-Za-z0-9 .'\-]{0,28}?)\s*:\s*(\S.*)$/);
    if (mm && norm(mm[1]) === ai) out.push(mm[2].trim());
  }
  return out;
}

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
async function postJson(pathname, body) {
  const r = await fetch(API + pathname, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${pathname} -> HTTP ${r.status} ${data.error || ""}`);
  return data;
}
async function pollAvatar(taskId) {
  for (let i = 0; i < 80; i++) {
    await sleep(15000);
    const s = await fetch(`${API}/avatar?task_id=${encodeURIComponent(taskId)}`).then((r) => r.json());
    if (s.status === "SUCCEEDED" && s.video) return s.video;
    if (s.error) throw new Error(s.error);
    process.stdout.write(".");
  }
  throw new Error("avatar timed out");
}

async function toBuffer(uri) {
  if (uri.startsWith("data:")) return Buffer.from(uri.slice(uri.indexOf(",") + 1), "base64");
  const r = await fetch(uri);
  if (!r.ok) throw new Error(`fetch asset -> HTTP ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}
function imgExt(uri) {
  const m = uri.match(/^data:image\/(png|jpeg|jpg|webp)/);
  return m ? (m[1] === "jpeg" ? "jpg" : m[1]) : "jpg";
}

async function renderScene(scene) {
  const lines = costarLines(scene);
  if (!lines.length) {
    console.log(`- ${scene.id}: no co-star sides, skipping`);
    return null;
  }
  console.log(`\n▶ ${scene.id} (${scene.film || "improv"}) — ${lines.length} co-star lines`);
  const dir = path.join(WEB, "public/costar-clips", scene.id);
  await mkdir(dir, { recursive: true });

  process.stdout.write("  portrait… ");
  const portrait = await postJson("/portrait", { character: scene.ai_character, tone: scene.tone });
  if (!portrait.image) throw new Error(portrait.error || "portrait failed");
  const pExt = imgExt(portrait.image);
  await writeFile(path.join(dir, `portrait.${pExt}`), await toBuffer(portrait.image));
  console.log("ok");

  const clips = [];
  for (let i = 0; i < lines.length; i++) {
    const nn = String(i).padStart(2, "0");
    process.stdout.write(`  line ${i + 1}/${lines.length} say… `);
    const said = await postJson("/say", { text: lines[i], voice: scene.voice, tone: scene.tone });
    if (!said.audio) throw new Error(said.error || "voice failed");
    process.stdout.write("avatar");
    const sub = await postJson("/avatar", { image: portrait.image, audio: said.audio });
    if (!sub.task_id) throw new Error(sub.error || "avatar submit failed");
    const video = await pollAvatar(sub.task_id);
    await writeFile(path.join(dir, `${nn}.mp4`), await toBuffer(video));
    clips.push(`/costar-clips/${scene.id}/${nn}.mp4`);
    console.log(" ok");
  }
  return { portrait: `/costar-clips/${scene.id}/portrait.${pExt}`, clips };
}

async function main() {
  const only = process.argv.slice(2);
  const scenes = (await loadScenes()).filter((s) => s.sides && (!only.length || only.includes(s.id)));
  if (!scenes.length) {
    console.error(only.length ? `No scenes with sides match: ${only.join(", ")}` : "No scenes have sides.");
    process.exit(1);
  }
  console.log(`Backend: ${API}`);

  const manifestPath = path.join(WEB, "lib/audition/costars.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8").catch(() => "{}"));
  for (const scene of scenes) {
    try {
      const entry = await renderScene(scene);
      if (entry) {
        manifest[scene.id] = entry;
        await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n"); // checkpoint per scene
      }
    } catch (e) {
      console.error(`\n✗ ${scene.id}: ${e.message}`);
    }
  }
  console.log(`\nDone. Updated ${path.relative(WEB, manifestPath)}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
