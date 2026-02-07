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

    // ✅ key: per Yupoo dedup ignorando la query (spesso cambia)
    const keyOf = (u: string) => {
      try {
        const url = new URL(u);
        const host = url.hostname.toLowerCase();
        if (host.includes("photo.yupoo.com")) return `${host}${url.pathname}`.toLowerCase();
        return url.toString().toLowerCase();
      } catch {
        return u.toLowerCase();
      }
    };

    // ✅ se c'è doppione, preferisci la variante con query (spesso ha auth_key)
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

  // ESC + frecce SOLO quando lightbox è aperto
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

  // ✅ quando cambia idx (frecce), porta in vista la thumb attiva
  useEffect(() => {
    const el = thumbsRef.current;
    if (!el) return;
    const active = el.querySelector<HTMLButtonElement>(`button[data-idx="${idx}"]`);
    active?.scrollIntoView({ behavior: "smooth", inline: "center", block: "nearest" });
  }, [idx]);

  // ✅ drag thumbs con soglia + click OK
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

    const THRESH = 6; // px

    const onDown = (e: PointerEvent) => {
      if (e.button !== 0) return;

      drag.current.active = true;
      drag.current.moved = false;
      drag.current.captured = false;
      drag.current.startX = e.clientX;
      drag.current.startScroll = el.scrollLeft;
      drag.current.pointerId = e.pointerId;

      // ❌ NON mettere is-dragging qui
      // ❌ NON fare setPointerCapture qui
    };

    const onMove = (e: PointerEvent) => {
      if (!drag.current.active) return;

      const dx = e.clientX - drag.current.startX;

      // aspetta la soglia prima di considerarlo un drag vero
      if (!drag.current.moved) {
        if (Math.abs(dx) < THRESH) return;

        drag.current.moved = true;
        el.classList.add("is-dragging");

        // ✅ cattura SOLO quando parte davvero il drag
        try {
          el.setPointerCapture(e.pointerId);
          drag.current.captured = true;
        } catch {}
      }

      // drag vero → scorri
      el.scrollLeft = drag.current.startScroll - dx;
    };

    const onUp = () => {
      if (drag.current.moved) {
        drag.current.lastDragAt = Date.now();
      }

      drag.current.active = false;
      el.classList.remove("is-dragging");

      try {
        if (drag.current.captured && drag.current.pointerId !== -1) {
          el.releasePointerCapture(drag.current.pointerId);
        }
      } catch {}

      drag.current.pointerId = -1;
      drag.current.captured = false;

      // reset moved al tick dopo
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

  if (!max) {
    return (
      <div className="it-galleryEmpty">
        <div className="it-galleryEmptyTitle">Nessuna foto disponibile</div>
        <div className="it-galleryEmptySub">Aggiungi immagini nel foglio (images / pics).</div>
      </div>
    );
  }

  return (
    <div className="it-gallery">
      <div className="it-galleryHeroWrap">
        <button
          type="button"
          className="it-galleryHero"
          onClick={() => {
            if (galleryBlocked()) return;
            setOpen(true);
          }}
          aria-label="Apri gallery"
        >
          <img src={pics[idx]} alt={title} className="it-galleryHeroImg" draggable={false} />
          <div className="it-galleryHeroSheen" />
        </button>

        <button
          type="button"
          className="it-galleryArrow it-galleryArrow--left"
          onClick={(e) => {
            e.stopPropagation();
            prev();
          }}
          aria-label="Previous"
        >
          ‹
        </button>

        <button
          type="button"
          className="it-galleryArrow it-galleryArrow--right"
          onClick={(e) => {
            e.stopPropagation();
            next();
          }}
          aria-label="Next"
        >
          ›
        </button>

        <div className="it-galleryCounter">
          {idx + 1}/{max}
        </div>
      </div>

      <div ref={thumbsRef} className="it-galleryThumbs">
        {pics.map((u, i) => (
          <button
            key={`${u}-${i}`}
            type="button"
            className="it-galleryThumb"
            data-idx={i}
            data-active={i === idx ? "1" : "0"}
            onClick={() => {
              // ✅ se hai appena trascinato, ignora il click "di rilascio"
              if (Date.now() - drag.current.lastDragAt < 220) return;
              setIdx(i);
            }}
            aria-label={`Foto ${i + 1}`}
          >
            <img src={u} alt="" className="it-galleryThumbImg" draggable={false} />
          </button>
        ))}
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
