"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";

type OrbitItem = { label: string; href: string };

const ITEMS: OrbitItem[] = [
  { label: "Spreadsheet", href: "/spreadsheet" },
  { label: "Best Seller", href: "/sellers" },
  { label: "Tutorial", href: "/tutorials" },
  { label: "Coupon", href: "/coupons" },
  { label: "AI Quality Check", href: "/quality-check" },
];

const TAU = Math.PI * 2;
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

export default function HeroCarousel() {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const itemRefs = useRef<(HTMLDivElement | null)[]>([]);
  const rafRef = useRef<number | null>(null);
  const lastRef = useRef<number>(0);
  const angleRef = useRef<number>(0);

  const radiiRef = useRef({ A: 560, B: 240 });

  const BASE_SPEED = 0.00014;
  const speedRef = useRef<number>(BASE_SPEED);
  const targetSpeedRef = useRef<number>(BASE_SPEED);

  const [hovered, setHovered] = useState<number | null>(null);

  useEffect(() => {
    const updateRadii = () => {
      const w = window.innerWidth;
      const h = window.innerHeight;

      const A = Math.max(240, Math.min(560, w * 0.36));
      const B = Math.max(140, Math.min(240, h * 0.22));

      radiiRef.current = { A, B };
    };

    updateRadii();
    window.addEventListener("resize", updateRadii);
    return () => window.removeEventListener("resize", updateRadii);
  }, []);

  useEffect(() => {
    const MIN_SCALE = 0.94;
    const MAX_SCALE = 1.16;

    const MIN_OPACITY = 0.74;
    const MAX_OPACITY = 1.0;

    const MIN_BRIGHT = 0.9;
    const MAX_BRIGHT = 1.05;

    const START = -Math.PI / 2;

    const stop = () => {
      if (rafRef.current != null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };

    const animate = (t: number) => {
      if (!lastRef.current) lastRef.current = t;

      let dt = t - lastRef.current;
      lastRef.current = t;
      dt = Math.min(dt, 50);

      speedRef.current = lerp(speedRef.current, targetSpeedRef.current, 0.06);
      angleRef.current += speedRef.current * dt;

      const { A, B } = radiiRef.current;
      const n = ITEMS.length;

      for (let i = 0; i < n; i++) {
        const el = itemRefs.current[i];
        if (!el) continue;

        const a = angleRef.current + START + (i * TAU) / n;

        const x = A * Math.cos(a);
        const y = B * Math.sin(a);

        const depth = (Math.sin(a) + 1) / 2; // 0..1
        const s = lerp(MIN_SCALE, MAX_SCALE, depth);
        const o = lerp(MIN_OPACITY, MAX_OPACITY, depth);
        const br = lerp(MIN_BRIGHT, MAX_BRIGHT, depth);

        el.style.setProperty("--x", `${x}px`);
        el.style.setProperty("--y", `${y}px`);
        el.style.setProperty("--s", `${s}`);
        el.style.setProperty("--o", `${o}`);
        el.style.setProperty("--br", `${br}`);
        el.style.zIndex = String(Math.round(depth * 1000));
      }

      rafRef.current = requestAnimationFrame(animate);
    };

    const start = () => {
      if (rafRef.current != null) return;
      lastRef.current = 0;
      rafRef.current = requestAnimationFrame(animate);
    };

    // ✅ Rispetta prefers-reduced-motion
    const mq = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    const prefersReduced = () => Boolean(mq?.matches);

    const onReducedChange = () => {
      if (prefersReduced()) stop();
      else start();
    };

    try {
      mq?.addEventListener?.("change", onReducedChange);
    } catch {
      // Safari
      (mq as any)?.addListener?.(onReducedChange);
    }

    // ✅ Fermiamo l'animazione quando l'hero non è in viewport
    const io = new IntersectionObserver(
      (entries) => {
        const e = entries[0];
        if (!e) return;
        if (e.isIntersecting && !prefersReduced()) start();
        else stop();
      },
      { threshold: 0.15 }
    );

    if (rootRef.current) io.observe(rootRef.current);

    // start iniziale
    if (!prefersReduced()) start();

    return () => {
      stop();
      io.disconnect();
      try {
        mq?.removeEventListener?.("change", onReducedChange);
      } catch {
        (mq as any)?.removeListener?.(onReducedChange);
      }
    };
  }, []);

  const handleEnter = (idx: number) => {
    setHovered(idx);
    targetSpeedRef.current = 0;
  };

  const handleLeave = () => {
    setHovered(null);
    targetSpeedRef.current = BASE_SPEED;
  };

  return (
    <div
      ref={rootRef}
      className="relative w-full min-h-[100dvh] flex items-center justify-center overflow-hidden"
    >
      {/* CENTRO */}
      <div className="relative z-10 text-center px-6 pointer-events-none">
        <h1 className="hero-title">Cravatta</h1>
        <p className="hero-subtitle">Scopri cravattacinese</p>
      </div>

      {/* ORBITA (✅ z-20 e pointer events ok) */}
      <div className="hero-orbit-stage absolute inset-0 z-20">
        {ITEMS.map((it, i) => (
          <div
            key={it.href}
            ref={(el) => {
              itemRefs.current[i] = el;
            }}
            className="hero-orbit-item absolute left-1/2 top-1/2"
            data-hovered={hovered === i ? "true" : "false"}
            onMouseEnter={() => handleEnter(i)}
            onMouseLeave={handleLeave}
            onFocusCapture={() => handleEnter(i)}
            onBlurCapture={handleLeave}
          >
            <div className="hero-orbit-inner">
              <Link href={it.href} className="hero-pill">
                {it.label}
              </Link>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
