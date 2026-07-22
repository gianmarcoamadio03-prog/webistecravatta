// app/favorites/FavoritesClient.tsx
"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { imgProxy, type ImgSize } from "@/src/lib/imgProxy";
import {
  getFavorites,
  removeFavorite,
  clearFavorites,
  subscribeFavorites,
  type FavoriteItem,
} from "@/src/lib/favorites";

function isYupooUrl(raw: string) {
  try {
    const u = new URL(raw);
    return u.hostname.toLowerCase().includes("yupoo.com");
  } catch {
    return raw.toLowerCase().includes("yupoo.com");
  }
}

function forceApiImgSize(raw: string, size: ImgSize = "small") {
  const s = (raw ?? "").trim();
  if (!s) return "";
  if (!s.includes("/api/img?url=")) return s;
  try {
    const base = s.startsWith("http") ? undefined : "http://localhost";
    const u = new URL(s, base);
    if (u.pathname.endsWith("/api/img")) {
      u.searchParams.set("size", size);
      if (!s.startsWith("http")) return `${u.pathname}?${u.searchParams.toString()}`;
      return u.toString();
    }
    return s;
  } catch {
    if (!s.includes("size=")) return `${s}${s.includes("?") ? "&" : "?"}size=${size}`;
    return s;
  }
}

function coverSrc(raw: string, size: ImgSize = "small") {
  const s = (raw ?? "").trim();
  if (!s) return "";
  if (s.startsWith("data:")) return s;
  if (s.includes("/api/img?url=")) return forceApiImgSize(s, size);
  if (isYupooUrl(s)) return imgProxy(s, size);
  return s;
}

function formatEur(n: number) {
  return `€ ${n.toFixed(2)}`;
}

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

