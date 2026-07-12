"use client";

import { useEffect, useState } from "react";
import type { Scene } from "@/lib/audition/scenes";
import styles from "./audition.module.css";

// A full-screen poster carousel for picking a scene: one film slide at a time, arrow-key / button
// navigation, dots to jump, and "Read this scene" to load it. Purely presentational — it reports the
// chosen index up to the Audition Room, which drives the engine.
export default function SceneCarousel({
  scenes,
  index,
  onSelect,
  onClose,
}: {
  scenes: Scene[];
  index: number;
  onSelect: (i: number) => void;
  onClose: () => void;
}) {
  const [cursor, setCursor] = useState(index);
  const n = scenes.length;
  const go = (d: number) => setCursor((c) => (c + d + n) % n);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowRight") { e.preventDefault(); go(1); }
      else if (e.key === "ArrowLeft") { e.preventDefault(); go(-1); }
      else if (e.key === "Enter") { e.preventDefault(); onSelect(cursor); }
      else if (e.key === "Escape") { e.preventDefault(); onClose(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cursor, n]);

  const s = scenes[cursor];
  const aiName = s.ai_character.split(",")[0];
  const filmed = !!(s.costar && s.costar.clips.length);

  return (
    <div className={styles.carousel} role="dialog" aria-modal="true" aria-label="Choose a scene">
      <header className={styles.carHead}>
        <div className={styles.carTitle}>
          <span className={styles.clap}>🎞️</span> Scene library
          <span className={styles.carCount}>{cursor + 1} / {n}</span>
        </div>
        <button className={styles.carClose} onClick={onClose} aria-label="Close">✕</button>
      </header>

      <div className={styles.carStage}>
        <button className={`${styles.carArrow} ${styles.carPrev}`} onClick={() => go(-1)} aria-label="Previous scene">‹</button>

        <div className={styles.slide} style={{ background: s.poster }}>
          <div className={styles.slideGlow} />
          <div className={styles.slideEmoji}>{s.emoji ?? "🎬"}</div>
          <div className={styles.slideBadges}>
            {s.film ? (
              <span className={styles.slideFilm}>{s.film}{s.year ? ` · ${s.year}` : ""}</span>
            ) : (
              <span className={styles.slideFilm}>Improv · no sides</span>
            )}
            {filmed && <span className={styles.slidePre}>● Pre-rendered co-star</span>}
          </div>
          <h2 className={styles.slideTitle}>{s.title}</h2>
          <div className={styles.slideRoles}>
            <span className={styles.roleChip}><b>You play</b> {s.human_character}</span>
            <span className={styles.roleChip}><b>Reading with</b> {s.ai_character}</span>
          </div>
          <p className={styles.slidePremise}>{s.premise}</p>
          <p className={styles.slideOpen}>Opens: <em>&ldquo;{s.opening}&rdquo;</em></p>
          <button className={styles.slideGo} onClick={() => onSelect(cursor)}>
            Read this scene with {aiName} →
          </button>
        </div>

        <button className={`${styles.carArrow} ${styles.carNext}`} onClick={() => go(1)} aria-label="Next scene">›</button>
      </div>

      <div className={styles.carDots}>
        {scenes.map((sc, i) => (
          <button
            key={sc.id}
            className={`${styles.carDot} ${i === cursor ? styles.carDotOn : ""}`}
            onClick={() => setCursor(i)}
            aria-label={`Go to ${sc.title}`}
            title={sc.film ?? sc.title}
          />
        ))}
      </div>
    </div>
  );
}
