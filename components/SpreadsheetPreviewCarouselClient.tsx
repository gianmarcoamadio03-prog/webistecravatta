"use client";

import Image from "next/image";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";

type Variant = "home" | "default" | "sellers";

type Card = {
  slug: string;
  title: string;
  subtitle: string;
  cover: string;
  badge: string;
  priceEur?: number | null;
};

export default function SpreadsheetPreviewCarouselClient({
  items,
  variant = "default",
}: {
  items: Card[];
  variant?: Variant;
}) {
  const loop = useMemo(() => (items.length ? [...items, ...items] : []), [items]);

  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const trackRef = useRef<HTMLDivElement | null>(null);

  const halfWidthRef = useRef(0);
  const interactingUntilRef = useRef(0);
  const draggedRef = useRef(false);

  const [hovered, setHovered] = useState(false);
  const [inView, setInView] = useState(true);
  const [reduceMotion, setReduceMotion] = useState(false);

  useEffect(() => {
    const m = window.matchMedia("(prefers-reduced-motion: reduce)");
    const set = () => setReduceMotion(!!m.matches);
    set();
    m.addEventListener?.("change", set);
    return () => m.removeEventListener?.("change", set);
  }, []);

  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;

    const io = new IntersectionObserver(
      ([entry]) => setInView(entry.isIntersecting),
      { threshold: 0.2 }
    );

    io.observe(el);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    const track = trackRef.current;
    if (!track) return;

    const update = () => {
      halfWidthRef.current = track.scrollWidth / 2;
    };

    update();
    const ro = new ResizeObserver(update);
    ro.observe(track);
    return () => ro.disconnect();
  }, [loop.length]);

  useEffect(() => {
    let raf = 0;

    const tick = () => {
      raf = requestAnimationFrame(tick);

      const el = scrollerRef.current;
      if (!el) return;

      if (reduceMotion) return;
      if (!inView) return;
      if (hovered) return;
      if (document.hidden) return;
      if (Date.now() < interactingUntilRef.current) return;

      const half = halfWidthRef.current;
      if (!half) return;

      el.scrollLeft += 0.55;

      if (el.scrollLeft >= half) el.scrollLeft -= half;
      if (el.scrollLeft < 0) el.scrollLeft += half;
    };

    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [reduceMotion, inView, hovered, loop.length]);

  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;

    let dragging = false;
    let startX = 0;
    let startScroll = 0;

    const onDown = (e: PointerEvent) => {
      dragging = true;
      draggedRef.current = false;
      startX = e.clientX;
      startScroll = el.scrollLeft;

      el.classList.add("is-dragging");
      interactingUntilRef.current = Date.now() + 999999;
      (e.target as HTMLElement)?.setPointerCapture?.(e.pointerId);
    };

    const onMove = (e: PointerEvent) => {
      if (!dragging) return;
      const dx = e.clientX - startX;
      if (Math.abs(dx) > 6) draggedRef.current = true;
      el.scrollLeft = startScroll - dx;
    };

    const end = () => {
      if (!dragging) return;
      dragging = false;
      el.classList.remove("is-dragging");
      interactingUntilRef.current = Date.now() + 1400;
    };

    el.addEventListener("pointerdown", onDown);
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", end);
    el.addEventListener("pointercancel", end);
    el.addEventListener("pointerleave", end);

    return () => {
      el.removeEventListener("pointerdown", onDown);
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", end);
      el.removeEventListener("pointercancel", end);
      el.removeEventListener("pointerleave", end);
    };
  }, []);

  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;

    const onWheel = (e: WheelEvent) => {
      // ✅ niente “scroll-jacking”: lasciamo lo scroll verticale della pagina libero
      // Intercettiamo solo quando l’utente fa un gesto chiaramente orizzontale (trackpad)
      // oppure tiene premuto SHIFT.
      const absX = Math.abs(e.deltaX);
      const absY = Math.abs(e.deltaY);
      const wantsHorizontal = absX > absY || e.shiftKey;
      if (!wantsHorizontal) return;

      e.preventDefault();
      el.scrollLeft += absX > absY ? e.deltaX : e.deltaY;
      interactingUntilRef.current = Date.now() + 1400;
    };

    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel as any);
  }, []);

  const nudge = (dir: -1 | 1) => {
    const el = scrollerRef.current;
    if (!el) return;

    const firstCard = el.querySelector(".sheet-card") as HTMLElement | null;
    const step = (firstCard?.offsetWidth || 360) + 18;

    interactingUntilRef.current = Date.now() + 1800;
    el.scrollBy({ left: dir * step, behavior: "smooth" });
  };

  if (!items.length) return null;

  const rootClass = [
    "sheet-preview",
    variant === "home" ? "items-preview" : "",
    variant === "sellers" ? "seller-cards" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div
      className={rootClass}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      aria-label="Anteprima Spreadsheet"
    >
      <div className="sheet-preview-controls" aria-hidden={false}>
        <button
          type="button"
          className="sheet-navBtn"
          onClick={() => nudge(-1)}
          aria-label="Scorri a sinistra"
        >
          ‹
        </button>
        <button
          type="button"
          className="sheet-navBtn"
          onClick={() => nudge(1)}
          aria-label="Scorri a destra"
        >
          ›
        </button>
      </div>

      <div ref={scrollerRef} className="sheet-preview-scroller">
        <div ref={trackRef} className="sheet-preview-track">
          {loop.map((it, idx) => (
            <Link
              key={`${it.slug}-${idx}`}
              href={`/item/${encodeURIComponent(it.slug)}`}
              // ✅ premium feel: prefetch delle pagine item quando entrano in viewport
              className="sheet-card"
              onClick={(e) => {
                if (draggedRef.current) {
                  e.preventDefault();
                  e.stopPropagation();
                  draggedRef.current = false;
                }
              }}
              aria-label={`Apri ${it.title}`}
            >
              <div className="sheet-card-media" aria-hidden>
                {it.cover.startsWith("/api/img?") ? (
                  // /api/img è già un proxy con cache → evitiamo doppia ottimizzazione
                  <img
                    src={it.cover}
                    alt={it.title}
                    className="sheet-card-img"
                    loading={idx < 2 ? "eager" : "lazy"}
                    decoding="async"
                    draggable={false}
                  />
                ) : (
                  <Image
                    src={it.cover}
                    alt={it.title}
                    fill
                    sizes="(max-width: 640px) 280px, 360px"
                    quality={70}
                    priority={idx < 2}
                    className="sheet-card-img"
                  />
                )}
              </div>

              <div className="sheet-card-overlay" aria-hidden />

              <div className="sheet-card-meta">
                <div className="sheet-badge">{it.badge}</div>
                <div className="sheet-title">{it.title}</div>

                <div className="sheet-subRow">
                  <div className="sheet-sub">{it.subtitle}</div>

                  {typeof it.priceEur === "number" && (
                    <div className="sheet-price">€{it.priceEur.toFixed(2)}</div>
                  )}
                </div>
              </div>
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
}
