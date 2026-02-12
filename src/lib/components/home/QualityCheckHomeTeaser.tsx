"use client";

import { useEffect, useMemo, useRef, useState } from "react";

type IconItem = { emoji: string; label: string };

const ICONS: IconItem[] = [
  { emoji: "👖", label: "Pantaloni" },
  { emoji: "🎩", label: "Cappello" },
  { emoji: "⌚️", label: "Orologio" },
  { emoji: "👕", label: "Maglietta" },
  { emoji: "👟", label: "Scarpe" },
  { emoji: "🧥", label: "Outerwear" },
  { emoji: "👜", label: "Bag" },
];

const ICON_INTERVAL_MS = 2600;
const PATH_SPEED = 0.10;
const SMOOTH_POS = 0.055;
const WARP = 0.14;

// ✅ lens size (deve combaciare con .qc-lensWrap)
const LENS_SIZE = 122;
const LENS_SAFE_PAD = 26; // margine extra (glint/ombra) per non uscire dai bordi

// ✅ sposta tutto più su (cambia solo questo se vuoi ancora più alto: "42%" / "40%")
const CENTER_TOP = "44%";

function lerp(a: number, b: number, t: number) {
  return a + (b - a) * t;
}
function clamp(n: number, a: number, b: number) {
  return Math.max(a, Math.min(b, n));
}

