"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { AuditionEngine, initialView, type AuditionView, type PillKind } from "@/lib/audition/engine";
import { SCENES } from "@/lib/audition/scenes";
import SceneCarousel from "./SceneCarousel";
import styles from "./audition.module.css";

function PillContent({ view, aiName }: { view: AuditionView; aiName: string }) {
  if (view.pillOverride) return <>{view.pillOverride}</>;
  switch (view.pillKind) {
    case "idle":
      return (
        <>
          Press <b>Start</b>
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
  const [scriptText, setScriptText] = useState(SCENES[0].sides ?? "");
  const [pickerOpen, setPickerOpen] = useState(true); // greet with the scene library
  const [setupOpen, setSetupOpen] = useState(false); // scene + script + compile drawer
  const [notesOpen, setNotesOpen] = useState(false); // transcript + reader's notes + takes drawer
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
    engine.loadScene(SCENES[0]); // pull in the opening scene's baked-in sides + any pre-rendered co-star

    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return; // don't hijack keys while editing the script
      if (e.code === "Space") {
        e.preventDefault();
        engine.manualDone();
      } else if (e.code === "KeyL") {
        e.preventDefault();
        engine.callLine(); // "Line!" — prompt my current line
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

  // Pick a scene from the library carousel: load it whole (swaps sides + binds the pre-rendered
  // co-star), mirror its sides into the editable textarea, and close the picker.
  const onPick = (i: number) => {
    setSceneIndex(i);
    setScriptText(SCENES[i].sides ?? "");
    engineRef.current?.loadScene(SCENES[i]);
    setPickerOpen(false);
  };
  const onScript = (t: string) => {
    setScriptText(t);
    engineRef.current?.setScript(t);
  };

  const pillClass = [styles.pill, styles[view.pillKind as PillKind]].join(" ");
  const noteCount = view.notes.length;
  // Reminder to the actor: only useful while set up and not mid-take or reviewing playback.
  const showCoach = !view.recOn && !view.playbackVisible && view.canStart;

  return (
    <div className={styles.page}>
      {/* ===== FULL-SCREEN CAMERA ===== */}
      <div className={styles.stageFull}>
        <video ref={camRef} className={styles.cam} playsInline autoPlay muted />
        <video ref={playbackRef} className={styles.playback} playsInline controls hidden={!view.playbackVisible} />

        {/* transparent tap layer — tap the frame to signal "I'm done" (sits under the HUD) */}
        <div className={styles.tapLayer} onClick={() => engineRef.current?.manualDone()} />

        {view.camOff && (
          <div className={styles.camOff}>
            <p>{view.camOffText}</p>
          </div>
        )}

        {/* level meter along the very bottom edge */}
        <div className={styles.meter}>
          <i ref={meterRef} />
        </div>
      </div>
      <audio ref={playerRef} hidden />

      {/* ===== COMPACT TOP HUD ===== */}
      <header className={styles.hudTop}>
        <div className={styles.hudLeft}>
          <Link href="/" className={styles.homeChip} title="Back to Studio">
            ←
          </Link>
          <button
            className={styles.sceneChip}
            onClick={() => setPickerOpen(true)}
            title="Browse the scene library"
          >
            <span className={styles.clap}>🎬</span>
            <span className={styles.sceneChipText}>
              <b>{scene.title}</b>
              {scene.film && <em>{scene.film}</em>}
            </span>
            <span className={styles.chev}>▾</span>
          </button>
        </div>
        <div className={styles.hudRight}>
          <span className={`${styles.recDot} ${view.recOn ? styles.on : ""}`} />
          <span className={styles.mono}>{view.sessionTime}</span>
        </div>
      </header>

      {/* ===== STATE + PERFORMANCE OVERLAYS ===== */}
      <div className={pillClass}>
        <PillContent view={view} aiName={aiName} />
      </div>

      {view.linePrompt && (
        <div className={styles.linePrompt}>
          <span className={styles.lpTag}>Line</span>
          <div className={styles.lpText}>{view.linePrompt}</div>
        </div>
      )}

      {/* coaching reminder — eyeline + the hands-free "Line!" trick */}
      {showCoach && (
        <div className={styles.coach}>
          <div className={styles.coachEye}>🎥</div>
          <p>
            Look <b>right into the camera</b>.
          </p>
          <p className={styles.coachSub}>
            Forget a line? Just say <b>&ldquo;Line&rdquo;</b> out loud — the reader feeds it back to you.
          </p>
        </div>
      )}

      {/* ===== BOTTOM STACK — co-star caption + the script, above the dock ===== */}
      <div className={styles.bottomStack}>
        {(view.subtitle || view.whoSpoke) && (
          <div className={styles.captionWrap}>
            <div className={styles.subtitle}>{view.subtitle}</div>
            <div className={styles.whoSpoke}>{view.whoSpoke}</div>
          </div>
        )}
        {view.scriptLines.length > 0 && (
          <div className={styles.teleprompter} aria-label="script follow-along">
            {view.scriptLines.map((l) => {
              const cls = [styles.tLine, l.who === "actor" ? styles.tActor : styles.tCostar];
              if (view.currentLine === l.i) cls.push(styles.tCurrent);
              else if (view.currentLine > l.i) cls.push(styles.tDone);
              return (
                <div key={l.i} className={cls.join(" ")}>
                  <span className={styles.tWho}>{l.who === "actor" ? "You" : aiName}</span>
                  <span className={styles.tText}>{l.text}</span>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* ===== CONTROL OVERLAY — all the transport in one floating bar ===== */}
      <div className={styles.dock}>
        <div className={styles.dockBar}>
          {view.canStop ? (
            <button
              className={`${styles.round} ${styles.stopRound}`}
              onClick={() => engineRef.current?.stop()}
              title="Stop"
            >
              ■
            </button>
          ) : (
            <button
              className={`${styles.round} ${styles.recRound}`}
              disabled={!view.canStart}
              onClick={() => engineRef.current?.start()}
              title="Start audition"
            >
              <span className={styles.recRing} />
            </button>
          )}

          <button
            className={`${styles.pillBtn} ${styles.lineBtn}`}
            disabled={!view.canStop || !view.scripted}
            onClick={() => engineRef.current?.callLine()}
            title="Prompt my current line (L)"
          >
            🎭 Line! <span className={styles.mono}>L</span>
          </button>

          <button
            className={styles.pillBtn}
            disabled={!view.canNewTake}
            onClick={() => engineRef.current?.newTake()}
            title="New take"
          >
            ↺ <span className={styles.dockLabel}>New take</span>
          </button>

          <button
            className={styles.pillBtn}
            disabled={!view.canSave}
            onClick={() => engineRef.current?.save()}
            title="Save take"
          >
            ⬇ <span className={styles.dockLabel}>Save</span>
          </button>

          <div className={styles.dockDivider} />

          <button
            className={`${styles.pillBtn} ${setupOpen ? styles.pillOn : ""}`}
            onClick={() => {
              setSetupOpen((v) => !v);
              setNotesOpen(false);
            }}
            title="Scene & script setup"
          >
            ⚙ <span className={styles.dockLabel}>Setup</span>
          </button>

          <button
            className={`${styles.pillBtn} ${notesOpen ? styles.pillOn : ""}`}
            onClick={() => {
              setNotesOpen((v) => !v);
              setSetupOpen(false);
            }}
            title="Transcript, notes & takes"
          >
            🗒 <span className={styles.dockLabel}>Notes</span>
            {noteCount > 0 && <span className={styles.badge}>{noteCount}</span>}
          </button>
        </div>
      </div>

      {/* ===== SETUP DRAWER — scene, sides, compile, reset ===== */}
      {setupOpen && (
        <>
          <div className={styles.scrim} onClick={() => setSetupOpen(false)} />
          <aside className={`${styles.drawer} ${styles.drawerLeft}`}>
            <div className={styles.drawerHead}>
              <span className={styles.panelLabel}>SCENE &amp; SCRIPT</span>
              <button className={styles.drawerClose} onClick={() => setSetupOpen(false)}>
                ✕
              </button>
            </div>
            <div className={styles.drawerBody}>
              <button className={styles.browseBtn} onClick={() => setPickerOpen(true)}>
                🎞️ Browse scene library
              </button>
              <div className={styles.sceneCard}>
                <div className={styles.sceneTitleRow}>
                  <b className={styles.sceneName}>{scene.title}</b>
                  {scene.film && (
                    <span className={styles.sceneFilm}>
                      {scene.film}
                      {scene.year ? ` · ${scene.year}` : ""}
                    </span>
                  )}
                </div>
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
                  rows={5}
                  value={scriptText}
                  onChange={(e) => onScript(e.target.value)}
                  placeholder="Paste the sides — the co-star follows its lines. Leave blank to improvise from the premise."
                />
              </label>
              {view.prerendered ? (
                <div className={styles.compileWrap}>
                  <div className={styles.preReady}>✓ Pre-rendered co-star ready — just press Start</div>
                  <p className={`${styles.hint} ${styles.mono}`}>
                    This scene ships a filmed scene partner (a portrait + one lip-synced clip per
                    line), so it performs as a real face instantly. Edit the sides to re-film your own.
                  </p>
                </div>
              ) : (view.canCompile || view.compiling || view.compiled) && (
                <div className={styles.compileWrap}>
                  <button
                    className={`${styles.btn} ${styles.compile}`}
                    disabled={view.compiling || (!view.canCompile && !view.compiled)}
                    onClick={() => engineRef.current?.compile()}
                  >
                    {view.compiling
                      ? `🎬 Compiling… ${view.compileProgress}/${view.compileTotal}`
                      : view.compiled
                        ? "✓ Compiled — recompile co-star"
                        : "🎬 Compile talking-head co-star"}
                  </button>
                  {view.compiling && (
                    <div className={styles.compileBar}>
                      <i style={{ width: `${(view.compileProgress / Math.max(1, view.compileTotal)) * 100}%` }} />
                    </div>
                  )}
                  <p className={`${styles.hint} ${styles.mono}`} style={{ marginTop: 6 }}>
                    Pre-renders each co-star line as a lip-synced clip (~1–5 min per line). Optional —
                    skip it to rehearse with just the voice.
                  </p>
                </div>
              )}
              <button
                className={`${styles.btn} ${styles.ghost} ${styles.reset}`}
                style={{ marginTop: 14 }}
                onClick={() => engineRef.current?.reset()}
              >
                ⟲ Reset — start over
              </button>
            </div>
          </aside>
        </>
      )}

      {/* ===== NOTES DRAWER — transcript, reader's notes, takes ===== */}
      {notesOpen && (
        <>
          <div className={styles.scrim} onClick={() => setNotesOpen(false)} />
          <aside className={`${styles.drawer} ${styles.drawerRight}`}>
            <div className={styles.drawerHead}>
              <span className={styles.panelLabel}>
                THE SCENE <span className={styles.tag}>{view.takeLabel}</span>
              </span>
              <button className={styles.drawerClose} onClick={() => setNotesOpen(false)}>
                ✕
              </button>
            </div>
            <div className={styles.drawerBody}>
              <div className={styles.dialogue}>
                {view.dialogue.length === 0 ? (
                  <p className={styles.muted}>The scene transcript builds here as you play.</p>
                ) : (
                  view.dialogue.map((t) => (
                    <div
                      key={t.id}
                      className={`${styles.turn} ${styles[t.kind]} ${t.thinking ? styles.thinking : ""}`}
                    >
                      <div className={styles.who}>{t.who}</div>
                      <div>{t.text}</div>
                    </div>
                  ))
                )}
              </div>

              <div className={styles.panelLabel} style={{ marginTop: 16 }}>
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

              {view.takes.length > 0 && (
                <>
                  <div className={styles.panelLabel} style={{ marginTop: 16 }}>
                    TAKES <span className={styles.tag}>compare</span>
                  </div>
                  <div className={styles.takeCol}>
                    {view.takes.map((t) => (
                      <div key={t.id} className={styles.takeCard}>
                        <div className={styles.takeHead}>
                          <b>Take {t.n}</b>
                          <div className={styles.stakes}>
                            {[0, 1, 2, 3, 4].map((ix) => (
                              <i key={ix} className={ix < t.stakes ? styles.on : ""} />
                            ))}
                          </div>
                        </div>
                        <video className={styles.takeVid} src={t.url} controls playsInline />
                        <div className={styles.takeNotes}>
                          {t.notes.length === 0 ? (
                            <p className={styles.muted}>No notes on this take.</p>
                          ) : (
                            t.notes.map((n) => (
                              <div key={n.id} className={styles.note}>
                                <div className={styles.nLine}>&ldquo;{n.line}&rdquo;</div>
                                <div>{n.note}</div>
                              </div>
                            ))
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </div>
          </aside>
        </>
      )}

      {pickerOpen && (
        <SceneCarousel
          scenes={SCENES}
          index={sceneIndex}
          onSelect={onPick}
          onClose={() => setPickerOpen(false)}
        />
      )}
    </div>
  );
}
