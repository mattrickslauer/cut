// The scene library. Each entry is a two-hander you can read against the AI co-star: the sides are
// baked in (auto-loaded into the teleprompter and driven by the co-star), the picker renders each
// one as a full-screen poster slide, and — when a co-star has been pre-rendered — a portrait + one
// lip-synced clip per co-star line ship alongside so the partner performs as a real face instantly,
// with no on-device compile.

import prerendered from "./costars.json";

// A pre-rendered ("pre-compiled") co-star: a portrait still + one talking-head clip per co-star
// line, in the order the co-star's lines appear in `sides`. When present, the Audition Room binds
// these instead of generating a face on the fly; a missing/404 clip degrades to voice-only.
//
// These aren't hand-written into the scenes below — they're attached from costars.json, which the
// prerender script (web/scripts/prerender-costars.mjs) fills after rendering each co-star's lines to
// web/public/costar-clips/<scene-id>/. Empty manifest ⇒ no pre-rendered co-stars, and every scene
// still reads with the live voice partner. Run the script to light them up.
export type Costar = {
  portrait: string; // still image URL for the talking-head (public path or data URI)
  clips: string[]; // one clip URL per co-star line, in script order
};

export type Scene = {
  id: string;
  title: string;
  ai_character: string;
  human_character: string;
  premise: string;
  tone: string;
  voice: string;
  // The co-star's voice gender. Drives male/female TTS voice selection when `voice` isn't pinned
  // (custom/improvised/generated scenes); the backend falls back to inferring it from the script.
  gender?: "male" | "female";
  opening: string;
  // library extras (optional so hand-authored/blank scenes still type-check)
  film?: string; // source film, shown on the poster
  year?: number;
  poster?: string; // CSS background for the slide (gradient); emoji + text overlay come from the fields
  emoji?: string; // a single glyph that anchors the poster art
  sides?: string; // the scene's sides, pre-loaded into the teleprompter + co-star
  costar?: Costar; // pre-rendered talking-head, if one has been filmed for this scene
};

