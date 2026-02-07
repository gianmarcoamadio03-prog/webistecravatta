"use client";

import * as React from "react";

export type LightboxProps = {
  open: boolean;
  images: string[];
  title?: string;
  initialIndex?: number;
  onClose: () => void;
};

function wrap(i: number, len: number) {
  if (len <= 0) return 0;
  return (i % len + len) % len;
}

export function Lightbox({
  open,
  images,
  title = "Image",
  initialIndex = 0,
  onClose,
}: LightboxProps) {
  const safe = React.useMemo(
    () => (Array.isArray(images) ? images.filter(Boolean) : []),
    [images]
  );

  const [idx, setIdx] = React.useState(() => wrap(initialIndex, safe.length));

  React.useEffect(() => {
    if (open) setIdx(wrap(initialIndex, safe.length));
  }, [open, initialIndex, safe.length]);

  // ESC + frecce
  React.useEffect(() => {
    if (!open) return;

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "ArrowLeft") setIdx((v) => wrap(v - 1, safe.length));
      if (e.key === "ArrowRight") setIdx((v) => wrap(v + 1, safe.length));
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onClose, safe.length]);

  // blocca scroll body
  React.useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  if (!open || safe.length === 0) return null;

  const src = safe[idx];
  const showNav = safe.length > 1;

  return (
    <div
      className="fixed inset-0 z-[9999] bg-black/85 flex items-center justify-center p-4"
      onMouseDown={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Lightbox"
    >
      <div
        className="relative w-full max-w-6xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-3">
          <div className="text-xs text-white/70 font-semibold">
            {title}
            <span className="ml-2 text-white/45">
              {idx + 1}/{safe.length}
            </span>
          </div>

          <button
            type="button"
            className="h-9 px-3 rounded-full border border-white/15 bg-white/5 hover:bg-white/10 text-white/85 text-xs font-semibold"
            onClick={onClose}
          >
            ✕ Chiudi
          </button>
        </div>

        <div className="relative w-full h-[72vh] rounded-3xl overflow-hidden border border-white/12 bg-black shadow-[0_40px_160px_rgba(0,0,0,0.75)]">
          <img
            src={src}
            alt={title}
            className="w-full h-full object-contain select-none"
            draggable={false}
            referrerPolicy="no-referrer"
          />

          {showNav && (
            <button
              type="button"
              onClick={() => setIdx((v) => wrap(v - 1, safe.length))}
              className="absolute left-3 top-1/2 -translate-y-1/2 w-11 h-11 rounded-full bg-white/10 hover:bg-white/20 border border-white/15 text-white text-lg"
              aria-label="Previous"
            >
              ‹
            </button>
          )}

          {showNav && (
            <button
              type="button"
              onClick={() => setIdx((v) => wrap(v + 1, safe.length))}
              className="absolute right-3 top-1/2 -translate-y-1/2 w-11 h-11 rounded-full bg-white/10 hover:bg-white/20 border border-white/15 text-white text-lg"
              aria-label="Next"
            >
              ›
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

export default Lightbox;
