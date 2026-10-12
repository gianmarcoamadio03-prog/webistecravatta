"use client";

import { useEffect, useState } from "react";

export default function HaulGallery({ photos, title }: { photos: string[]; title: string }) {
  const [selected, setSelected] = useState<number | null>(null);

  useEffect(() => {
    if (selected === null) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSelected(null);
      if (e.key === "ArrowRight") setSelected(i => i === null ? null : (i + 1) % photos.length);
      if (e.key === "ArrowLeft") setSelected(i => i === null ? null : (i - 1 + photos.length) % photos.length);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [selected, photos.length]);

  if (!photos.length) return null;

  return <>
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
      {photos.map((photo, i) => (
        <button
          type="button"
          key={`${i}-${photo}`}
          onClick={() => setSelected(i)}
          aria-label={`Apri foto ${i + 1} di ${photos.length}`}
          className="group flex h-40 items-center justify-center overflow-hidden rounded-xl border border-white/10 bg-white/[0.035] p-2 transition hover:border-violet-400/60 hover:bg-white/[0.07] sm:h-44 lg:h-48"
        >
          <img src={photo} alt={`${title}, foto ${i + 1}`} loading="lazy" className="h-full w-full object-contain transition duration-300 group-hover:scale-[1.03]" />
        </button>
      ))}
    </div>
    {selected !== null && <div
      role="dialog"
      aria-modal="true"
      aria-label={`Foto ${selected + 1} di ${photos.length}`}
      onClick={() => setSelected(null)}
      className="fixed inset-0 z-[200] flex items-center justify-center bg-black/95 p-4 sm:p-8"
    >
      <button type="button" onClick={() => setSelected(null)} className="absolute right-4 top-4 rounded-full bg-white/15 px-4 py-2 text-sm text-white hover:bg-white/25">Chiudi ✕</button>
      <img src={photos[selected]} alt={`${title}, foto ${selected + 1}`} onClick={e => e.stopPropagation()} className="max-h-[82vh] max-w-full object-contain" />
      {photos.length > 1 && <div className="absolute bottom-5 left-1/2 flex -translate-x-1/2 items-center gap-3">
        <button type="button" onClick={e => { e.stopPropagation(); setSelected((selected - 1 + photos.length) % photos.length); }} className="rounded-full bg-white/15 px-4 py-2 text-white hover:bg-white/25" aria-label="Foto precedente">←</button>
        <span className="min-w-12 text-center text-sm text-white/80">{selected + 1} / {photos.length}</span>
        <button type="button" onClick={e => { e.stopPropagation(); setSelected((selected + 1) % photos.length); }} className="rounded-full bg-white/15 px-4 py-2 text-white hover:bg-white/25" aria-label="Foto successiva">→</button>
      </div>}
    </div>}
  </>;
}