// Iconic film two-handers. The `voice` is a qwen3-tts-flash voice, gender-matched to the co-star;
// `gender` records that match so custom/improvised/generated co-stars (which don't pin a `voice`)
// still get a male/female voice — the backend falls back to inferring gender from the script.
// `sides` use the inline "SPEAKER: line" format the parser understands; the co-star is whichever
// speaker matches `ai_character`, you read the rest. Excerpts are kept short — audition sides, not
// full scenes.
const LIBRARY: Scene[] = [
  {
    id: "will-hunting",
    title: "It's not your fault",
    film: "Good Will Hunting",
    year: 1997,
    emoji: "🪑",
    poster: "linear-gradient(150deg, #1b2a4a 0%, #24506e 55%, #0e1626 100%)",
    ai_character: "SEAN, a weathered therapist",
    human_character: "WILL, a guarded young genius",
    premise:
      "A therapist keeps repeating three words until his brilliant, armored patient finally lets them land. The quietest scene in the film and the one that breaks it open.",
    tone: "gentle, immovable, tears under the surface",
    voice: "Elias", // measured male
    gender: "male",
    opening: "It's not your fault.",
    sides: `SEAN: It's not your fault.
WILL: I know.
SEAN: Look at me, son. It's not your fault.
WILL: I know.
SEAN: No. It's not your fault.
WILL: I know.
SEAN: It's not your fault.
WILL: Don't mess with me.
SEAN: It's not your fault.
WILL: I know.
SEAN: It's not your fault.`,
  },
  {
    id: "few-good-men",
    title: "The truth",
    film: "A Few Good Men",
    year: 1992,
    emoji: "⚖️",
    poster: "linear-gradient(150deg, #3a1414 0%, #6e2b24 50%, #140a0a 100%)",
    ai_character: "COLONEL JESSUP, a Marine base commander",
    human_character: "LT. KAFFEE, a young Navy lawyer",
    premise:
      "A hotshot Navy lawyer pushes a decorated colonel on the witness stand — and the colonel, contemptuous and cornered, decides to give him exactly what he's asking for.",
    tone: "combustible, contemptuous, high-stakes",
    voice: "Ethan", // male
    gender: "male",
    opening: "You want answers?",
    sides: `KAFFEE: I want the truth.
JESSUP: You can't handle the truth.
JESSUP: We live in a world that has walls, and those walls have to be guarded by men with guns.
KAFFEE: Did you order the Code Red?
JESSUP: I did the job I—
KAFFEE: Did you order the Code Red?
JESSUP: You're goddamn right I did.`,
  },
  {
    id: "devil-prada",
    title: "That blue sweater",
    film: "The Devil Wears Prada",
    year: 2006,
    emoji: "👠",
    poster: "linear-gradient(150deg, #2a2440 0%, #574a7a 55%, #12101c 100%)",
    ai_character: "MIRANDA, a glacial magazine editor",
    human_character: "ANDY, her new assistant",
    premise:
      "A new assistant smirks at a debate over two identical belts. Her editor, without raising her voice, dismantles her — and the smirk — one sentence at a time.",
    tone: "icy, precise, quietly devastating",
    voice: "Serena", // mature female
    gender: "female",
    opening: "Something funny?",
    sides: `MIRANDA: Something funny?
ANDY: No. No, no. Nothing's — it's just that both those belts look exactly the same to me.
MIRANDA: This... stuff? You think this has nothing to do with you.
MIRANDA: That blue represents millions of dollars and countless jobs.
MIRANDA: And it's comical how you think you made a choice that exempts you from the fashion industry.
ANDY: I'm sorry.
MIRANDA: That's all.`,
  },
  {
    id: "social-network",
    title: "The breakup",
    film: "The Social Network",
    year: 2010,
    emoji: "💻",
    poster: "linear-gradient(150deg, #10241c 0%, #1f4d3c 55%, #08120e 100%)",
    ai_character: "ERICA, a sharp college girlfriend",
    human_character: "MARK, a fast-talking undergrad",
    premise:
      "A bar, a torrent of words, and a girlfriend who has finally had enough. She ends it in the time it takes him to finish a thought.",
    tone: "rapid-fire, wounded, done",
    voice: "Cherry", // bright female
    gender: "female",
    opening: "Is this real?",
    sides: `ERICA: Is this real?
MARK: You don't have to study.
ERICA: Why don't I have to study?
MARK: Because you go to B.U.
ERICA: Dating you is like dating a StairMaster.
MARK: I want to try to be straight with you.
ERICA: I think we should just be friends.
MARK: I don't want friends.
ERICA: You are going to go through life thinking that girls don't like you because you're a nerd. And it'll be because you're an asshole.`,
  },
  {
    id: "casablanca",
    title: "Of all the gin joints",
    film: "Casablanca",
    year: 1942,
    emoji: "🥃",
    poster: "linear-gradient(150deg, #2b2410 0%, #6e5a24 50%, #14110a 100%)",
    ai_character: "RICK, a jaded café owner",
    human_character: "ILSA, the woman who left him",
    premise:
      "Years after she vanished from a train platform, she walks into his bar in the last place he'd have picked. He's had a few. He isn't ready to be kind about it.",
    tone: "bruised, sardonic, aching",
    voice: "Elias", // measured male
    gender: "male",
    opening: "Of all the gin joints in all the towns in all the world, she walks into mine.",
    sides: `RICK: Of all the gin joints in all the towns in all the world, she walks into mine.
ILSA: I wouldn't have come if I'd known you were here.
RICK: It's funny about your voice, how it hasn't changed. I can still hear it.
ILSA: I've been thinking of a way to explain.
RICK: I saved my first drink to have with you. Here.
ILSA: Rick, I can't. Not tonight.
RICK: Here's looking at you, kid.`,
  },
  {
    id: "oneword",
    title: "Cold read — open improv",
    emoji: "🎭",
    poster: "linear-gradient(150deg, #23252b 0%, #3a3f4a 55%, #101216 100%)",
    ai_character: "a stranger with a secret",
    human_character: "yourself",
    premise:
      "Not from a film — a pure improv two-hander. The AI plays a stranger who clearly knows something you do not. No sides; follow the scene wherever it goes.",
    tone: "natural, grounded, discovery",
    voice: "Elias", // measured male
    gender: "male",
    opening: "You're early. That's either very good or very bad.",
  },
];

// Attach any pre-rendered co-star (portrait + per-line clips) that's been filmed for a scene.
const MANIFEST = prerendered as Record<string, Costar>;
export const SCENES: Scene[] = LIBRARY.map((s) =>
  MANIFEST[s.id]?.clips?.length ? { ...s, costar: MANIFEST[s.id] } : s,
);
