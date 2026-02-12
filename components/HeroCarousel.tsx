"use client";

import Link from "next/link";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { PointerEvent } from "react";

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
const clamp = (n: number, a: number, b: number) => Math.max(a, Math.min(b, n));

export default function HeroCarousel() {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const itemRefs = useRef<(HTMLDivElement | null)[]>([]);

  const rafRef = useRef<number | null>(null);
  const lastRef = useRef<number>(0);
  const angleRef = useRef<number>(0);

  const radiiRef = useRef({ A: 320, B: 180 });
  const pillSizeRef = useRef({ w: 160, h: 56 });
  const startAngleRef = useRef(-Math.PI / 2);

  const BASE_SPEED = 0.00014;
  const speedRef = useRef<number>(BASE_SPEED);
  const targetSpeedRef = useRef<number>(BASE_SPEED);

  const [hovered, setHovered] = useState<number | null>(null);
  const [ready, setReady] = useState(false);
  const [mode, setMode] = useState<"orbit" | "grid">("orbit");
  const [isNarrow, setIsNarrow] = useState(false);
  const [isPhone, setIsPhone] = useState(false);

  const MAX_PILL_SCALE = 1.18;

  const labelFor = (label: string) => {
    if (!isNarrow) return label;
    if (label === "AI Quality Check") return "AI QC";
    return label;
  };

  const stopRAF = () => {
    if (rafRef.current != null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
  };

  const measurePills = () => {
    const root = rootRef.current;
    if (!root) return;

    const pills = Array.from(root.querySelectorAll<HTMLElement>(".hero-pill"));
    if (!pills.length) return;

    let maxW = 0;
    let maxH = 0;
    for (const p of pills) {
      const r = p.getBoundingClientRect();
      maxW = Math.max(maxW, r.width);
      maxH = Math.max(maxH, r.height);
    }

    pillSizeRef.current = {
      w: Math.max(120, Math.min(320, maxW || 160)),
      h: Math.max(40, Math.min(120, maxH || 56)),
    };
  };

  const applyLayoutOnce = () => {
    const MIN_SCALE = 0.94;
    const MAX_SCALE = 1.16;
    const MIN_OPACITY = 0.74;
    const MAX_OPACITY = 1.0;
    const MIN_BRIGHT = 0.9;
    const MAX_BRIGHT = 1.05;

    const { A, B } = radiiRef.current;
    const START = startAngleRef.current;
    const n = ITEMS.length;

    for (let i = 0; i < n; i++) {
      const el = itemRefs.current[i];
      if (!el) continue;

      const a = angleRef.current + START + (i * TAU) / n;

      const x = A * Math.cos(a);
      const y = B * Math.sin(a);

      const depth = (Math.sin(a) + 1) / 2;
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
  };

  const recalcRadii = () => {
    const root = rootRef.current;
    const stage = stageRef.current;

    const r0 = stage?.getBoundingClientRect();
    const r1 = root?.getBoundingClientRect();

    const rect =
      r0 && r0.width > 50 && r0.height > 50
        ? r0
        : r1 && r1.width > 50 && r1.height > 50
        ? r1
        : null;

    const w = rect?.width ?? window.innerWidth;
    const h = rect?.height ?? window.innerHeight;

    const phone = w <= 520;
    const narrow = w <= 380;

    setIsPhone((p) => (p !== phone ? phone : p));
    setIsNarrow((prev) => (prev !== narrow ? narrow : prev));

    startAngleRef.current = -Math.PI / 2;

    const padX = phone ? 14 : 22;
    const padY = phone ? 18 : 28;

    const { w: pillW0, h: pillH0 } = pillSizeRef.current;
    const pillW = pillW0 * MAX_PILL_SCALE;
    const pillH = pillH0 * MAX_PILL_SCALE;

    const maxA = Math.max(0, w / 2 - pillW / 2 - padX);
    const maxB = Math.max(0, h / 2 - pillH / 2 - padY);

    // ✅ su phone: mai orbita
    const canOrbit = !phone && maxA >= 120 && maxB >= 140;

    setMode((prev) => {
      const next = canOrbit ? "orbit" : "grid";
      return prev !== next ? next : prev;
    });

    if (stage) {
      const cy = phone ? Math.round(Math.min(24, h * 0.05)) : 0;
      stage.style.setProperty("--cy", `${cy}px`);
    }

    if (!canOrbit) {
      setReady(true);
      return;
    }

    const targetA = w * 0.4;
    const targetB = h * 0.24;

    const minA = 240;
    const minB = 160;

    const loA = Math.min(minA, maxA);
    const loB = Math.min(minB, maxB);

    const A = clamp(targetA, loA, maxA);
    const B = clamp(targetB, loB, maxB);

    radiiRef.current = { A, B };

    applyLayoutOnce();
    setReady(true);
  };

  useLayoutEffect(() => {
    measurePills();
    recalcRadii();

    // @ts-ignore
    const fonts = (document as any).fonts;
    if (fonts?.ready) {
      fonts.ready.then(() => {
        measurePills();
        recalcRadii();
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    measurePills();
    recalcRadii();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isNarrow]);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    const ro = new ResizeObserver(() => {
      measurePills();
      recalcRadii();
    });
    ro.observe(root);

    const vv = window.visualViewport;
    const onVV = () => {
      measurePills();
      recalcRadii();
    };
    vv?.addEventListener("resize", onVV);
    vv?.addEventListener("scroll", onVV);
    window.addEventListener("orientationchange", onVV);

    return () => {
      ro.disconnect();
      vv?.removeEventListener("resize", onVV);
      vv?.removeEventListener("scroll", onVV);
      window.removeEventListener("orientationchange", onVV);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const MIN_SCALE = 0.94;
    const MAX_SCALE = 1.16;
    const MIN_OPACITY = 0.74;
    const MAX_OPACITY = 1.0;
    const MIN_BRIGHT = 0.9;
    const MAX_BRIGHT = 1.05;

    const animate = (t: number) => {
      if (!lastRef.current) lastRef.current = t;

      let dt = t - lastRef.current;
      lastRef.current = t;
      dt = Math.min(dt, 50);

      speedRef.current = lerp(speedRef.current, targetSpeedRef.current, 0.06);
      angleRef.current += speedRef.current * dt;

      const { A, B } = radiiRef.current;
      const START = startAngleRef.current;
      const n = ITEMS.length;

      for (let i = 0; i < n; i++) {
        const el = itemRefs.current[i];
        if (!el) continue;

        const a = angleRef.current + START + (i * TAU) / n;

        const x = A * Math.cos(a);
        const y = B * Math.sin(a);

        const depth = (Math.sin(a) + 1) / 2;
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
      if (mode !== "orbit") return;
      if (isPhone) return;
      if (rafRef.current != null) return;
      lastRef.current = 0;
      applyLayoutOnce();
      rafRef.current = requestAnimationFrame(animate);
    };

    const mq = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    const prefersReduced = () => Boolean(mq?.matches);

    const onReducedChange = () => {
      if (prefersReduced()) stopRAF();
      else start();
    };

    try {
      mq?.addEventListener?.("change", onReducedChange);
    } catch {
      (mq as any)?.addListener?.(onReducedChange);
    }

    const io = new IntersectionObserver(
      (entries) => {
        const e = entries[0];
        if (!e) return;
        if (e.isIntersecting && !prefersReduced()) start();
        else stopRAF();
      },
      { threshold: 0.15 }
    );

    if (rootRef.current) io.observe(rootRef.current);

    if (mode !== "orbit" || isPhone) {
      stopRAF();
      setHovered(null);
      speedRef.current = BASE_SPEED;
      targetSpeedRef.current = BASE_SPEED;
    } else if (!prefersReduced()) {
      start();
    }

    return () => {
      stopRAF();
      io.disconnect();
      try {
        mq?.removeEventListener?.("change", onReducedChange);
      } catch {
        (mq as any)?.removeListener?.(onReducedChange);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, isPhone]);

  const handlePointerEnter = (idx: number, e: PointerEvent<HTMLDivElement>) => {
    if (e.pointerType !== "mouse") return;
    setHovered(idx);
    targetSpeedRef.current = 0;
  };

  const handlePointerLeave = (e: PointerEvent<HTMLDivElement>) => {
    if (e.pointerType !== "mouse") return;
    setHovered(null);
    targetSpeedRef.current = BASE_SPEED;
  };

  const handlePointerDown = () => {
    targetSpeedRef.current = 0;
  };

  const handlePointerUp = () => {
    targetSpeedRef.current = BASE_SPEED;
    setHovered(null);
  };

  const handleFocus = (idx: number) => {
    setHovered(idx);
    targetSpeedRef.current = 0;
  };

  const handleBlur = () => {
    setHovered(null);
    targetSpeedRef.current = BASE_SPEED;
  };

  const scrollToSections = () => {
    const el = document.getElementById("spreadsheet");
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "start" });
      return;
    }
    // fallback
    window.scrollTo({ top: Math.max(0, window.innerHeight * 0.9), behavior: "smooth" });
  };

  return (
<div
  ref={rootRef}
  className="relative w-full min-h-[100svh] min-h-[100dvh] max-[520px]:min-h-[74svh] max-[520px]:min-h-[82dvh] overflow-hidden grid place-items-center"
>
      {/* background polish */}
      <div aria-hidden className="absolute inset-0 hero-vignette" />
      <div aria-hidden className="absolute inset-0 hero-spotlight" />
      <div aria-hidden className="absolute inset-0 hero-noise" />

      {/* wrapper centrale */}
      <div className="relative z-30 w-full px-6 flex flex-col items-center text-center">
        <div className="pointer-events-none">
          <h1 className="hero-title">Cravatta</h1>
          <p className="hero-subtitle">Scopri cravattacinese</p>
        </div>

        {/* ✅ MOBILE: un solo bottone che scrolla a Spreadsheet */}
        {isPhone ? (
          <div className="hero-scrollCtaWrap pointer-events-auto">
            <button type="button" className="hero-scrollBtn" onClick={scrollToSections} aria-label="Scopri le sezioni">
              SCOPRI LE SEZIONI
              <svg className="hero-scrollIco" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path d="M6 9l6 6 6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          </div>
        ) : null}

        {/* ✅ GRID fallback (solo non-phone, casi estremi) */}
        {!isPhone && mode === "grid" ? (
          <div className="mt-8 w-full max-w-[520px] pointer-events-auto">
            <div className="grid grid-cols-2 max-[360px]:grid-cols-1 gap-3 place-items-center">
              {ITEMS.map((it) => (
                <Link key={it.href} href={it.href} className="hero-pill" aria-label={it.label}>
                  {labelFor(it.label)}
                </Link>
              ))}
            </div>
          </div>
        ) : null}
      </div>

      {/* ORBIT (solo desktop/tablet) */}
      <div
        ref={stageRef}
        className="hero-orbit-stage"
        style={{
          opacity: ready ? 1 : 0,
          transition: "opacity 180ms ease",
          display: mode === "orbit" && !isPhone ? "block" : "none",
        }}
      >
        {ITEMS.map((it, i) => (
          <div
            key={it.href}
            ref={(el) => {
              itemRefs.current[i] = el;
            }}
            className="hero-orbit-item"
            data-hovered={hovered === i ? "true" : "false"}
            onPointerEnter={(e) => handlePointerEnter(i, e)}
            onPointerLeave={(e) => handlePointerLeave(e)}
            onPointerDown={handlePointerDown}
            onPointerUp={handlePointerUp}
            onPointerCancel={handlePointerUp}
            onFocusCapture={() => handleFocus(i)}
            onBlurCapture={handleBlur}
          >
            <div className="hero-orbit-inner">
              <Link href={it.href} className="hero-pill" aria-label={it.label}>
                {labelFor(it.label)}
              </Link>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
