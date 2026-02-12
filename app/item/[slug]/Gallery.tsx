"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Lightbox from "@/components/Lightbox";

const BLOCK_KEY = "__BLOCK_GALLERY_OPEN_UNTIL__";

function galleryBlocked() {
  try {
    const until = (window as any)[BLOCK_KEY] as number | undefined;
    return typeof until === "number" && Date.now() < until;
  } catch {
    return false;
  }
}

function isValidUrl(u: any) {
  return typeof u === "string" && /^https?:\/\//i.test(u.trim());
}

function toProxyIfNeeded(url: string) {
  const u = (url || "").trim();
  if (!u) return "";

  const low = u.toLowerCase();
  const isYupoo =
    low.includes("photo.yupoo.com") ||
    low.includes("yupoo.com") ||
    low.includes("u.yupoo.com") ||
    low.includes("wd.yupoo.com");

  return isYupoo ? `/api/img?url=${encodeURIComponent(u)}` : u;
}

export default function Gallery({
  images = [],
  title = "Item",
}: {
  images: string[];
  title?: string;
}) {
  const safe = useMemo(() => {
    const cleaned = (Array.isArray(images) ? images : [])
      .filter((u) => isValidUrl(u))
      .map((u) => u.trim());

    const keyOf = (u: string) => {
      try {
        const url = new URL(u);
        const host = url.hostname.toLowerCase();
        if (host.includes("photo.yupoo.com"))
          return `${host}${url.pathname}`.toLowerCase();
        return url.toString().toLowerCase();
      } catch {
        return u.toLowerCase();
      }
    };

    const better = (a: string, b: string) => {
      try {
        const qa = new URL(a).search.length;
        const qb = new URL(b).search.length;
        return qb > qa ? b : a;
      } catch {
        return b.length > a.length ? b : a;
      }
    };

    const chosenByKey = new Map<string, string>();
    const order: string[] = [];

    for (const u of cleaned) {
      const k = keyOf(u);
      if (!chosenByKey.has(k)) {
        chosenByKey.set(k, u);
        order.push(k);
      } else {
        chosenByKey.set(k, better(chosenByKey.get(k)!, u));
      }
    }

    return order.map((k) => chosenByKey.get(k)!).filter(Boolean) as string[];
  }, [images]);

  const pics = useMemo(() => safe.map(toProxyIfNeeded), [safe]);

  const [idx, setIdx] = useState(0);
  const [open, setOpen] = useState(false);

  const max = pics.length;

  useEffect(() => {
    if (!max) return;
    if (idx < 0) setIdx(0);
    if (idx > max - 1) setIdx(max - 1);
  }, [idx, max]);

  function prev() {
    if (!max) return;
    setIdx((i) => (i - 1 + max) % max);
  }
  function next() {
    if (!max) return;
    setIdx((i) => (i + 1) % max);
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!open) return;
      if (e.key === "Escape") setOpen(false);
      if (e.key === "ArrowLeft") prev();
      if (e.key === "ArrowRight") next();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, max]);

  const thumbsRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = thumbsRef.current;
    if (!el) return;
    const active = el.querySelector<HTMLButtonElement>(
      `button[data-idx="${idx}"]`
    );
    active?.scrollIntoView({
      behavior: "smooth",
      inline: "center",
      block: "nearest",
    });
  }, [idx]);

  const drag = useRef({
    active: false,
    startX: 0,
    startScroll: 0,
    moved: false,
    captured: false,
    pointerId: -1,
    lastDragAt: 0,
  });

  useEffect(() => {
    const el = thumbsRef.current;
    if (!el) return;

    const THRESH = 6;

    const onDown = (e: PointerEvent) => {
      if (e.button !== 0) return;
      drag.current.active = true;
      drag.current.moved = false;
      drag.current.captured = false;
      drag.current.startX = e.clientX;
      drag.current.startScroll = el.scrollLeft;
      drag.current.pointerId = e.pointerId;
    };

    const onMove = (e: PointerEvent) => {
      if (!drag.current.active) return;

      const dx = e.clientX - drag.current.startX;

      if (!drag.current.moved) {
        if (Math.abs(dx) < THRESH) return;

        drag.current.moved = true;
        try {
          el.setPointerCapture(e.pointerId);
          drag.current.captured = true;
        } catch {}
      }

      el.scrollLeft = drag.current.startScroll - dx;
    };

    const onUp = () => {
      if (drag.current.moved) drag.current.lastDragAt = Date.now();

      drag.current.active = false;

      try {
        if (drag.current.captured && drag.current.pointerId !== -1) {
          el.releasePointerCapture(drag.current.pointerId);
        }
      } catch {}

      drag.current.pointerId = -1;
      drag.current.captured = false;

      window.setTimeout(() => {
        drag.current.moved = false;
      }, 0);
    };

    el.addEventListener("pointerdown", onDown);
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
    el.addEventListener("pointercancel", onUp);
    el.addEventListener("pointerleave", onUp);

    return () => {
      el.removeEventListener("pointerdown", onDown);
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
      el.removeEventListener("pointercancel", onUp);
      el.removeEventListener("pointerleave", onUp);
    };
  }, []);

  // swipe su hero (mobile)
  const swipe = useRef({
    active: false,
    x: 0,
    y: 0,
    id: -1,
  });

  const onHeroDown = (e: React.PointerEvent) => {
    swipe.current.active = true;
    swipe.current.x = e.clientX;
    swipe.current.y = e.clientY;
    swipe.current.id = e.pointerId;
  };

  const onHeroUp = (e: React.PointerEvent) => {
    if (!swipe.current.active) return;
    swipe.current.active = false;

    const dx = e.clientX - swipe.current.x;
    const dy = e.clientY - swipe.current.y;

    // evita swipe se è uno scroll verticale
    if (Math.abs(dy) > 40 && Math.abs(dy) > Math.abs(dx)) return;

    if (dx > 60) prev();
    if (dx < -60) next();
  };

  if (!max) {
    return (
      <div className="p-8 text-center">
        <div className="text-white/90 font-semibold">Nessuna foto disponibile</div>
        <div className="mt-2 text-sm text-white/55">
          Aggiungi immagini nel foglio (images / pics).
        </div>
      </div>
    );
  }

  return (
    <div className="p-3 sm:p-4">
      {/* HERO (fisso: 4:3 + clamp altezza su mobile + img che riempie il box) */}
      <div className="relative overflow-hidden rounded-3xl border border-white/10 bg-black/55">
        <button
          type="button"
          className="relative block w-full focus:outline-none"
          style={{
            aspectRatio: "4 / 3",
            maxHeight: "60vh", // ✅ evita “hero gigante” su mobile
          }}
          onPointerDown={onHeroDown}
          onPointerUp={onHeroUp}
          onPointerCancel={() => (swipe.current.active = false)}
          onClick={() => {
            if (galleryBlocked()) return;
            setOpen(true);
          }}
          aria-label="Apri gallery"
        >
          {/* ✅ img deve essere w/h FULL altrimenti su mobile “scappa” */}
          <img
            src={pics[idx]}
            alt={title}
            draggable={false}
            loading="eager"
            decoding="async"
            className="absolute inset-0 h-full w-full object-contain select-none bg-black/20"
          />

          <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(700px_280px_at_50%_0%,rgba(255,255,255,0.10),transparent_60%)]" />
          <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/55 via-black/10 to-transparent" />
        </button>

        {/* arrows */}
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            prev();
          }}
          className="absolute left-3 top-1/2 -translate-y-1/2 h-9 w-9 rounded-full border border-white/10 bg-black/45 backdrop-blur-md text-white/90 hover:bg-black/60 transition"
          aria-label="Previous"
        >
          ‹
        </button>

        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            next();
          }}
          className="absolute right-3 top-1/2 -translate-y-1/2 h-9 w-9 rounded-full border border-white/10 bg-black/45 backdrop-blur-md text-white/90 hover:bg-black/60 transition"
          aria-label="Next"
        >
          ›
        </button>

        {/* counter */}
        <div className="absolute bottom-3 right-3 px-2.5 py-1 rounded-full text-[12px] font-semibold border border-white/10 bg-black/55 backdrop-blur-md text-white/90">
          {idx + 1}/{max}
        </div>
      </div>

      {/* THUMBS (più piccole su mobile, meno “casino”) */}
      <div
        ref={thumbsRef}
        className="mt-3 flex gap-2 overflow-x-auto pb-1 [-webkit-overflow-scrolling:touch] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden cursor-grab select-none"
      >
        {pics.map((u, i) => {
          const active = i === idx;
          return (
            <button
              key={`${u}-${i}`}
              type="button"
              data-idx={i}
              onClick={() => {
                if (Date.now() - drag.current.lastDragAt < 220) return;
                setIdx(i);
              }}
              className={[
                "relative h-14 w-14 sm:h-16 sm:w-16 rounded-2xl overflow-hidden border transition shrink-0",
                active
                  ? "border-white/30 bg-white/10"
                  : "border-white/10 bg-white/5 hover:border-white/20",
              ].join(" ")}
              aria-label={`Foto ${i + 1}`}
            >
              <img
                src={u}
                alt=""
                draggable={false}
                loading="lazy"
                decoding="async"
                className="h-full w-full object-cover"
              />
              {active ? (
                <div className="absolute inset-0 ring-2 ring-white/15 pointer-events-none" />
              ) : null}
            </button>
          );
        })}
      </div>

      <Lightbox
        open={open}
        images={pics}
        title={title}
        initialIndex={idx}
        onClose={() => setOpen(false)}
      />
    </div>
  );
}
