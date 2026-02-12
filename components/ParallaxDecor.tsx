// components/ParallaxDecor.tsx
"use client";

import { useEffect, useRef } from "react";

type DecorVariant = "shapes" | "orbs";

type Props = {
  intensity?: number;
  className?: string;
  variant?: DecorVariant; // "shapes" = orbs+shapes, "orbs" = solo bg/orbs
};

const clamp = (n: number, a: number, b: number) => Math.max(a, Math.min(b, n));

function resolveRoot(el: HTMLElement): HTMLElement {
  return (
    (el.closest("[data-parallax-root]") as HTMLElement | null) ??
    (el.closest(".ps-section") as HTMLElement | null) ??
    (el.closest("section") as HTMLElement | null) ??
    (el.parentElement as HTMLElement | null) ??
    el
  );
}

function resolveScroller(root: HTMLElement): Window | HTMLElement {
  const home = document.querySelector<HTMLElement>(".cc-home");
  if (home) {
    const s = window.getComputedStyle(home);
    const oy = s.overflowY;
    const canScroll = home.scrollHeight > home.clientHeight + 2;
    if (canScroll && (oy === "auto" || oy === "scroll" || oy === "overlay")) return home;
  }

  let cur: HTMLElement | null = root;
  while (cur && cur !== document.body && cur !== document.documentElement) {
    const s = window.getComputedStyle(cur);
    const oy = s.overflowY;
    if (oy === "auto" || oy === "scroll" || oy === "overlay") return cur;
    cur = cur.parentElement;
  }

  return window;
}

export default function ParallaxDecor({
  intensity = 18,
  className = "",
  variant = "shapes",
}: Props) {
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const mq = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    if (mq?.matches) return;

    const root = resolveRoot(el);
    const scroller = resolveScroller(root);

    let raf = 0;
    let running = false;

    const getViewportHeight = () =>
      Math.max(1, window.visualViewport?.height ?? window.innerHeight ?? 1);

    const update = () => {
      const rect = root.getBoundingClientRect();

      let vh = getViewportHeight();
      let top = rect.top;

      if (scroller !== window) {
        const sr = (scroller as HTMLElement).getBoundingClientRect();
        vh = Math.max(1, (scroller as HTMLElement).clientHeight || 1);
        top = rect.top - sr.top;
      }

      const total = vh + rect.height;
      const p = (vh - top) / Math.max(1, total);
      const t01 = clamp(p, 0, 1);
      const centered = (t01 - 0.5) * 2; // -1..1

      const i = intensity;

      el.style.setProperty("--p1", `${centered * i}px`);
      el.style.setProperty("--p2", `${centered * i * 0.6}px`);
      el.style.setProperty("--p3", `${centered * i * 1.15}px`);
      el.style.setProperty("--p4", `${centered * i * 0.35}px`);

      const fade = clamp(1 - Math.abs(centered) * 1.15, 0, 1);
      el.style.setProperty("--pfade", String(fade));

      el.style.setProperty("--t", `${centered * i}px`);
      el.style.setProperty("--rot", `${centered * 6}deg`);
    };

    const loop = () => {
      if (!running) return;
      update();
      raf = requestAnimationFrame(loop);
    };

    const start = () => {
      if (running) return;
      running = true;
      loop();
    };

    const stop = () => {
      running = false;
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
    };

    const io = new IntersectionObserver(
      (entries) => {
        const anyVisible = entries.some((e) => e.isIntersecting);
        if (anyVisible) start();
        else stop();
      },
      { root: scroller === window ? null : (scroller as Element), threshold: 0 }
    );

    io.observe(root);

    const onResize = () => update();
    window.addEventListener("resize", onResize);
    window.visualViewport?.addEventListener("resize", onResize);
    window.visualViewport?.addEventListener("scroll", onResize);

    update();
    start();

    return () => {
      stop();
      io.disconnect();
      window.removeEventListener("resize", onResize);
      window.visualViewport?.removeEventListener("resize", onResize);
      window.visualViewport?.removeEventListener("scroll", onResize);
    };
  }, [intensity]);

  return (
    <div
      ref={ref}
      className={`ps-decor ${className}`}
      aria-hidden="true"
      data-variant={variant} // ✅ IMPORTANTISSIMO per i tuoi kill-switch CSS
    >
      <div className="ps-bg" />

      <div className="ps-orbs">
        <span className="ps-orb ps-orb--a" />
        <span className="ps-orb ps-orb--b" />
        <span className="ps-orb ps-orb--c" />
      </div>

      {variant === "shapes" && (
        <div className="ps-shapes">
          <svg className="ps-sil ps-sil--l" viewBox="0 0 64 64">
            <path d="M32 34c7.2 0 13-5.8 13-13S39.2 8 32 8 19 13.8 19 21s5.8 13 13 13Z" fill="rgba(255,255,255,0.14)" />
            <path d="M8 56c2.2-12 13-18 24-18s21.8 6 24 18" fill="rgba(255,255,255,0.10)" />
            <path d="M32 34c7.2 0 13-5.8 13-13S39.2 8 32 8 19 13.8 19 21s5.8 13 13 13Z" stroke="rgba(255,255,255,0.35)" strokeWidth="2" fill="none" />
            <path d="M8 56c2.2-12 13-18 24-18s21.8 6 24 18" stroke="rgba(255,255,255,0.25)" strokeWidth="2" fill="none" strokeLinecap="round" />
          </svg>

          <svg className="ps-sil ps-sil--m" viewBox="0 0 64 64">
            <path d="M32 36c8.6 0 15.5-7 15.5-15.5S40.6 5 32 5 16.5 12 16.5 20.5 23.4 36 32 36Z" fill="rgba(255,255,255,0.16)" />
            <path d="M6 58c2.6-13.2 14.2-20 26-20s23.4 6.8 26 20" fill="rgba(255,255,255,0.11)" />
            <path d="M32 36c8.6 0 15.5-7 15.5-15.5S40.6 5 32 5 16.5 12 16.5 20.5 23.4 36 32 36Z" stroke="rgba(255,255,255,0.38)" strokeWidth="2" fill="none" />
            <path d="M6 58c2.6-13.2 14.2-20 26-20s23.4 6.8 26 20" stroke="rgba(255,255,255,0.28)" strokeWidth="2" fill="none" strokeLinecap="round" />
          </svg>

          <svg className="ps-sil ps-sil--r" viewBox="0 0 64 64">
            <path d="M32 34c7.2 0 13-5.8 13-13S39.2 8 32 8 19 13.8 19 21s5.8 13 13 13Z" fill="rgba(255,255,255,0.14)" />
            <path d="M8 56c2.2-12 13-18 24-18s21.8 6 24 18" fill="rgba(255,255,255,0.10)" />
            <path d="M32 34c7.2 0 13-5.8 13-13S39.2 8 32 8 19 13.8 19 21s5.8 13 13 13Z" stroke="rgba(255,255,255,0.35)" strokeWidth="2" fill="none" />
            <path d="M8 56c2.2-12 13-18 24-18s21.8 6 24 18" stroke="rgba(255,255,255,0.25)" strokeWidth="2" fill="none" strokeLinecap="round" />
          </svg>
        </div>
      )}

      <div className="ps-noise" />
    </div>
  );
}