export default function QualityCheckHomeTeaser() {
  const stageRef = useRef<HTMLDivElement | null>(null);
  const lensRef = useRef<HTMLDivElement | null>(null);

  const raf = useRef<number | null>(null);
  const dims = useRef({ w: 900, h: 360 });

  const [reduceMotion, setReduceMotion] = useState(false);
  const [active, setActive] = useState(0);
  const [prev, setPrev] = useState<number | null>(null);

  const lx = useRef(0);
  const ly = useRef(0);

  useEffect(() => {
    const mq = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    const update = () => setReduceMotion(!!mq?.matches);
    update();
    mq?.addEventListener?.("change", update);
    return () => mq?.removeEventListener?.("change", update);
  }, []);

  useEffect(() => {
    const update = () => {
      const el = stageRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      dims.current = { w: Math.max(1, r.width), h: Math.max(1, r.height) };
    };
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);

  useEffect(() => {
    if (reduceMotion) return;

    const id = window.setInterval(() => {
      setActive((i) => {
        setPrev(i);
        return (i + 1) % ICONS.length;
      });
    }, ICON_INTERVAL_MS);

    return () => window.clearInterval(id);
  }, [reduceMotion]);

  useEffect(() => {
    if (prev == null) return;
    const t = window.setTimeout(() => setPrev(null), 780);
    return () => window.clearTimeout(t);
  }, [prev]);

  useEffect(() => {
    if (reduceMotion) {
      applyLens(0, 0, 1);
      return;
    }

    let t0: number | null = null;

    const tick = (now: number) => {
      if (t0 == null) t0 = now;
      const t = (now - t0) / 1000;

      const { w, h } = dims.current;

      // ✅ amplitudes “safe”: su phone non deve mai uscire dai bordi
      // (prima avevamo min/max fissi che su schermi piccoli spingevano fuori)
      const maxAx = Math.max(0, w / 2 - LENS_SIZE / 2 - LENS_SAFE_PAD);
      const maxAy = Math.max(0, h / 2 - LENS_SIZE / 2 - LENS_SAFE_PAD);

      const ax = Math.min(w * 0.34, maxAx);
      const ay = Math.min(h * 0.48, maxAy);

      let theta = t * (Math.PI * 2) * PATH_SPEED;
      if (WARP > 0) theta = theta + Math.sin(theta) * WARP;

      const tx = ax * Math.sin(2 * theta);
      const ty = ay * Math.sin(theta);

      lx.current = lerp(lx.current, tx, SMOOTH_POS);
      ly.current = lerp(ly.current, ty, SMOOTH_POS);

      const sc = 1 + 0.012 * Math.sin(t * 1.7);

      applyLens(lx.current, ly.current, sc);
      raf.current = requestAnimationFrame(tick);
    };

    raf.current = requestAnimationFrame(tick);

    return () => {
      if (raf.current) cancelAnimationFrame(raf.current);
      raf.current = null;
    };
  }, [reduceMotion]);

  function applyLens(x: number, y: number, scale: number) {
    const lens = lensRef.current;
    if (!lens) return;

    lens.style.transform = `translate3d(-50%,-50%,0) translate3d(${x}px,${y}px,0) scale(${scale})`;
  }

  const current = useMemo(() => ICONS[active], [active]);

  return (
    <div className="relative mt-4 flex items-center justify-center">
      <div
        ref={stageRef}
        className="relative h-[320px] w-full max-w-[900px] select-none sm:h-[360px] sm:max-w-[940px]"
      >
        {/* glow + noise */}
        <div aria-hidden className="pointer-events-none absolute inset-0">
          <div className="absolute inset-0 bg-[radial-gradient(55%_55%_at_50%_40%,rgba(255,255,255,0.10),transparent_62%)]" />
          <div className="absolute inset-0 bg-[radial-gradient(45%_40%_at_50%_85%,rgba(255,255,255,0.06),transparent_60%)]" />
          <div
            className="absolute inset-0 opacity-[0.055] mix-blend-overlay"
            style={{
              backgroundImage:
                'url("data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 width=%27240%27 height=%27240%27%3E%3Cfilter id=%27n%27%3E%3CfeTurbulence type=%27fractalNoise%27 baseFrequency=%27.85%27 numOctaves=%273%27 stitchTiles=%27stitch%27/%3E%3C/filter%3E%3Crect width=%27100%25%27 height=%27100%25%27 filter=%27url(%23n)%27 opacity=%27.35%27/%3E%3C/svg%3E")',
              backgroundSize: "240px 240px",
            }}
          />
        </div>

        {/* ghost icons (sfondo) */}
        <div aria-hidden className="pointer-events-none absolute inset-0">
          <span className="qc-ghost" style={{ left: "7%", top: "20%" }}>👖</span>
          <span className="qc-ghost" style={{ left: "14%", top: "74%" }}>⌚️</span>
          <span className="qc-ghost" style={{ right: "14%", top: "22%" }}>🎩</span>
          <span className="qc-ghost" style={{ right: "10%", top: "74%" }}>👟</span>
          <span className="qc-ghost" style={{ left: "50%", top: "6%", transform: "translateX(-50%)" }}>👜</span>
        </div>

        {/* ✅ articolo al centro (più su) */}
        <div
          className="pointer-events-none absolute left-1/2 -translate-x-1/2 -translate-y-1/2"
          style={{ top: CENTER_TOP }}
        >
          {prev != null ? (
            <span aria-hidden className="qc-emoji qc-exit">
              {ICONS[prev].emoji}
            </span>
          ) : null}

          <span key={active} className="qc-emoji qc-enter qc-breath" aria-label={current.label}>
            {current.emoji}
          </span>
        </div>

        {/* ✅ lente orbita attorno allo stesso centro (più su) */}
        <div
          ref={lensRef}
          aria-hidden
          className="pointer-events-none absolute left-1/2 qc-lensWrap"
          style={{ top: CENTER_TOP }}
        >
          <div className="qc-lensEmoji" aria-hidden>🔎</div>
          <div className="qc-lensGlint" aria-hidden />
        </div>

        <style jsx>{`
          .qc-ghost{
            position:absolute;
            font-size: 34px;
            opacity: .085;
            filter: blur(.25px) saturate(.92);
            transform: translateZ(0);
          }

          .qc-emoji{
            position:absolute;
            left:50%;
            top:50%;
            transform: translate(-50%,-50%);
            font-size: clamp(92px, 10vw, 132px);
            line-height: 1;
            will-change: transform, opacity, filter;
            filter: drop-shadow(0 28px 95px rgba(0,0,0,0.64));
          }

          .qc-enter{ animation: qcEnter 780ms cubic-bezier(.16, 1, .3, 1) both; }
          .qc-exit{ animation: qcExit 720ms cubic-bezier(.2,.85,.2,1) both; }

          @keyframes qcEnter{
            0%{
              opacity: 0;
              transform: translate(-50%,-50%) scale(.90) translateY(10px);
              filter: blur(8px) drop-shadow(0 28px 95px rgba(0,0,0,0.64));
            }
            60%{
              opacity: 1;
              transform: translate(-50%,-50%) scale(1.03) translateY(-2px);
              filter: blur(0px) drop-shadow(0 28px 95px rgba(0,0,0,0.64));
            }
            100%{
              opacity: 1;
              transform: translate(-50%,-50%) scale(1) translateY(0);
            }
          }

          @keyframes qcExit{
            0%{
              opacity: 1;
              transform: translate(-50%,-50%) scale(1) translateY(0);
              filter: blur(0px) drop-shadow(0 28px 95px rgba(0,0,0,0.64));
            }
            100%{
              opacity: 0;
              transform: translate(-50%,-50%) scale(1.06) translateY(-10px);
              filter: blur(10px) drop-shadow(0 28px 95px rgba(0,0,0,0.64));
            }
          }

          .qc-breath{ animation: qcBreath 4.2s ease-in-out infinite; }
          @keyframes qcBreath{
            0%{ transform: translate(-50%,-50%) scale(1) translateY(0); }
            50%{ transform: translate(-50%,-50%) scale(1.012) translateY(-2px); }
            100%{ transform: translate(-50%,-50%) scale(1) translateY(0); }
          }

          .qc-lensWrap{
            width: 122px;
            height: 122px;
            transform: translate3d(-50%,-50%,0);
            will-change: transform;
            filter: drop-shadow(0 26px 110px rgba(0,0,0,0.62));
          }

          .qc-lensEmoji{
            position:absolute;
            inset: 0;
            display:grid;
            place-items:center;
            font-size: 92px;
            line-height: 1;
            transform: translateZ(0);
            filter: drop-shadow(0 18px 60px rgba(0,0,0,0.65)) saturate(1.05);
          }

          .qc-lensGlint{
            position:absolute;
            inset:-18%;
            border-radius: 9999px;
            background: linear-gradient(90deg, transparent, rgba(255,255,255,0.16), transparent);
            transform: rotate(18deg) translateX(-24%);
            opacity: .18;
            animation: glint 6.2s ease-in-out infinite;
            pointer-events:none;
          }
          @keyframes glint{
            0%{ transform: rotate(18deg) translateX(-24%); }
            50%{ transform: rotate(18deg) translateX(40%); }
            100%{ transform: rotate(18deg) translateX(-24%); }
          }

          @media (prefers-reduced-motion: reduce){
            .qc-enter,.qc-exit,.qc-breath,.qc-lensGlint{ animation: none !important; }
          }
        `}</style>
      </div>
    </div>
  );
}
