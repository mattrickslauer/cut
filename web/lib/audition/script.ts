// Parse a pasted "sides" script into ordered, speaker-attributed lines — the shared backbone
// behind compile (pre-render the co-star's lines), line-gated advance (wait until the actor
// says their line), the "Line!" prompt, and the on-screen teleprompter. One parse, one pointer.
//
// Accepts the two formats people actually paste:
//   Inline    -> "MAYA: I didn't think you still knew this place existed."
//   Screenplay-> a speaker name alone on a line (often centered/indented, usually caps),
//                the dialogue on the following line(s), until the next speaker header.
// A blank line or a new header ends a block. Parenthetical stage directions on their own line
// (e.g. "(beat)") are dropped; trailing inline parentheticals are kept as written.

export type Who = "actor" | "costar";
export type ScriptLine = {
  i: number; // index in the co-star/actor interleaved sequence, in script order
  who: Who; // actor = the human auditioning; costar = the AI scene partner
  speaker: string; // the label as written (e.g. "MAYA")
  text: string; // the spoken line, whitespace-collapsed
};

const norm = (s: string) => s.trim().toUpperCase().replace(/[^A-Z0-9 ]/g, "").replace(/\s+/g, " ").trim();

// A header is a short, mostly-uppercase name — inline "NAME:" or a bare "NAME" line. We keep it
// deliberately strict (short, starts with a letter, few lowercase words) so ordinary dialogue that
// happens to contain a colon ("Listen: it's over") isn't misread as a speaker label.
const INLINE = /^\s*([A-Za-z][A-Za-z0-9 .'\-]{0,28}?)\s*:\s*(\S.*)$/;

function looksLikeName(s: string): boolean {
  const t = s.trim();
  if (!t || t.length > 30) return false;
  if (!/^[A-Za-z]/.test(t)) return false;
  const words = t.split(/\s+/);
  if (words.length > 4) return false;
  const letters = t.replace(/[^A-Za-z]/g, "");
  if (!letters) return false;
  const upper = t.replace(/[^A-Z]/g, "").length;
  return upper / letters.length >= 0.6; // mostly caps → a screenplay character cue
}

/**
 * Parse `text` into interleaved, attributed lines. `aiName` is the co-star's character name
 * (e.g. scene.ai_character "MAYA, an ex…" → pass "MAYA"); any speaker matching it is the costar,
 * every other attributed speaker is the actor. `humanName` is an optional explicit actor label.
 * Lines whose speaker can't be resolved to a name still alternate sensibly from context.
 */
export function parseScript(text: string, aiName: string, humanName = ""): ScriptLine[] {
  const ai = norm(aiName.split(",")[0]);
  const human = norm(humanName.split(",")[0]);
  const raw = (text || "").replace(/\r\n?/g, "\n").split("\n");

  type Block = { speaker: string; parts: string[] };
  const blocks: Block[] = [];
  let cur: Block | null = null;
  const start = (speaker: string, first: string): Block => {
    const b: Block = { speaker, parts: first ? [first] : [] };
    blocks.push(b);
    return b;
  };

  for (const line of raw) {
    const s = line.trim();
    if (!s) {
      cur = null; // blank line ends the current speech
      continue;
    }
    if (/^\(.*\)$/.test(s)) continue; // standalone stage direction — drop it
    const m = s.match(INLINE);
    if (m && looksLikeName(m[1])) {
      cur = start(m[1].trim(), m[2].trim());
      continue;
    }
    if (looksLikeName(s)) {
      cur = start(s, ""); // bare screenplay cue; dialogue follows on later lines
      continue;
    }
    if (cur) cur.parts.push(s);
    else cur = start("", s); // dialogue with no attribution yet — attribute by alternation later
  }

  // Resolve each block's speaker to actor/costar. Named blocks match aiName → costar. Unlabeled
  // blocks alternate from the previous line (a two-hander), starting from the actor unless the
  // script opens on a clear co-star cue.
  const out: ScriptLine[] = [];
  let prev: Who | null = null;
  for (const b of blocks) {
    const text = b.parts.join(" ").replace(/\s+/g, " ").trim();
    if (!text) continue;
    const sp = norm(b.speaker);
    let who: Who;
    if (sp && ai && (sp === ai || sp.startsWith(ai + " ") || ai.startsWith(sp + " "))) who = "costar";
    else if (sp && human && (sp === human || sp.startsWith(human + " "))) who = "actor";
    else if (sp) who = "actor"; // a named speaker that isn't the co-star is the actor's role
    else who = prev === "actor" ? "costar" : "actor"; // unlabeled → alternate
    out.push({ i: out.length, who, speaker: b.speaker.trim(), text });
    prev = who;
  }
  return out;
}

// Fuzzy "did the actor say their line?" check, "within reason". Compares the ASR transcript to the
// expected line by normalized token overlap (order-independent, punctuation/case-insensitive) plus
// a coverage check so a long line isn't satisfied by a couple of matching words. Returns 0..1.
export function lineSimilarity(said: string, expected: string): number {
  const toks = (s: string) =>
    (s || "").toLowerCase().replace(/[^a-z0-9\s']/g, " ").split(/\s+/).filter(Boolean);
  const a = toks(said);
  const b = toks(expected);
  if (!b.length) return a.length ? 0 : 1;
  const bag = new Map<string, number>();
  for (const w of a) bag.set(w, (bag.get(w) || 0) + 1);
  let hit = 0;
  for (const w of b) {
    const n = bag.get(w) || 0;
    if (n > 0) {
      hit++;
      bag.set(w, n - 1);
    }
  }
  const coverage = hit / b.length; // how much of the expected line was actually said
  const precision = hit / a.length; // guard against a wall of unrelated words counting as a match
  return coverage * 0.8 + Math.min(1, precision) * 0.2;
}

export const LINE_MATCH_THRESHOLD = 0.6; // "within reason" — tune against real reads
