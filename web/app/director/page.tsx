import type { Metadata } from "next";
import DirectorPanel from "./DirectorPanel";

export const metadata: Metadata = {
  title: "Cut! — Director Control Panel",
  description: "Your webcam, directed live by an AI eye that calls the look and conjures worlds.",
};

export default function DirectorPage() {
  return <DirectorPanel />;
}
