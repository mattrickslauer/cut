export type Scene = {
  id: string;
  title: string;
  ai_character: string;
  human_character: string;
  premise: string;
  tone: string;
  voice: string;
  opening: string;
};

// The sides you can read. voice is a qwen3-tts-flash voice, gender-matched per role.
export const SCENES: Scene[] = [
  {
    id: "diner",
    title: "The Diner — drama",
    ai_character: "MAYA, an ex who moved on",
    human_character: "the one who came back",
    premise:
      "Two former partners collide at a late-night diner a year after a bad breakup. One wants closure; the other has already let go.",
    tone: "restrained, aching, subtext-heavy",
    voice: "Serena", // mature female
    opening: "I didn't think you still knew this place existed.",
  },
  {
    id: "heist",
    title: "The Job — thriller",
    ai_character: "DELACROIX, a nervous crew lead",
    human_character: "the specialist they hired",
    premise:
      "Minutes before a job goes live, the crew lead realizes the plan has a hole and confronts the specialist who swore it was airtight.",
    tone: "tense, clipped, high-stakes",
    voice: "Ethan", // male
    opening: "Tell me the third floor is handled. Look at me and tell me.",
  },
  {
    id: "sitcom",
    title: "Roommates — comedy",
    ai_character: "SAM, an over-caffeinated roommate",
    human_character: "the exhausted roommate",
    premise:
      'One roommate has "improved" the apartment with a baffling new system while the other just wants coffee at 7am.',
    tone: "fast, warm, comedic",
    voice: "Cherry", // bright female
    opening:
      "Okay before you say anything — the color-coding is going to change your LIFE.",
  },
  {
    id: "oneword",
    title: "Cold read — open improv",
    ai_character: "a stranger with a secret",
    human_character: "yourself",
    premise:
      "A pure improv two-hander. The AI plays a stranger who clearly knows something you do not. Follow the scene wherever it goes.",
    tone: "natural, grounded, discovery",
    voice: "Elias", // measured male
    opening: "You're early. That's either very good or very bad.",
  },
];
