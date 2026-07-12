// Cinematic "looks" — canvas filter strings. Stand-ins for the Editor agent's grade decisions.
export const GRADES: Record<string, string> = {
  Neutral: "none",
  Noir: "grayscale(1) contrast(1.35) brightness(0.92)",
  "Sci-Fi": "saturate(1.2) contrast(1.15) hue-rotate(-12deg) brightness(1.02)",
  Golden: "sepia(0.35) saturate(1.3) contrast(1.05) brightness(1.05)",
  Thriller: "saturate(0.7) contrast(1.25) hue-rotate(6deg) brightness(0.95)",
};
