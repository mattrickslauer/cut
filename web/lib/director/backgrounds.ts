// Generated / procedural worlds for the director's cut, plus the "same place?" heuristic that
// keeps the Auto world from flickering on the perception model's frame-to-frame rewording.

export const BG_LIST = [
  "None",
  "Auto",
  "Generated",
  "Studio",
  "Starfield",
  "Noir",
  "Sunset",
  "Void",
];

export const LOOK_TO_BG: Record<string, string> = {
  Noir: "Noir",
  "Sci-Fi": "Starfield",
  Golden: "Sunset",
  Thriller: "Void",
  Neutral: "Studio",
};

const SETTING_STOP = new Set([
  "a", "an", "the", "of", "in", "on", "at", "to", "with", "and", "some", "this", "that",
  "room", "place", "area", "scene", "space", "setting", "location", "interior", "exterior",
  "background", "dim", "dark", "bright", "small", "large", "empty", "quiet", "busy", "old", "modern",
]);

function settingWords(s: string): Set<string> {
  return new Set(
    (s || "")
      .replace(/[^a-z0-9 ]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2 && !SETTING_STOP.has(w))
  );
}

// Two setting descriptions name the "same place" if they share a meaningful noun.
export function sameSetting(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  const wb = settingWords(b);
  for (const w of settingWords(a)) if (wb.has(w)) return true;
  return false;
}

export function drawProc(ctx: CanvasRenderingContext2D, name: string, w: number, h: number) {
  const rg = (x: number, y: number, r0: number, r1: number) =>
    ctx.createRadialGradient(x, y, r0, x, y, r1);
  if (name === "Studio") {
    ctx.fillStyle = "#0aa07a";
    ctx.fillRect(0, 0, w, h);
    const g = rg(w / 2, h * 0.4, 10, Math.max(w, h));
    g.addColorStop(0, "rgba(255,255,255,.15)");
    g.addColorStop(1, "rgba(0,0,0,.28)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
  } else if (name === "Starfield") {
    const g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, "#05080f");
    g.addColorStop(1, "#0b1430");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
    for (let i = 0; i < 220; i++) {
      ctx.globalAlpha = 0.4 + Math.random() * 0.6;
      ctx.fillStyle = "#dfe8ff";
      ctx.beginPath();
      ctx.arc(Math.random() * w, Math.random() * h, Math.random() * 1.6, 0, 7);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    const n = rg(w * 0.7, h * 0.3, 10, w * 0.5);
    n.addColorStop(0, "rgba(80,120,255,.25)");
    n.addColorStop(1, "rgba(80,120,255,0)");
    ctx.fillStyle = n;
    ctx.fillRect(0, 0, w, h);
  } else if (name === "Noir") {
    ctx.fillStyle = "#0a0a0c";
    ctx.fillRect(0, 0, w, h);
    const g = rg(w * 0.5, h * 0.15, 10, h * 0.9);
    g.addColorStop(0, "rgba(255,230,180,.30)");
    g.addColorStop(0.4, "rgba(120,100,70,.10)");
    g.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
    ctx.globalAlpha = 0.06;
    ctx.fillStyle = "#000";
    for (let y = 0; y < h; y += Math.max(8, h / 40)) ctx.fillRect(0, y, w, Math.max(3, h / 120));
    ctx.globalAlpha = 1;
  } else if (name === "Sunset") {
    const g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, "#2a1a4a");
    g.addColorStop(0.5, "#e0632f");
    g.addColorStop(0.75, "#f4a13c");
    g.addColorStop(1, "#3a1e2a");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
    const s = rg(w * 0.5, h * 0.7, 10, w * 0.4);
    s.addColorStop(0, "rgba(255,240,200,.9)");
    s.addColorStop(1, "rgba(255,240,200,0)");
    ctx.fillStyle = s;
    ctx.fillRect(0, 0, w, h);
  } else {
    // Void
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, w, h);
    const g = rg(w / 2, h / 2, 10, Math.max(w, h) * 0.7);
    g.addColorStop(0, "rgba(30,30,40,1)");
    g.addColorStop(1, "#000");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
  }
}

export function drawCover(ctx: CanvasRenderingContext2D, img: HTMLImageElement, w: number, h: number) {
  const ir = img.width / img.height,
    r = w / h;
  let dw: number, dh: number, dx: number, dy: number;
  if (ir > r) {
    dh = h;
    dw = h * ir;
    dx = (w - dw) / 2;
    dy = 0;
  } else {
    dw = w;
    dh = w / ir;
    dx = 0;
    dy = (h - dh) / 2;
  }
  ctx.drawImage(img, dx, dy, dw, dh);
}