export default function FavoritesClient() {
  const router = useRouter();
  const [list, setList] = useState<FavoriteItem[]>([]);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    setList(getFavorites());
    setHydrated(true);

    const unsub = subscribeFavorites((next) => {
      setList([...next].sort((a, b) => b.addedAt - a.addedAt));
    });

    return unsub;
  }, []);

  const container = "mx-auto w-full max-w-[1700px] px-4 sm:px-5";
  const chipBase =
    "inline-flex items-center justify-center h-8 sm:h-7 px-3 sm:px-2.5 rounded-full border border-white/10 bg-white/[0.04] hover:bg-white/[0.07] text-[12px] sm:text-[11px] text-white/80 transition whitespace-nowrap";

  const empty = hydrated && list.length === 0;

  return (
    <div className="min-h-screen w-full">
      <div className="sticky top-0 z-50 border-b border-white/10 bg-black/55 backdrop-blur-xl">
        <div className={`${container} pt-5 pb-4 sm:pt-7 sm:pb-5`}>
          <div className="relative flex items-center justify-center">
            <Link href="/spreadsheet" className={`${chipBase} absolute left-0 top-1/2 -translate-y-1/2`} title="Torna allo spreadsheet">
              ← Spreadsheet
            </Link>

            <div className="flex items-center gap-2 text-white/90 font-semibold text-lg">
              <HeartIcon filled className="h-5 w-5 text-rose-300" />
              Preferiti
            </div>

            {list.length > 0 ? (
              <button
                type="button"
                onClick={() => {
                  if (confirm("Svuotare tutti i preferiti?")) clearFavorites();
                }}
                className={`${chipBase} absolute right-0 top-1/2 -translate-y-1/2`}
                title="Svuota preferiti"
              >
                Svuota
              </button>
            ) : null}
          </div>

          <div className="mt-3 text-center text-[12px] text-white/55">
            {hydrated ? (
              <>
                Totale: <span className="text-white/90 font-semibold">{list.length}</span>
              </>
            ) : (
              "Caricamento…"
            )}
          </div>
        </div>
      </div>

      <div className={`${container} pt-6 pb-14`}>
        {empty ? (
          <div className="mx-auto max-w-[520px] text-center rounded-3xl border border-white/10 bg-white/[0.04] p-8">
            <div className="text-white/90 font-semibold text-lg">Nessun preferito</div>
            <div className="mt-2 text-sm text-white/55">
              Aggiungi articoli ai preferiti dalla pagina Spreadsheet toccando il cuoricino.
            </div>
            <div className="mt-5">
              <Link
                href="/spreadsheet"
                className="inline-flex items-center justify-center h-10 px-5 rounded-full border border-white/10 bg-white/5 hover:bg-white/8 text-sm text-white/85 transition leading-none"
              >
                Vai allo Spreadsheet
              </Link>
            </div>
          </div>
        ) : (
          <div
            className={[
              "grid gap-4",
              "grid-cols-1 min-[420px]:grid-cols-2",
              "sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 2xl:grid-cols-7",
            ].join(" ")}
          >
            {list.map((x) => {
              const meta = [x.seller, x.category].filter(Boolean).join(" • ");
              const img = x.cover ? coverSrc(x.cover, "small") : "";

              return (
                <div
                  key={x.slug}
                  role="link"
                  tabIndex={0}
                  onClick={() => router.push(`/item/${encodeURIComponent(x.slug)}`)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      router.push(`/item/${encodeURIComponent(x.slug)}`);
                    }
                  }}
                  className={[
                    "relative group cursor-pointer rounded-3xl border border-white/10 bg-white/[0.04] overflow-hidden",
                    "shadow-[0_40px_140px_rgba(0,0,0,0.55)] transition",
                    "hover:border-white/20 hover:bg-white/[0.06] hover:-translate-y-[2px]",
                    "focus:outline-none focus:ring-2 focus:ring-white/20",
                  ].join(" ")}
                >
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      removeFavorite(x.slug);
                    }}
                    className="absolute right-3 top-3 z-10 h-8 w-8 rounded-full border border-white/15 bg-black/45 backdrop-blur flex items-center justify-center text-rose-300 hover:bg-black/65 transition"
                    title="Rimuovi dai preferiti"
                    aria-label="Rimuovi dai preferiti"
                  >
                    <HeartIcon filled className="h-4 w-4" />
                  </button>

                  <div className="relative w-full aspect-[4/3] bg-black/20 overflow-hidden">
                    {img ? (
                      <img
                        src={img}
                        alt={x.title}
                        className="w-full h-full object-cover transition-transform duration-300 group-hover:scale-[1.04]"
                        draggable={false}
                        loading="lazy"
                        decoding="async"
                      />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center text-white/30 text-sm">No image</div>
                    )}

                    <div className="absolute inset-0 bg-gradient-to-t from-black/45 via-black/5 to-transparent pointer-events-none" />

                    {typeof x.price === "number" ? (
                      <div className="absolute left-3 top-3 px-2.5 py-1 rounded-full text-[11px] font-semibold border border-white/15 bg-black/40 text-white/90 backdrop-blur">
                        {formatEur(x.price)}
                      </div>
                    ) : null}
                  </div>

                  <div className="relative p-3">
                    <div className="text-white/92 font-semibold leading-tight line-clamp-2 text-[13px] tracking-[0.01em]">
                      {x.title}
                    </div>

                    {meta ? (
                      <div className="mt-2 text-[11px] text-white/55 truncate">{meta}</div>
                    ) : (
                      <div className="mt-2 h-[16px]" />
                    )}

                    <div className="mt-3 flex flex-wrap gap-2">
                      {x.mulebuy ? (
                        <a
                          href={x.mulebuy}
                          target="_blank"
                          rel="nofollow noreferrer"
                          onClick={(e) => e.stopPropagation()}
                          className="inline-flex items-center justify-center h-9 px-3 rounded-full text-xs font-semibold border border-white/15 bg-gradient-to-r from-violet-300/90 to-emerald-200/90 text-black hover:brightness-105 transition"
                        >
                          MuleBuy
                        </a>
                      ) : null}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
