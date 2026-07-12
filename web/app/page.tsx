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
          <span className={styles.navBadge}>AI Showrunner · Qwen Cloud</span>
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
        <span className={styles.eyebrow}>🎬 AI SHOWRUNNER · POWERED BY QWEN</span>
        <h1 className={styles.h1}>
          You bring the performance.
          <br />
          <span className={styles.accentText}>Qwen brings the crew.</span>
        </h1>
        <p className={styles.lede}>
          Cut is an AI showrunner that turns one webcam into a full film crew.
          Four Qwen models — an eye, an ear, a set builder, and a voice — run a
          live loop that directs your shot, builds the world around you, and
          reads scenes back to you in character.
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
            Qwen3-VL · Qwen-Image · Qwen3-ASR · Qwen3-TTS — served on Alibaba
            Cloud Function Compute
          </span>
        </p>
      </header>

      {/* ── Powered by Qwen — the stack, up front ───────────── */}
      <section className={styles.stack} aria-label="The Qwen models behind Cut">
        <div className={styles.stackHead}>
          <span className={styles.stackKicker}>THE CREW IS FOUR QWEN MODELS</span>
          <p className={styles.stackLede}>
            Every role on set is a Qwen model, orchestrated in one real-time
            loop — no pre-render, no queue.
          </p>
        </div>
        <div className={styles.stackGrid}>
          <div className={styles.stackCard}>
            <span className={styles.stackModel}>qwen3-vl-flash</span>
            <h3>The director&rsquo;s eye</h3>
            <p>
              Reads every frame of your shot and calls the grade, the mood, and
              the world it wants behind you.
            </p>
          </div>
          <div className={styles.stackCard}>
            <span className={styles.stackModel}>qwen-image</span>
            <h3>The set builder</h3>
            <p>
              Generates the cinematic environment the director calls for and
              drops you inside it.
            </p>
          </div>
          <div className={styles.stackCard}>
            <span className={styles.stackModel}>qwen3-asr-flash</span>
            <h3>The ear on set</h3>
            <p>
              Hears the room live — captions the scene and knows the exact
              moment you finish a line.
            </p>
          </div>
          <div className={styles.stackCard}>
            <span className={styles.stackModel}>qwen3-tts-flash</span>
            <h3>The scene partner</h3>
            <p>
              Voices your AI reader — answers on cue, in character, so you can
              run a two-hander alone.
            </p>
          </div>
        </div>
      </section>

      {/* ── Pitch ───────────────────────────────────────────── */}
      <section className={styles.pitch}>
        <p className={styles.pitchLead}>
          Making a scene used to take a room full of people — a director, a
          reader, a colorist, a set.
        </p>
        <p className={styles.pitchPunch}>
          Now it&rsquo;s just you, a webcam, and Qwen. The rest of the crew is
          an agent.
        </p>
      </section>

      {/* ── Product: Director ───────────────────────────────── */}
      <section className={`${styles.feature} ${styles.featureDirector}`}>
        <div className={styles.featureCopy}>
          <div className={styles.featureTag}>DIRECTOR · LIVE</div>
          <h2 className={styles.h2}>An AI director, watching every frame.</h2>
          <p className={styles.featureBody}>
            Your webcam becomes a directed shot. Qwen3-VL watches the scene in
            real time, calls the grade, drops you into a Qwen-Image world, and
            captions the room as the action unfolds.
          </p>
          <ul className={styles.bullets}>
            <li>Cinematic color grades, called shot by shot by Qwen3-VL</li>
            <li>Qwen-Image backgrounds that replace the room behind you</li>
            <li>Live captions and scene notes from Qwen3-ASR as you play</li>
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
            <span className={styles.mockModel}>qwen3-vl-flash</span>
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
            <span className={styles.mockModel}>qwen3-tts-flash</span>
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
            A hands-free self-tape studio. Pick your sides and just act. A
            Qwen3-TTS reader hears when you finish your line via Qwen3-ASR,
            answers in character, and notes your delivery — then hands you a
            director&rsquo;s cut of the take.
          </p>
          <ul className={styles.bullets}>
            <li>Qwen3-TTS reader that responds on cue, in character</li>
            <li>Fully hands-free — Qwen3-ASR knows when you&rsquo;ve finished</li>
            <li>Delivery notes on every read</li>
            <li>Records and composites a director&rsquo;s cut automatically</li>
          </ul>
          <Link href="/audition" className={styles.featureLink}>
            Step into the room →
          </Link>
        </div>
      </section>

      {/* ── Under the hood ──────────────────────────────────── */}
      <section className={styles.arch}>
        <h2 className={styles.sectionTitle}>One live loop, zero servers idle</h2>
        <p className={styles.archLede}>
          The browser holds the real-time pipeline; the heavy reasoning runs on
          Alibaba Cloud Function Compute, scaling to zero between takes. Every
          arrow is a Qwen call.
        </p>
        <div className={styles.archFlow}>
          <div className={styles.archNode}>
            <span className={styles.archStep}>CAPTURE</span>
            <p>Camera + mic, in-browser at 30–60fps</p>
          </div>
          <span className={styles.archArrow} aria-hidden>
            →
          </span>
          <div className={styles.archNode}>
            <span className={styles.archStep}>REASON</span>
            <p>
              Qwen3-VL reads the frame · Qwen3-ASR hears the line — on Function
              Compute
            </p>
          </div>
          <span className={styles.archArrow} aria-hidden>
            →
          </span>
          <div className={styles.archNode}>
            <span className={styles.archStep}>CREATE</span>
            <p>Qwen-Image builds the world · Qwen3-TTS voices the partner</p>
          </div>
          <span className={styles.archArrow} aria-hidden>
            →
          </span>
          <div className={styles.archNode}>
            <span className={styles.archStep}>CUT</span>
            <p>Graded, captioned, composited take — live in the tab</p>
          </div>
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

      {/* ── Why Cut — mapped to what the hackathon rewards ───── */}
      <section className={styles.why}>
        <h2 className={styles.sectionTitle}>Why Cut wins the frame</h2>
        <div className={styles.whyGrid}>
          <div className={styles.whyCard}>
            <span className={styles.whyTag}>AI SHOWRUNNER</span>
            <h3>Script to final cut, end to end</h3>
            <p>
              One agent takes a scene from sides to a graded, captioned,
              composited take — the full showrunner loop the track is built for.
            </p>
          </div>
          <div className={styles.whyCard}>
            <span className={styles.whyTag}>TECHNICAL DEPTH</span>
            <h3>Four Qwen models, one real-time loop</h3>
            <p>
              VL perception, image generation, ASR, and TTS orchestrated live in
              the browser — not a single-prompt demo but a working pipeline.
            </p>
          </div>
          <div className={styles.whyCard}>
            <span className={styles.whyTag}>ALIBABA CLOUD</span>
            <h3>Scale-to-zero on Function Compute</h3>
            <p>
              Perception and voice run serverless on Alibaba Cloud — instant
              when you roll, costing nothing between takes.
            </p>
          </div>
          <div className={styles.whyCard}>
            <span className={styles.whyTag}>IMPACT</span>
            <h3>A film crew for one creator</h3>
            <p>
              Auditions, content, practice — Cut hands a solo creator the whole
              crew, ready the moment they hit record.
            </p>
          </div>
        </div>
      </section>

      {/* ── Closing CTA ─────────────────────────────────────── */}
      <section className={styles.cta}>
        <div className={styles.glow} aria-hidden />
        <h2 className={styles.ctaTitle}>The set is ready when you are.</h2>
        <p className={styles.ctaSub}>
          Pick a room and start rolling. Both are live right now, powered by
          Qwen.
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
          Next.js frontend · four Qwen models on scale-to-zero Alibaba Cloud
          Function Compute · open source
        </span>
      </footer>
    </main>
  );
}
