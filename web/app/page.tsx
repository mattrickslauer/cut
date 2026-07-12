import Link from "next/link";
import styles from "./home.module.css";

export default function Home() {
  return (
    <main className={styles.wrap}>
      <header className={styles.hero}>
        <div className={styles.brand}>
          <span className={styles.clap}>🎬</span>
          <h1>
            Cut!<span className={styles.sub}>the AI film studio</span>
          </h1>
        </div>
        <p className={styles.tagline}>
          Two rooms, one studio. Direct a live self-shot scene with an AI eye,
          or run an audition self-tape with an AI scene partner.
        </p>
      </header>

      <section className={styles.grid}>
        <Link href="/director" className={styles.card}>
          <div className={styles.cardTag}>DIRECTOR</div>
          <h2>Director Control Panel</h2>
          <p>
            Your webcam becomes a directed shot. An AI director watches the
            scene, calls the look, swaps in a generated world, and captions the
            room in real time.
          </p>
          <span className={styles.enter}>Enter the control room →</span>
        </Link>

        <Link href="/audition" className={styles.card}>
          <div className={`${styles.cardTag} ${styles.cardTagAlt}`}>ACTOR</div>
          <h2>Audition Room</h2>
          <p>
            A hands-free self-tape studio. Pick your sides and just act — a
            voiced AI reader hears when you finish, answers in character, and
            notes your delivery. Records a director&rsquo;s cut.
          </p>
          <span className={styles.enter}>Step into the room →</span>
        </Link>
      </section>

      <footer className={styles.foot}>
        <span className="mono">
          Frontend on Next.js · perception &amp; reader on scale-to-zero Alibaba
          Function Compute
        </span>
      </footer>
    </main>
  );
}
