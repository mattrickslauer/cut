import Link from "next/link";
import styles from "./home.module.css";

export default function Home() {
  return (
    <main className={styles.page}>
      {/* ── Nav ─────────────────────────────────────────────── */}
      <nav className={styles.nav}>
        <div className={styles.navBrand}>
          <span className={styles.clap}>🎬</span>
          <span>
            Cut!<span className={styles.navSub}>AI FILM STUDIO</span>
          </span>
        </div>
        <div className={styles.navLinks}>
          <Link href="/director" className={styles.navLink}>
            Director
          </Link>
          <Link href="/audition" className={styles.navLink}>
            Audition
          </Link>
          <Link href="/director" className={styles.navCta}>
            Enter the studio →
          </Link>
        </div>
      </nav>

      {/* ── Hero ────────────────────────────────────────────── */}
      <header className={styles.hero}>
        <div className={styles.glow} aria-hidden />
        <span className={styles.eyebrow}>🎬 THE AI FILM STUDIO</span>
        <h1 className={styles.h1}>
          You bring the performance.
          <br />
          <span className={styles.accentText}>Cut brings the crew.</span>
        </h1>
        <p className={styles.lede}>
          Two rooms, one studio. Direct a live self-shot scene with an AI eye
          that calls the look and builds the world around you — or run an
          audition self-tape with a voiced AI scene partner that actually acts
          back.
        </p>
        <div className={styles.heroCtas}>
          <Link href="/director" className={styles.btnPrimary}>
            Enter the Director&rsquo;s room →
          </Link>
          <Link href="/audition" className={styles.btnGhost}>
            Step into the Audition room
          </Link>
        </div>
        <p className={styles.trust}>
          <span className="mono">
            Runs in your browser · camera + mic only · nothing to install
          </span>
        </p>
      </header>

      {/* ── Pitch ───────────────────────────────────────────── */}
      <section className={styles.pitch}>
        <p className={styles.pitchLead}>
          Making a scene used to take a room full of people — a director, a
          reader, a colorist, a set.
        </p>
        <p className={styles.pitchPunch}>
          Now it&rsquo;s just you and a webcam. Cut gives you the rest of the
          crew.
        </p>
      </section>

      {/* ── Product: Director ───────────────────────────────── */}
      <section className={`${styles.feature} ${styles.featureDirector}`}>
        <div className={styles.featureCopy}>
          <div className={styles.featureTag}>DIRECTOR · LIVE</div>
          <h2 className={styles.h2}>An AI director, watching every frame.</h2>
          <p className={styles.featureBody}>
            Your webcam becomes a directed shot. Cut watches the scene in real
            time, calls the grade, drops you into a generated world, and
            captions the room as the action unfolds.
          </p>
          <ul className={styles.bullets}>
            <li>Cinematic color grades, called shot by shot</li>
            <li>AI-generated backgrounds that replace the room behind you</li>
            <li>Live captions and scene notes as you play</li>
            <li>30–60fps in-browser pipeline — no plugins, no render wait</li>
          </ul>
          <Link href="/director" className={styles.featureLink}>
            Enter the control room →
          </Link>
        </div>
        <div className={styles.featurePanel} aria-hidden>
          <div className={styles.mockBar}>
            <span className={styles.dot} />
            <span className={styles.dot} />
            <span className={styles.dot} />
            <span className={styles.mockTitle}>director · live</span>
          </div>
          <div className={styles.mockViewport}>
            <span className={styles.mockRec}>● REC</span>
            <span className={styles.mockGrade}>GRADE · TEAL / ORANGE</span>
            <span className={styles.mockCaption}>
              &ldquo;…and that&rsquo;s where the story turns.&rdquo;
            </span>
          </div>
        </div>
      </section>

      {/* ── Product: Audition ───────────────────────────────── */}
      <section className={`${styles.feature} ${styles.featureAudition}`}>
        <div className={styles.featurePanel} aria-hidden>
          <div className={styles.mockBar}>
            <span className={styles.dot} />
            <span className={styles.dot} />
            <span className={styles.dot} />
            <span className={styles.mockTitle}>audition · self-tape</span>
          </div>
          <div className={styles.mockScript}>
            <p className={styles.lineReader}>
              <span className={styles.who}>READER</span> Are you even listening
              to me?
            </p>
            <p className={styles.lineYou}>
              <span className={styles.who}>YOU</span> I heard every word.
            </p>
            <p className={styles.lineNote}>▸ delivery: grounded · a beat late</p>
          </div>
        </div>
        <div className={styles.featureCopy}>
          <div className={`${styles.featureTag} ${styles.featureTagAlt}`}>
            ACTOR · SELF-TAPE
          </div>
          <h2 className={styles.h2}>
            A scene partner who never breaks character.
          </h2>
          <p className={styles.featureBody}>
            A hands-free self-tape studio. Pick your sides and just act. A voiced
            AI reader hears when you finish your line, answers in character, and
            notes your delivery — then hands you a director&rsquo;s cut of the
            take.
          </p>
          <ul className={styles.bullets}>
            <li>Voiced AI reader that responds on cue, in character</li>
            <li>Fully hands-free — it knows when you&rsquo;ve finished a line</li>
            <li>Delivery notes on every read</li>
            <li>Records and composites a director&rsquo;s cut automatically</li>
          </ul>
          <Link href="/audition" className={styles.featureLink}>
            Step into the room →
          </Link>
        </div>
      </section>

      {/* ── How it works ────────────────────────────────────── */}
      <section className={styles.steps}>
        <h2 className={styles.sectionTitle}>Three steps to a finished take</h2>
        <div className={styles.stepGrid}>
          <div className={styles.step}>
            <span className={styles.stepNum}>01</span>
            <h3>Open a room</h3>
            <p>Grant camera and mic. That&rsquo;s the whole setup.</p>
          </div>
          <div className={styles.step}>
            <span className={styles.stepNum}>02</span>
            <h3>Play the scene</h3>
            <p>
              Direct a live shot, or run your sides against the AI scene partner.
            </p>
          </div>
          <div className={styles.step}>
            <span className={styles.stepNum}>03</span>
            <h3>Take the cut</h3>
            <p>Walk away with a graded, captioned, composited take.</p>
          </div>
        </div>
      </section>

      {/* ── Why Cut ─────────────────────────────────────────── */}
      <section className={styles.why}>
        <h2 className={styles.sectionTitle}>Why Cut feels different</h2>
        <div className={styles.whyGrid}>
          <div className={styles.whyCard}>
            <h3>Real-time, not render-time</h3>
            <p>
              Everything happens live in the browser at 30–60fps. No upload, no
              queue, no waiting for a render to finish.
            </p>
          </div>
          <div className={styles.whyCard}>
            <h3>Scale-to-zero backend</h3>
            <p>
              Perception and voice run serverless — instant when you need them,
              costing nothing when you don&rsquo;t.
            </p>
          </div>
          <div className={styles.whyCard}>
            <h3>Nothing to install</h3>
            <p>
              Just a browser, a camera, and a mic. No app, no plugin, no
              hardware beyond the machine you already own.
            </p>
          </div>
          <div className={styles.whyCard}>
            <h3>Built for solo creators</h3>
            <p>
              Auditions, content, practice — a full crew for one person, ready
              the moment you hit record.
            </p>
          </div>
        </div>
      </section>

      {/* ── Closing CTA ─────────────────────────────────────── */}
      <section className={styles.cta}>
        <div className={styles.glow} aria-hidden />
        <h2 className={styles.ctaTitle}>The set is ready when you are.</h2>
        <p className={styles.ctaSub}>
          Pick a room and start rolling. Both are live right now.
        </p>
        <div className={styles.heroCtas}>
          <Link href="/director" className={styles.btnPrimary}>
            Direct a shot →
          </Link>
          <Link href="/audition" className={styles.btnGhost}>
            Run an audition
          </Link>
        </div>
      </section>

      {/* ── Footer ──────────────────────────────────────────── */}
      <footer className={styles.foot}>
        <span className={styles.footBrand}>
          <span className={styles.clap}>🎬</span> Cut!
        </span>
        <span className="mono">
          Frontend on Next.js · perception &amp; reader on scale-to-zero Alibaba
          Function Compute
        </span>
      </footer>
    </main>
  );
}
