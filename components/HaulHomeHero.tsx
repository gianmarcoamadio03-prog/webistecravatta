import Link from "next/link";
import styles from "./HaulHomeHero.module.css";

/** Homepage decoration only: actual hauls remain available at /hauls. */
export default function HaulHomeHero() {
  return (
    <section id="hauls" className={styles.section} aria-labelledby="haul-heading">
      <div className={styles.glow} aria-hidden="true" />
      
      
      <div className={styles.content}>
        <p className={styles.eyebrow}>COLLECTION</p>
        <h2 id="haul-heading" className={styles.title}>Haul</h2>
        <Link href="/hauls" className={styles.cta}>Scopri gli Haul <span aria-hidden="true">→</span></Link>
      </div>
    </section>
  );
}
