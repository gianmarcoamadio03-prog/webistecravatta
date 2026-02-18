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

const clamp = (n: number, a: number, b: number) => Math.max(a, Math.min(b, n));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

function easeInOutQuint(t: number) {
  return t < 0.5 ? 16 * t ** 5 : 1 - Math.pow(-2 * t + 2, 5) / 2;
}

function resolveScroller(): Window | HTMLElement {
  // se .cc-home è davvero scrollabile, usalo (spesso nei layout “app-like”)
  const home = document.querySelector<HTMLElement>(".cc-home");
  if (home) {
    const s = window.getComputedStyle(home);
    const oy = s.overflowY;
    const canScroll = home.scrollHeight > home.clientHeight + 2;
    if (canScroll && (oy === "auto" || oy === "scroll" || oy === "overlay")) return home;
  }
  return window;
}

export default function SellersHomeTeaser(_props: Props) {
  const sectionRef = useRef<HTMLElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);

  const stageW = useRef(700);

  const centerRef = useRef<HTMLDivElement | null>(null);
  const leftRef = useRef<HTMLDivElement | null>(null);
  const rightRef = useRef<HTMLDivElement | null>(null);

  const raf = useRef<number | null>(null);
  const running = useRef(false);

  // scroll loop
  const target = useRef(0);
  const current = useRef(0);

  // parallax (normalized -1..1)
  const pTargetX = useRef(0);
  const pTargetY = useRef(0);
  const pX = useRef(0);
  const pY = useRef(0);

  const touching = useRef(false);
  const coarseRef = useRef(false);
  const phoneRef = useRef(false);

  const [isPhone, setIsPhone] = useState(false);

  const [reduceMotion, setReduceMotion] = useState(false);
  const [allowMouseParallax, setAllowMouseParallax] = useState(false);
  const [allowTouchParallax, setAllowTouchParallax] = useState(false);

  useEffect(() => {
    const mq = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    const update = () => setReduceMotion(!!mq?.matches);
    update();
    mq?.addEventListener?.("change", update);
    return () => mq?.removeEventListener?.("change", update);
  }, []);

  useEffect(() => {
    const mq = window.matchMedia?.("(max-width: 640px)");
    const update = () => {
      const v = !!mq?.matches;
      setIsPhone(v);
      phoneRef.current = v;
    };
    update();
    mq?.addEventListener?.("change", update);
    return () => mq?.removeEventListener?.("change", update);
  }, []);

  useEffect(() => {
    const mqMouse = window.matchMedia?.("(hover: hover) and (pointer: fine)");
    const updateMouse = () => setAllowMouseParallax(!!mqMouse?.matches);
    updateMouse();
    mqMouse?.addEventListener?.("change", updateMouse);

    const mqTouch = window.matchMedia?.("(pointer: coarse)");
    const updateTouch = () => {
      const v = !!mqTouch?.matches;
      setAllowTouchParallax(v);
      coarseRef.current = v;
    };
    updateTouch();
    mqTouch?.addEventListener?.("change", updateTouch);

    return () => {
      mqMouse?.removeEventListener?.("change", updateMouse);
      mqTouch?.removeEventListener?.("change", updateTouch);
    };
  }, []);

  function startLoop() {
    if (running.current) return;
    running.current = true;
    if (raf.current) cancelAnimationFrame(raf.current);
    raf.current = requestAnimationFrame(tick);
  }

  function stopLoop() {
    running.current = false;
    if (raf.current) cancelAnimationFrame(raf.current);
    raf.current = null;
  }

  useEffect(() => {
    const section = sectionRef.current;
    if (!section) return;

    if (reduceMotion) {
      stopLoop();
      touching.current = false;
      pTargetX.current = 0;
      pTargetY.current = 0;
      pX.current = 0;
      pY.current = 0;
      current.current = 1;
      target.current = 1;
      apply(1, 0, 0);
      return;
    }

    const scroller = resolveScroller();
    const stage = stageRef.current;

    // ✅ IntersectionObserver: accende il loop quando la sezione è a schermo
    const io = new IntersectionObserver(
      (entries) => {
        const visible = entries.some((e) => e.isIntersecting);
        if (visible) startLoop();
        else stopLoop();
      },
      { root: scroller === window ? null : (scroller as Element), threshold: 0 }
    );
    io.observe(section);

    const onResize = () => {
      // aggiorna subito senza aspettare scroll “pigri”
      if (!running.current) startLoop();
    };

    window.addEventListener("resize", onResize);
    window.visualViewport?.addEventListener("resize", onResize);
    window.visualViewport?.addEventListener("scroll", onResize);

    const setParallaxFromClient = (clientX: number, clientY: number) => {
      const el = stageRef.current;
      if (!el) return;

      const r = el.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;

      const nx = clamp((clientX - cx) / (r.width / 2), -1, 1);
      const ny = clamp((clientY - cy) / (r.height / 2), -1, 1);

      pTargetX.current = nx;
      pTargetY.current = ny;
      startLoop();
    };

    const onPointerDown = (e: PointerEvent) => {
      if (!allowTouchParallax) return;
      if (e.pointerType !== "touch") return;
      touching.current = true;
      try {
        stageRef.current?.setPointerCapture?.(e.pointerId);
      } catch {}
      setParallaxFromClient(e.clientX, e.clientY);
    };

    const onPointerMove = (e: PointerEvent) => {
      if (e.pointerType === "mouse") {
        if (!allowMouseParallax) return;
        setParallaxFromClient(e.clientX, e.clientY);
        return;
      }

      if (e.pointerType === "touch") {
        if (!allowTouchParallax) return;
        if (!touching.current) return;
        setParallaxFromClient(e.clientX, e.clientY);
      }
    };

    const onPointerUpOrCancel = (e: PointerEvent) => {
      if (e.pointerType !== "touch") return;
      touching.current = false;
      pTargetX.current = 0;
      pTargetY.current = 0;
      startLoop();
    };

    const onPointerLeave = () => {
      if (!allowMouseParallax) return;
      pTargetX.current = 0;
      pTargetY.current = 0;
      startLoop();
    };

    if (stage) {
      stage.addEventListener("pointerdown", onPointerDown, { passive: true });
      stage.addEventListener("pointermove", onPointerMove, { passive: true });
      stage.addEventListener("pointerup", onPointerUpOrCancel, { passive: true });
      stage.addEventListener("pointercancel", onPointerUpOrCancel, { passive: true });
      stage.addEventListener("pointerleave", onPointerLeave as any, { passive: true } as any);
    }

    // first paint
    startLoop();

    return () => {
      io.disconnect();

      window.removeEventListener("resize", onResize);
      window.visualViewport?.removeEventListener("resize", onResize);
      window.visualViewport?.removeEventListener("scroll", onResize);

      if (stage) {
        stage.removeEventListener("pointerdown", onPointerDown as any);
        stage.removeEventListener("pointermove", onPointerMove as any);
        stage.removeEventListener("pointerup", onPointerUpOrCancel as any);
        stage.removeEventListener("pointercancel", onPointerUpOrCancel as any);
        stage.removeEventListener("pointerleave", onPointerLeave as any);
      }

      stopLoop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reduceMotion, allowMouseParallax, allowTouchParallax]);

  function tick() {
    if (!running.current) return;

    const el = sectionRef.current;
    if (!el) return;

    // aggiorna metriche stage senza “saltare” su 0
    const stage = stageRef.current;
    if (stage) {
      const sr = stage.getBoundingClientRect();
      if (sr.width > 30) stageW.current = sr.width;
    }

    const rect = el.getBoundingClientRect();

    // ✅ IMPORTANTISSIMO su mobile: allinea rect.* con visualViewport
    const vv = window.visualViewport;
    const vh = Math.max(1, vv?.height ?? window.innerHeight ?? 1);
    const vOff = vv?.offsetTop ?? 0;
    const top = rect.top - vOff;

    // progress 0..1
    const raw = clamp((vh - top) / (rect.height + vh), 0, 1);

    // wave 0->1->0
    const wave = 1 - Math.abs(2 * raw - 1);

    const eased = easeInOutQuint(wave);
    target.current = eased;
    current.current = lerp(current.current, target.current, 0.14);

    // ✅ su phone: micro-parallax automatico durante lo scroll (se non stai toccando)
    if (phoneRef.current && !touching.current) {
      pTargetX.current = Math.sin(raw * Math.PI * 2) * 0.22;
      pTargetY.current = Math.cos(raw * Math.PI * 2) * 0.14;
    }

    pX.current = lerp(pX.current, pTargetX.current, 0.10);
    pY.current = lerp(pY.current, pTargetY.current, 0.10);

    apply(current.current, pX.current, pY.current);

    // continua sempre finché la sezione è “in loop” (IO la spegne quando esce)
    raf.current = requestAnimationFrame(tick);
  }

  function apply(t: number, nx: number, ny: number) {
    const c = centerRef.current;
    const l = leftRef.current;
    const r = rightRef.current;
    if (!c || !l || !r) return;

    const w = stageW.current || 700;
    const sideSize = phoneRef.current ? 118 : 148;
    const sideHalf = sideSize / 2;
    const safe = 12;
    const maxX = clamp(w / 2 - sideHalf - safe, 0, 190);

    const cY = lerp(phoneRef.current ? 12 : 18, 0, t);
    const cS = lerp(0.965, 1.0, t);

    const x = lerp(0, maxX, t);
    const y = lerp(phoneRef.current ? 28 : 34, phoneRef.current ? 12 : 14, t);
    const s = lerp(0.90, 0.96, t);

    const breathe = 1 + Math.sin(t * Math.PI) * 0.01;

    const pxC = nx * 12;
    const pyC = ny * 8;
    const rotC = nx * -1.2;

    const pxS = nx * 9;
    const pyS = ny * 6;
    const rotS = nx * 1.0;

    // ✅ niente “min opacity” su phone → non sporca le altre sezioni
    const cO = lerp(0, 1.0, t);
    const o = lerp(0, 0.92, t);

    c.style.opacity = String(cO);
    c.style.transform = `translate3d(${pxC}px, ${cY + pyC}px, 0) rotate(${rotC}deg) scale(${cS * breathe})`;

    l.style.opacity = String(o);
    l.style.transform = `translate3d(${-x + pxS}px, ${y + pyS}px, 0) rotate(${-rotS}deg) scale(${s})`;

    r.style.opacity = String(o);
    r.style.transform = `translate3d(${x + pxS}px, ${y + pyS}px, 0) rotate(${rotS}deg) scale(${s})`;
  }

  return (
    // ✅ overflow-hidden QUI: impedisce alle sagome di finire nelle altre sezioni
    <section ref={sectionRef} className="cc-section relative overflow-hidden" id="sellers">
      {/* glow leggero dietro */}
      <div aria-hidden className="pointer-events-none absolute inset-0">
        <div className="absolute inset-0 bg-[radial-gradient(60%_50%_at_50%_35%,rgba(255,255,255,0.09),transparent_60%)]" />
        <div className="absolute inset-0 bg-[radial-gradient(50%_40%_at_50%_75%,rgba(255,255,255,0.05),transparent_55%)]" />
      </div>

      <div className="relative z-[2] mx-auto w-full max-w-6xl px-4 md:px-8">
        <div className="text-center">
          <div className="text-[11px] tracking-[0.35em] text-white/45">BEST SELLERS</div>

          <h2 className="mt-2 text-3xl font-semibold tracking-tight text-white sm:text-4xl md:text-5xl">
            Sellers
          </h2>

        

          <div className="mt-6 flex items-center justify-center gap-3">
            <Link
              href="/sellers"
              className="inline-flex items-center gap-2 rounded-full border border-white/12 bg-white/5 px-5 py-2.5 text-sm text-white/85 backdrop-blur hover:bg-white/10"
            >
              Entra nella sezione <span className="text-white/60">→</span>
            </Link>
          </div>
        </div>

        <div className="relative mt-10 flex items-center justify-center sm:mt-14">
          <div
            ref={stageRef}
            className="relative h-[220px] w-full max-w-[620px] sm:h-[260px] sm:max-w-[700px]"
            style={{ touchAction: "pan-y" }}
          >
            <div
              aria-hidden
              className="pointer-events-none absolute inset-0"
              style={{
                background:
                  "radial-gradient(closest-side at 50% 55%, rgba(255,255,255,0.06), transparent 65%)",
              }}
            />

            <div className="absolute inset-0 flex items-center justify-center">
              <div
                ref={leftRef}
                className="absolute will-change-transform"
                style={{ opacity: 0, transform: "translate3d(0,34px,0) scale(0.9)" }}
              >
                <SilhouetteApple size={isPhone ? 118 : 148} variant="side" />
              </div>

              <div
                ref={centerRef}
                className="absolute z-10 will-change-transform"
                style={{ opacity: 0, transform: "translate3d(0,18px,0) scale(0.965)" }}
              >
                <SilhouetteApple size={isPhone ? 156 : 182} variant="main" />
              </div>

              <div
                ref={rightRef}
                className="absolute will-change-transform"
                style={{ opacity: 0, transform: "translate3d(0,34px,0) scale(0.9)" }}
              >
                <SilhouetteApple size={isPhone ? 118 : 148} variant="side" />
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

/* ---------- premium “apple-ish” silhouette ---------- */

function SilhouetteApple({ size, variant }: { size: number; variant: "main" | "side" }) {
  const uid = useId();
  const g1 = `${uid}-g1-${variant}`;
  const g2 = `${uid}-g2-${variant}`;
  const hl = `${uid}-hl-${variant}`;

  const shadow =
    variant === "main"
      ? "drop-shadow-[0_18px_40px_rgba(0,0,0,0.60)]"
      : "drop-shadow-[0_14px_30px_rgba(0,0,0,0.52)]";

  return (
    <div className={["relative grid place-items-center", shadow].join(" ")} style={{ width: size, height: size }}>
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
