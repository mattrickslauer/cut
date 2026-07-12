import type { Metadata } from "next";
import AuditionRoom from "./AuditionRoom";

export const metadata: Metadata = {
  title: "Cut! — Audition Room",
  description: "Hands-free self-tape studio with a voiced AI scene partner.",
};

export default function AuditionPage() {
  return <AuditionRoom />;
}
