"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { DirectorEngine, initialView, type DirectorView } from "@/lib/director/engine";
import { GRADES } from "@/lib/director/grades";
import { BG_LIST } from "@/lib/director/backgrounds";
import styles from "./director.module.css";

function bgLabel(n: string) {
  return n === "Auto" ? "Auto (director)" : n === "None" ? "None (real)" : n;
}
function transcriptLabel(who: string) {
  return who === "A" ? "A" : who === "B" ? "B" : who === "both" ? "A+B" : "·";
}

export default function DirectorPanel() {
  const camRef = useRef<HTMLVideoElement>(null);
  const cutRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<DirectorEngine | null>(null);
  const [view, setView] = useState<DirectorView>(initialView());
  const [worldPrompt, setWorldPrompt] = useState("");

  useEffect(() => {
    const engine = new DirectorEngine({
      cam: camRef.current!,
      cut: cutRef.current!,
      onChange: setView,
    });
    engineRef.current = engine;
    engine.init();
    return () => {
      engine.dispose();
      engineRef.current = null;
    };
  }, []);

  const doGenerate = () => {
    const p = worldPrompt.trim();
    if (!p) return;
    engineRef.current?.generateFromPrompt(p);
  };

  return (
    <div className={styles.app}>
      <header className={styles.topbar}>
        <div className={styles.brand}>
          <span className={styles.clap}>🎬</span>
          <h1>
            Cut!<span className={styles.sub}>Director Control Panel</span>
          </h1>
        </div>
        <div className={styles.session}>
          <Link href="/" className={styles.home}>
            ← Studio
          </Link>
          <span className={`${styles.recDot} ${view.session ? styles.on : ""}`} />
          <span className={styles.mono}>{view.sessionTime}</span>
        </div>
      </header>

      <main className={styles.stage}>
        {/* RAW CAMERA */}
        <section className={styles.pane}>
          <div className={styles.paneLabel}>
            CAMERA <span className={styles.tag}>raw</span>
          </div>
          <div className={styles.videoWrap}>
            <video ref={camRef} className={styles.cam} playsInline autoPlay muted />
            {view.camPlaceholder && (
              <div className={styles.placeholder}>
                <p>Camera off</p>
                <button
                  className={`${styles.button} ${styles.primary}`}
                  onClick={() => engineRef.current?.startCamera(view.selectedDevice || undefined)}
                >
                  Start camera
                </button>
              </div>
            )}
          </div>
          <div className={`${styles.paneFoot} ${styles.mono}`}>
            <span>{view.rawRes}</span> · <span>{view.rawFps}</span> fps
          </div>
        </section>

        {/* DIRECTOR'S CUT */}
        <section className={styles.pane}>
          <div className={styles.paneLabel}>
            DIRECTOR&rsquo;S CUT <span className={`${styles.tag} ${styles.cut}`}>preview</span>
          </div>
          <div className={`${styles.videoWrap} ${styles.cut}`}>
            <canvas ref={cutRef} className={styles.cut} />
            <div className={`${styles.letterbox} ${styles.top}`} />
            <div
              className={`${styles.subtitle} ${view.subtitleShow ? styles.show : ""}`}
            >
              {view.subtitleWho && (
                <span className={`${styles.who} ${styles[view.subtitleWho]}`}>
                  {view.subtitleWho}:{" "}
                </span>
              )}
              {view.subtitleText}
            </div>
            <div className={`${styles.letterbox} ${styles.bottom}`} />
          </div>
          <div className={`${styles.paneFoot} ${styles.mono}`}>
            <span>{view.grade}</span> · <span>{view.cutFps}</span> fps
          </div>
        </section>
      </main>

      {/* CONTROL BAR */}
      <div className={styles.controls}>
        <div className={styles.group}>
          <label>Camera</label>
          <select
            className={styles.select}
            value={view.selectedDevice}
            onChange={(e) => engineRef.current?.setDevice(e.target.value)}
          >
            {view.devices.map((d) => (
              <option key={d.id} value={d.id}>
                {d.label}
              </option>
            ))}
          </select>
        </div>
        <div className={styles.group}>
          <label>Look</label>
          <div className={styles.chips}>
            {Object.keys(GRADES).map((name) => (
              <button
                key={name}
                className={`${styles.chip} ${view.grade === name ? styles.active : ""}`}
                onClick={() => engineRef.current?.setGrade(name)}
              >
                {name}
              </button>
            ))}
          </div>
        </div>
        <div className={styles.group}>
          <label>World</label>
          <select
            className={styles.select}
            value={view.bgName}
            onChange={(e) => engineRef.current?.setBg(e.target.value)}
          >
            {BG_LIST.map((n) => (
              <option key={n} value={n}>
                {bgLabel(n)}
              </option>
            ))}
          </select>
          <input
            className={styles.input}
            type="text"
            placeholder="describe a world…"
            value={worldPrompt}
            onChange={(e) => setWorldPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") doGenerate();
            }}
          />
          <button
            className={`${styles.button} ${styles.ghost}`}
            disabled={view.genBusy}
            onClick={doGenerate}
          >
            {view.genBusy ? "Generating…" : "Generate ✨"}
          </button>
        </div>
        <div className={`${styles.group} ${styles.grow}`} />
        <div className={styles.group}>
          <button
            className={`${styles.button} ${styles.ghost}`}
            disabled={!view.canSnap}
            onClick={() => engineRef.current?.snapshot()}
          >
            Snapshot
          </button>
          <button
            className={`${styles.button} ${!view.session ? styles.primary : ""}`}
            disabled={!view.canToggle}
            onClick={() => engineRef.current?.toggleSession()}
          >
            {view.toggleLabel}
          </button>
        </div>
      </div>

      {/* SIDE */}
      <aside className={styles.side}>
        <div className={styles.card}>
          <h2>Director state</h2>
          <dl className={styles.kv}>
            <dt>Scene</dt>
            <dd>{view.scene}</dd>
            <dt>Mood</dt>
            <dd>{view.mood}</dd>
            <dt>Shot</dt>
            <dd>{view.shot}</dd>
          </dl>
          <div className={styles.cast}>
            {view.cast.map((c) => (
              <div
                key={c.label}
                className={`${styles.castChip} ${styles["c" + c.label]} ${
                  c.state === "on" ? styles.on : c.state === "detected" ? styles.detected : ""
                }`}
              >
                Character {c.label}
                {c.state === "on" ? " 🎤" : ""}
              </div>
            ))}
          </div>
        </div>

        <div className={`${styles.card} ${styles.grow}`}>
          <h2>Transcript</h2>
          <div className={styles.transcript}>
            {view.transcript.map((l, i) => (
              <div key={`${l.seq}-${i}`} className={styles.line}>
                <span className={`${styles.who} ${styles[transcriptTag(l.who)]}`}>
                  {transcriptLabel(l.who)}
                </span>
                {l.text}
              </div>
            ))}
          </div>
        </div>

        <div className={`${styles.card} ${styles.grow}`}>
          <h2>Director&rsquo;s log</h2>
          <div className={styles.log}>
            {view.log.map((e) => (
              <div key={e.id} className={`${styles.entry} ${e.hot ? styles.hot : ""}`}>
                <span className={styles.t}>{e.t}</span>
                {e.text}
              </div>
            ))}
          </div>
        </div>
      </aside>
    </div>
  );
}

function transcriptTag(who: string): "A" | "B" | "x" {
  return who === "A" ? "A" : who === "B" ? "B" : "x";
}
