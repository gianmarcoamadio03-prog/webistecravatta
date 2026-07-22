"use client";

import { useEffect, useState } from "react";
import { toggleFavorite, isFavorite, subscribeFavorites } from "@/src/lib/favorites";

function HeartIcon({ filled, className = "h-4 w-4" }: { filled: boolean; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill={filled ? "currentColor" : "none"} aria-hidden="true">
      <path
        d="M12 20.5s-7.5-4.6-9.8-9.1C.6 8 2 4.7 5.2 3.7 7.6 3 9.9 4 12 6.4 14.1 4 16.4 3 18.8 3.7c3.2 1 4.6 4.3 3 7.7-2.3 4.5-9.8 9.1-9.8 9.1z"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
    </svg>
  );
}

type Props = {
  slug: string;
  title: string;
  cover?: string;
  seller?: string;
  brand?: string;
  category?: string;
  price?: number | null;
  mulebuy?: string;
  size?: "sm" | "md";
};

export default function FavoriteButton({
  slug, title, cover, seller, brand, category, price, mulebuy, size = "md",
}: Props) {
  const [fav, setFav] = useState(false);

  useEffect(() => {
    setFav(isFavorite(slug));
    const unsub = subscribeFavorites(() => setFav(isFavorite(slug)));
    return unsub;
  }, [slug]);

  function handleClick() {
    toggleFavorite({ slug, title, cover, seller, brand, category, price: price ?? null, mulebuy });
    setFav(isFavorite(slug));
  }

  const isSm = size === "sm";

  return (
    <button
      type="button"
      onClick={handleClick}
      className={[
        "inline-flex items-center justify-center gap-1.5",
        isSm
          ? "h-7 px-3 rounded-full border text-[11px] font-semibold tracking-[0.18em] uppercase leading-none"
          : "h-11 px-4 rounded-full border transition font-semibold text-sm",
        "transition whitespace-nowrap",
        fav
          ? "border-rose-400/40 bg-rose-400/10 text-rose-300 hover:bg-rose-400/15"
          : "border-white/10 bg-white/5 text-white/80 hover:bg-white/[0.07]",
      ].join(" ")}
      title={fav ? "Rimuovi dai preferiti" : "Aggiungi ai preferiti"}
    >
      <HeartIcon filled={fav} className={isSm ? "h-3.5 w-3.5" : "h-5 w-5"} />
      {fav ? "Salvato" : "Preferiti"}
    </button>
  );
}
