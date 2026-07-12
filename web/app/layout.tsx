import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Cut! — Studio",
  description:
    "Cut! — the AI film studio. Director Control Panel and Audition Room in one app.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
