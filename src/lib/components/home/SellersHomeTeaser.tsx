"use client";

import Link from "next/link";
import { useEffect, useId, useRef, useState } from "react";

/** ✅ esportato così in app/page.tsx puoi fare: import type { Seller } ... */
export type Seller = {
  name: string;
  verified?: boolean;
  specialties?: string[];
  previewImages?: string[];
  whatsapp?: string;
  wa?: string;
  whatsappUrl?: string;
  contact?: string;
  [key: string]: any;
};

type Props = { sellers?: Seller[] };

export default function SellersHomeTeaser(_props: Props) {
  const sectionRef = useRef<HTMLElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);

  const centerRef = useRef<HTMLDivElement | null>(null);
  const leftRef = useRef<HTMLDivElement | null>(null);
  const rightRef = useRef<HTMLDivElement | null>(null);

  const raf = useRef<number | null>(null);

  // scroll loop
  const target = useRef(0); // 0..1
  const current = useRef(0); // smoothed 0..1

  // parallax (normalized -1..1)
  const pTargetX = useRef(0);
  const pTargetY = useRef(0);
  const pX = useRef(0);
  const pY = useRef(0);

  const [reduceMotion, setReduceMotion] = useState(false);
  const [allowParallax, setAllowParallax] = useState(false);

  useEffect(() => {
    const mq = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    const update = () => setReduceMotion(!!mq?.matches);
    update();
    mq?.addEventListener?.("change", update);
    return () => mq?.removeEventListener?.("change", update);
  }, []);

  useEffect(() => {
    // parallax solo se: hover + pointer fine (mouse/trackpad)
    const mq = window.matchMedia?.("(hover: hover) and (pointer: fine)");
    const update = () => setAllowParallax(!!mq?.matches);
    update();
    mq?.addEventListener?.("change", update);
    return () => mq?.removeEventListener?.("change", update);
  }, []);

  useEffect(() => {
    if (reduceMotion) {
      // stato finale statico
      pTargetX.current = 0;
      pTargetY.current = 0;
      pX.current = 0;
      pY.current = 0;
      apply(1, 0, 0);
      return;
    }

    const onScroll = () => schedule();
    const onResize = () => schedule();

    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onResize);

    // parallax listeners (solo se supportato)
    const stage = stageRef.current;

    const onMove = (e: PointerEvent) => {
      if (!allowParallax) return;
      const el = stageRef.current;
      if (!el) return;

      const r = el.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;

      // normalized -1..1 con clamp morbido
      const nx = clamp((e.clientX - cx) / (r.width / 2), -1, 1);
      const ny = clamp((e.clientY - cy) / (r.height / 2), -1, 1);

      pTargetX.current = nx;
      pTargetY.current = ny;
      schedule();
    };

    const onLeave = () => {
      pTargetX.current = 0;
      pTargetY.current = 0;
      schedule();
    };

    if (stage && allowParallax) {
      stage.addEventListener("pointermove", onMove, { passive: true });
      stage.addEventListener("pointerleave", onLeave, { passive: true });
    }

    // first paint
    schedule();

    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onResize);

      if (stage && allowParallax) {
        stage.removeEventListener("pointermove", onMove as any);
        stage.removeEventListener("pointerleave", onLeave as any);
      }

      if (raf.current) cancelAnimationFrame(raf.current);
      raf.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reduceMotion, allowParallax]);

  function schedule() {
    if (raf.current != null) return;
    raf.current = requestAnimationFrame(tick);
  }

  function tick() {
    raf.current = null;

    const el = sectionRef.current;
    if (!el) return;

    const rect = el.getBoundingClientRect();
    const vh = window.innerHeight || 1;

    // progress 0..1 mentre la sezione attraversa il viewport
    const raw = clamp((vh - rect.top) / (rect.height + vh), 0, 1);

    // loop triangolare: 0->1->0
    const wave = 1 - Math.abs(2 * raw - 1);

    // easing apple-ish + smoothing
    const eased = easeInOutQuint(wave);
    target.current = eased;
    current.current = lerp(current.current, target.current, 0.14);

    // parallax smoothing (micro)
    pX.current = lerp(pX.current, pTargetX.current, 0.10);
    pY.current = lerp(pY.current, pTargetY.current, 0.10);

    apply(current.current, pX.current, pY.current);

    const needsMore =
      Math.abs(current.current - target.current) > 0.001 ||
      Math.abs(pX.current - pTargetX.current) > 0.001 ||
      Math.abs(pY.current - pTargetY.current) > 0.001;

    if (needsMore) raf.current = requestAnimationFrame(tick);
  }

  function apply(t: number, nx: number, ny: number) {
    const c = centerRef.current;
    const l = leftRef.current;
    const r = rightRef.current;
    if (!c || !l || !r) return;

    // ---- scroll-driven base
    const cY = lerp(18, 0, t);
    const cS = lerp(0.965, 1.0, t);
    const cO = lerp(0.0, 1.0, t);

    const x = lerp(0, 190, t);
    const y = lerp(34, 14, t);
    const s = lerp(0.90, 0.96, t);
    const o = lerp(0.0, 0.92, t);

    // micro “breathing”
    const breathe = 1 + Math.sin(t * Math.PI) * 0.01;

    // ---- parallax micro (in px / deg)
    const pxC = nx * 12;
    const pyC = ny * 8;
    const rotC = nx * -1.2;

    const pxS = nx * 9;
    const pyS = ny * 6;
    const rotS = nx * 1.0;

    c.style.opacity = String(cO);
    c.style.transform = `translate3d(${pxC}px, ${cY + pyC}px, 0) rotate(${rotC}deg) scale(${cS * breathe})`;

    l.style.opacity = String(o);
    l.style.transform = `translate3d(${-x + pxS}px, ${y + pyS}px, 0) rotate(${-rotS}deg) scale(${s})`;

    r.style.opacity = String(o);
    r.style.transform = `translate3d(${x + pxS}px, ${y + pyS}px, 0) rotate(${rotS}deg) scale(${s})`;
  }

  return (
    <section
      ref={sectionRef}
      className="cc-section relative"
      id="sellers"
    >
      {/* glow leggero dietro */}
      <div aria-hidden className="pointer-events-none absolute inset-0">
        <div className="absolute inset-0 bg-[radial-gradient(60%_50%_at_50%_35%,rgba(255,255,255,0.09),transparent_60%)]" />
        <div className="absolute inset-0 bg-[radial-gradient(50%_40%_at_50%_75%,rgba(255,255,255,0.05),transparent_55%)]" />
      </div>

      <div className="relative mx-auto w-full max-w-6xl px-4 md:px-8">
        {/* header */}
        <div className="text-center">
          <div className="text-[11px] tracking-[0.35em] text-white/45">
            BEST SELLERS
          </div>

          <h2 className="mt-2 text-4xl font-semibold tracking-tight text-white md:text-5xl">
            Sellers
          </h2>

          <p className="mx-auto mt-2 max-w-xl text-sm text-white/55">
            Animazione “loop” legata allo scroll, con micro-parallax premium.
          </p>

          <div className="mt-6 flex items-center justify-center gap-3">
            <Link
              href="/sellers"
              className="inline-flex items-center gap-2 rounded-full border border-white/12 bg-white/5 px-5 py-2.5 text-sm text-white/85 backdrop-blur hover:bg-white/10"
            >
              Entra nella sezione <span className="text-white/60">→</span>
            </Link>
          </div>
        </div>

        {/* stage libero (NO box) */}
        <div className="relative mt-14 flex items-center justify-center">
          <div ref={stageRef} className="relative h-[260px] w-full max-w-[700px]">
            {/* spotlight */}
            <div
              aria-hidden
              className="pointer-events-none absolute inset-0"
              style={{
                background:
                  "radial-gradient(closest-side at 50% 55%, rgba(255,255,255,0.06), transparent 65%)",
              }}
            />

            {/* icons */}
            <div className="absolute inset-0 flex items-center justify-center">
              <div
                ref={leftRef}
                className="absolute will-change-transform"
                style={{
                  opacity: 0,
                  transform: "translate3d(0,34px,0) scale(0.9)",
                }}
              >
                <SilhouetteApple size={148} variant="side" />
              </div>

              <div
                ref={centerRef}
                className="absolute z-10 will-change-transform"
                style={{
                  opacity: 0,
                  transform: "translate3d(0,18px,0) scale(0.965)",
                }}
              >
                <SilhouetteApple size={182} variant="main" />
              </div>

              <div
                ref={rightRef}
                className="absolute will-change-transform"
                style={{
                  opacity: 0,
                  transform: "translate3d(0,34px,0) scale(0.9)",
                }}
              >
                <SilhouetteApple size={148} variant="side" />
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

/* ---------- premium “apple-ish” silhouette ---------- */

function SilhouetteApple({
  size,
  variant,
}: {
  size: number;
  variant: "main" | "side";
}) {
  const uid = useId();
  const g1 = `${uid}-g1-${variant}`;
  const g2 = `${uid}-g2-${variant}`;
  const hl = `${uid}-hl-${variant}`;

  const shadow =
    variant === "main"
      ? "drop-shadow-[0_18px_40px_rgba(0,0,0,0.60)]"
      : "drop-shadow-[0_14px_30px_rgba(0,0,0,0.52)]";

  return (
    <div
      className={["relative grid place-items-center", shadow].join(" ")}
      style={{ width: size, height: size }}
    >
      <div
        aria-hidden
        className="absolute inset-0 rounded-full"
        style={{
          background:
            variant === "main"
              ? "radial-gradient(closest-side, rgba(255,255,255,0.18), transparent 70%)"
              : "radial-gradient(closest-side, rgba(255,255,255,0.12), transparent 75%)",
          filter: "blur(12px)",
          transform: "scale(0.92)",
        }}
      />

      <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
        <defs>
          <linearGradient id={g1} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="rgba(255,255,255,0.72)" />
            <stop offset="42%" stopColor="rgba(255,255,255,0.38)" />
            <stop offset="100%" stopColor="rgba(255,255,255,0.18)" />
          </linearGradient>

          <linearGradient id={g2} x1="0" y1="1" x2="0" y2="0">
            <stop offset="0%" stopColor="rgba(0,0,0,0.25)" />
            <stop offset="60%" stopColor="rgba(0,0,0,0.00)" />
          </linearGradient>

          <linearGradient id={hl} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="rgba(255,255,255,0.55)" />
            <stop offset="55%" stopColor="rgba(255,255,255,0.00)" />
          </linearGradient>
        </defs>

        <path
          d="M12 12c2.761 0 5-2.239 5-5S14.761 2 12 2 7 4.239 7 7s2.239 5 5 5Zm0 2c-4.418 0-8 2.239-8 5v1h16v-1c0-2.761-3.582-5-8-5Z"
          fill={`url(#${g1})`}
        />
        <path
          d="M12 12c2.761 0 5-2.239 5-5S14.761 2 12 2 7 4.239 7 7s2.239 5 5 5Zm0 2c-4.418 0-8 2.239-8 5v1h16v-1c0-2.761-3.582-5-8-5Z"
          fill={`url(#${g2})`}
          opacity="0.45"
        />
        <path
          d="M12 2c2.761 0 5 2.239 5 5 0 1.2-.43 2.3-1.15 3.15-1.05.2-2.35.33-3.85.33-1.52 0-2.84-.13-3.9-.34C7.4 9.3 7 8.2 7 7c0-2.761 2.239-5 5-5Z"
          fill={`url(#${hl})`}
          opacity="0.55"
        />
        <path
          d="M12 12c2.761 0 5-2.239 5-5S14.761 2 12 2 7 4.239 7 7s2.239 5 5 5Zm0 2c-4.418 0-8 2.239-8 5v1h16v-1c0-2.761-3.582-5-8-5Z"
          fill="none"
          stroke="rgba(255,255,255,0.14)"
        />
      </svg>
    </div>
  );
}

/* ---------- utils ---------- */

function clamp(n: number, a: number, b: number) {
  return Math.max(a, Math.min(b, n));
}

function lerp(a: number, b: number, t: number) {
  return a + (b - a) * t;
}

function easeInOutQuint(t: number) {
  return t < 0.5 ? 16 * t ** 5 : 1 - Math.pow(-2 * t + 2, 5) / 2;
}
