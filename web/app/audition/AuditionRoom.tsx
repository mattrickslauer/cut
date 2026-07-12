"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { AuditionEngine, initialView, type AuditionView, type PillKind } from "@/lib/audition/engine";
import { SCENES } from "@/lib/audition/scenes";
import styles from "./audition.module.css";

function PillContent({ view, aiName }: { view: AuditionView; aiName: string }) {
  if (view.pillOverride) return <>{view.pillOverride}</>;
  switch (view.pillKind) {
    case "idle":
      return (
        <>
          Press <b>Start audition</b>
        </>
      );
    case "listening":
      return <>🎧 Your turn — act (Space / tap when done)</>;
    case "hearing":
      return <>Hearing you…</>;
    case "thinking":
      return <>Reader responding…</>;
    case "speaking":
      return <>{aiName} is speaking</>;
    default:
      return null;
  }
}

export default function AuditionRoom() {
  const camRef = useRef<HTMLVideoElement>(null);
  const playbackRef = useRef<HTMLVideoElement>(null);
  const playerRef = useRef<HTMLAudioElement>(null);
  const meterRef = useRef<HTMLElement>(null);
  const engineRef = useRef<AuditionEngine | null>(null);

  const [sceneIndex, setSceneIndex] = useState(0);
  const [scriptText, setScriptText] = useState("");
  const [view, setView] = useState<AuditionView>(initialView());

  useEffect(() => {
    const engine = new AuditionEngine({
      cam: camRef.current!,
      playback: playbackRef.current!,
      player: playerRef.current!,
      meterFill: meterRef.current!,
      scene: SCENES[0],
      onChange: setView,
    });
    engineRef.current = engine;
    engine.initCamera();

    const onKey = (e: KeyboardEvent) => {
      if (e.code === "Space") {
        e.preventDefault();
        engine.manualDone();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      engine.dispose();
      engineRef.current = null;
    };
  }, []);

  const scene = SCENES[sceneIndex];
  const aiName = scene.ai_character.split(",")[0];

  const onScene = (i: number) => {
    setSceneIndex(i);
    engineRef.current?.setScene(SCENES[i]);
  };
  const onScript = (t: string) => {
    setScriptText(t);
    engineRef.current?.setScript(t);
  };

  const pillClass = [styles.pill, styles[view.pillKind as PillKind]].join(" ");

  return (
    <div className={styles.page}>
      <header className={styles.topbar}>
        <div className={styles.brand}>
          <span className={styles.clap}>🎬</span>
          <h1>
            Cut!<span className={styles.sub}>Audition Room — read with your AI scene partner</span>
          </h1>
        </div>
        <div className={styles.session}>
          <Link href="/" className={styles.home}>
            ← Studio
          </Link>
          <span className={`${styles.recDot} ${view.recOn ? styles.on : ""}`} />
          <span className={styles.mono}>{view.sessionTime}</span>
        </div>
      </header>

      <main className={styles.room}>
        {/* LEFT: scene setup */}
        <section className={styles.panel}>
          <div className={styles.panelLabel}>SCENE</div>
          <label className={styles.field}>
            <span>Sides</span>
            <select
              className={styles.select}
              value={sceneIndex}
              onChange={(e) => onScene(Number(e.target.value))}
            >
              {SCENES.map((s, i) => (
                <option key={s.id} value={i}>
                  {s.title}
                </option>
              ))}
            </select>
          </label>
          <div className={styles.sceneCard}>
            <div className={styles.sceneRow}>
              <b>You play</b>
              <span>{scene.human_character}</span>
            </div>
            <div className={styles.sceneRow}>
              <b>Reading with</b>
              <span>{scene.ai_character}</span>
            </div>
            <p className={styles.premise}>{scene.premise}</p>
            <p className={styles.opening}>
              Opens with: <em>&ldquo;{scene.opening}&rdquo;</em>
            </p>
          </div>
          <label className={styles.field} style={{ marginTop: 14 }}>
            <span>
              Script to follow <em>(optional)</em>
            </span>
            <textarea
              className={styles.textarea}
              rows={4}
              value={scriptText}
              onChange={(e) => onScript(e.target.value)}
              placeholder="Paste the sides — the co-star follows its lines. Leave blank to improvise from the premise."
            />
          </label>
          <div className={styles.controls}>
            <button
              className={`${styles.btn} ${styles.primary}`}
              disabled={!view.canStart}
              onClick={() => engineRef.current?.start()}
            >
              Start audition
            </button>
            <button
              className={`${styles.btn} ${styles.stop}`}
              disabled={!view.canStop}
              onClick={() => engineRef.current?.stop()}
            >
              ■ Stop
            </button>
            <button
              className={`${styles.btn} ${styles.ghost}`}
              disabled={!view.canNewTake}
              onClick={() => engineRef.current?.newTake()}
            >
              ↺ New take
            </button>
            <button
              className={`${styles.btn} ${styles.ghost}`}
              disabled={!view.canSave}
              onClick={() => engineRef.current?.save()}
            >
              ⬇ Save take
            </button>
          </div>
          <p className={`${styles.hint} ${styles.mono}`}>
            Once you start, just act — it hears when you finish and replies. If it misses your
            ending, press <b>Space</b> or tap the video to send. Camera previews on load.
          </p>
        </section>

        {/* CENTER: the self-tape */}
        <section className={`${styles.panel} ${styles.stage}`}>
          <div className={styles.videoWrap} onClick={() => engineRef.current?.manualDone()}>
            <video ref={camRef} className={styles.cam} playsInline autoPlay muted />
            <video ref={playbackRef} className={styles.playback} playsInline controls hidden={!view.playbackVisible} />
            {view.camOff && (
              <div className={styles.camOff}>
                <p>{view.camOffText}</p>
              </div>
            )}
            <div className={pillClass}>
              <PillContent view={view} aiName={aiName} />
            </div>
            <div className={styles.meter}>
              <i ref={meterRef} />
            </div>
            <div className={styles.subtitle}>{view.subtitle}</div>
            <div className={styles.whoSpoke}>{view.whoSpoke}</div>
          </div>
          <audio ref={playerRef} hidden />
        </section>

        {/* RIGHT: transcript + notes */}
        <section className={`${styles.panel} ${styles.side}`}>
          <div className={styles.panelLabel}>
            THE SCENE <span className={styles.tag}>{view.takeLabel}</span>
          </div>
          <div className={styles.dialogue}>
            {view.dialogue.map((t) => (
              <div
                key={t.id}
                className={`${styles.turn} ${styles[t.kind]} ${t.thinking ? styles.thinking : ""}`}
              >
                <div className={styles.who}>{t.who}</div>
                <div>{t.text}</div>
              </div>
            ))}
          </div>
          <div className={styles.panelLabel} style={{ marginTop: 14 }}>
            READER&rsquo;S NOTES <span className={`${styles.tag} ${styles.cut}`}>tune</span>
          </div>
          <div className={styles.stakesWrap}>
            <span className={styles.mono}>stakes</span>
            <div className={styles.stakes}>
              {[0, 1, 2, 3, 4].map((ix) => (
                <i key={ix} className={ix < view.stakes ? styles.on : ""} />
              ))}
            </div>
          </div>
          <div className={styles.notesList}>
            {view.notes.length === 0 ? (
              <p className={styles.muted}>Notes on your delivery appear here after each line.</p>
            ) : (
              view.notes.map((n) => (
                <div key={n.id} className={styles.note}>
                  <div className={styles.nLine}>&ldquo;{n.line}&rdquo;</div>
                  <div>{n.note}</div>
                </div>
              ))
            )}
          </div>
        </section>
      </main>
    </div>
  );
}
