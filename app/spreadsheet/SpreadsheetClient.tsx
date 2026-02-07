// app/spreadsheet/SpreadsheetClient.tsx
"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { toUsFansProductUrl, toMulebuyProductUrl } from "../../data/affiliate";

type SheetItem = {
  id?: string;
  slug?: string;
  title?: string;

  brand?: string;
  category?: string;
  seller?: string;

  images?: string[];
  pics?: string[];

  img1?: string;
  img2?: string;
  img3?: string;
  img4?: string;
  img5?: string;
  img6?: string;
  img7?: string;
  img8?: string;
  img_extra?: string;

  source_url?: string;

  usfans?: string;
  usfans_link?: string;
  usfans_url?: string;

  mulebuy?: string;
  mulebuy_link?: string;
  mulebuy_url?: string;

  price_eur?: number | null;

  [key: string]: any;
};

type SortMode = "default" | "price_desc" | "price_asc";

function norm(s: string) {
  return (s ?? "")
    .toString()
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

/** ✅ evita "filtri fantasma": "" | null | undefined -> "all" */
function cleanFilter(v: any) {
  const s = (v ?? "").toString().trim();
  return s ? s : "all";
}

function normalizeSlug(s: string) {
  return norm(s).replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function isValidUrl(v: any) {
  return typeof v === "string" && /^https?:\/\//i.test(v.trim());
}

function pickTitle(x: SheetItem) {
  return x?.title?.trim() ? x.title.trim() : "Articolo";
}

function normalizeImgUrl(u: string) {
  const raw = (u ?? "").trim();
  if (!raw) return "";
  try {
    const url = new URL(raw);
    url.search = "";
    url.hash = "";
    return (url.origin + url.pathname).toLowerCase();
  } catch {
    return raw.split("#")[0].split("?")[0].toLowerCase();
  }
}

function pickPics(x: SheetItem) {
  const out: string[] = [];
  const push = (v: any) => {
    if (typeof v === "string" && v.trim()) out.push(v.trim());
  };

  const a = Array.isArray(x.images) ? x.images : [];
  const b = Array.isArray(x.pics) ? x.pics : [];
  const base = a.length ? a : b;
  for (const v of base) push(v);

  for (let i = 1; i <= 8; i++) push((x as any)[`img${i}`]);

  const extra =
    (x as any).img_extra ?? (x as any).images_extra ?? (x as any).extra_images;

  if (typeof extra === "string" && extra.trim()) {
    extra
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .forEach((s) => push(s));
  } else if (Array.isArray(extra)) {
    extra.forEach(push);
  }

  const seen = new Set<string>();
  return out.filter((u) => {
    if (!u) return false;
    const k = normalizeImgUrl(u);
    if (!k) return false;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function pickCover(x: SheetItem) {
  // 1) PRIORITÀ ASSOLUTA: img1 esplicita (colonna G in sheet)
  const explicit = (x.img1 ?? (x as any).cover ?? "").toString().trim();
  if (explicit) return explicit;

  // 2) fallback: prima immagine disponibile (ordine dello scraper)
  const pics = pickPics(x);
  return pics[0] ?? "";
}


function findFirstSourceUrl(item: SheetItem) {
  if (isValidUrl(item?.source_url)) return item.source_url!.trim();

  for (const [, v] of Object.entries(item)) {
    if (!isValidUrl(v)) continue;
    const s = (v as string).toLowerCase();
    if (
      s.includes("taobao.com") ||
      s.includes("tmall.com") ||
      s.includes("weidian.com")
    ) {
      return (v as string).trim();
    }
  }
  return "";
}

function getDirectAgentUrl(item: SheetItem, agent: "usfans" | "mulebuy") {
  const keys =
    agent === "usfans"
      ? ["usfans", "usfansLink", "usfans_link", "usfansUrl", "usfans_url"]
      : ["mulebuy", "mulebuyLink", "mulebuy_link", "mulebuyUrl", "mulebuy_url"];

  const domainCheck =
    agent === "usfans"
      ? (s: string) => s.includes("usfans.com")
      : (s: string) => s.includes("mulebuy.com");

  for (const k of keys) {
    const v = item?.[k];
    if (!isValidUrl(v)) continue;
    const s = (v as string).toLowerCase();
    if (domainCheck(s)) return (v as string).trim();
  }

  for (const [, v] of Object.entries(item)) {
    if (!isValidUrl(v)) continue;
    const s = (v as string).toLowerCase();
    if (domainCheck(s)) return (v as string).trim();
  }

  return "";
}

function buildUsFansLink(item: SheetItem) {
  const direct = getDirectAgentUrl(item, "usfans");
  if (direct) return direct;

  const source = findFirstSourceUrl(item);
  if (!source) return "";

  return toUsFansProductUrl(source) ?? "";
}

function buildMulebuyLink(item: SheetItem) {
  const direct = getDirectAgentUrl(item, "mulebuy");
  if (direct) return direct;

  const source = findFirstSourceUrl(item);
  if (!source) return "";

  return toMulebuyProductUrl(source) ?? "";
}

function formatEur(n: number) {
  return `€ ${n.toFixed(2)}`;
}

function proxMaybe(u: string) {
  const raw = (u ?? "").trim();
  if (!raw) return "";
  if (raw.startsWith("data:")) return raw;
  if (raw.includes("/api/img?url=")) return raw;
  return `/api/img?url=${encodeURIComponent(raw)}`;
}

/**
 * ✅ PERFORMANCE: nelle griglie usiamo versioni più leggere delle foto Yupoo.
 * (di solito esistono /medium.* e /small.* oltre a /big.*)
 */
function yupooListSize(u: string, size: "medium" | "small" = "medium") {
  const raw = (u ?? "").trim();
  if (!raw) return "";

  // se già proxata, non tocchiamo (evitiamo doppie encode)
  if (raw.includes("/api/img?url=")) return raw;

  try {
    const url = new URL(raw);
    const host = url.hostname.toLowerCase();
    if (!host.includes("yupoo.com")) return raw;

    // sostituisci solo se termina con /big.<ext>
    url.pathname = url.pathname.replace(/\/big\.(jpg|jpeg|png|webp)$/i, `/${size}.$1`);
    return url.toString();
  } catch {
    return raw;
  }
}

/** ✅ seed forte (evita collisioni) */
function makeShuffleSeed() {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

const chipBase =
  "inline-flex items-center justify-center h-7 px-2.5 rounded-full border border-white/10 bg-white/[0.04] hover:bg-white/[0.07] text-[11px] text-white/80 transition whitespace-nowrap";

function FilterChip({ label, onClear }: { label: string; onClear: () => void }) {
  return (
    <button
      type="button"
      onClick={onClear}
      className={chipBase}
      title="Rimuovi filtro"
    >
      <span className="whitespace-nowrap">{label}</span>
      <span className="ml-1 text-white/45 hover:text-white/80">×</span>
    </button>
  );
}

function AgentButton({
  href,
  label,
  accent = false,
}: {
  href?: string;
  label: string;
  accent?: boolean;
}) {
  const disabled = !href;

  return (
    <a
      href={disabled ? undefined : href}
      target={disabled ? undefined : "_blank"}
      rel={disabled ? undefined : "nofollow noreferrer"}
      aria-disabled={disabled}
      tabIndex={disabled ? -1 : 0}
      onClick={(e) => e.stopPropagation()}
      className={[
        "inline-flex items-center justify-center h-9 px-3 rounded-full text-xs font-semibold border transition",
        disabled
          ? "opacity-40 cursor-not-allowed border-white/10 bg-white/5"
          : accent
          ? "border-white/15 bg-gradient-to-r from-violet-300/90 to-emerald-200/90 text-black hover:brightness-105"
          : "border-white/15 bg-white/10 text-white/90 hover:bg-white/12 hover:border-white/25",
      ].join(" ")}
      title={disabled ? "Link non disponibile" : label}
    >
      {label}
    </a>
  );
}

/** ✅ Shuffle icon stile Spotify */
function ShuffleIcon({ className = "h-4 w-4" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className={className} fill="none">
      <path
        d="M3 7h4.5c1.2 0 2.3.5 3.1 1.3l2.1 2.1"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M3 17h4.5c1.2 0 2.3-.5 3.1-1.3l2.1-2.1"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />

      <path
        d="M14 7h3.5c.6 0 1.1.2 1.5.6L21 9.5"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M21 9.5V6"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M21 9.5h-3.5"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />

      <path
        d="M14 17h3.5c.6 0 1.1.2 1.5-.6L21 14.5"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M21 14.5V18"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M21 14.5h-3.5"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export default function SpreadsheetClient({
  items,
  page,
  totalPages,
  totalItems,
  pageSize, // compat
  facets,
  initialFilters,
}: {
  items: SheetItem[];
  page: number;
  totalPages: number;
  totalItems: number;
  pageSize: number;
  facets: { brands: string[]; categories: string[]; sellers: string[] };
  initialFilters: {
    q: string;
    brand: string;
    category: string;
    seller: string;
    order: "default" | "random";
  };
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const inputRef = useRef<HTMLInputElement | null>(null);

  const [q, setQ] = useState(initialFilters?.q ?? "");
  const [sellerFilter, setSellerFilter] = useState<string>(
    cleanFilter(initialFilters?.seller)
  );
  const [brandFilter, setBrandFilter] = useState<string>(
    cleanFilter(initialFilters?.brand)
  );
  const [categoryFilter, setCategoryFilter] = useState<string>(
    cleanFilter(initialFilters?.category)
  );
  const [sortMode, setSortMode] = useState<SortMode>("default");
  const [showTop, setShowTop] = useState(false);

  const order: "default" | "random" =
    searchParams?.get("order") === "default" ? "default" : "random";
  const shuffleKey = searchParams?.get("shuffle") ?? "";

  /** ✅ se sei in random ma manca shuffle: genera seed e sostituisci URL */
  useEffect(() => {
    if (order === "random" && !shuffleKey) {
      const params = new URLSearchParams(searchParams?.toString() ?? "");
      params.set("order", "random");
      params.set("shuffle", makeShuffleSeed());
      router.replace(`/spreadsheet?${params.toString()}`);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [order, shuffleKey]);

  useEffect(() => {
    setQ(initialFilters?.q ?? "");
    setSellerFilter(cleanFilter(initialFilters?.seller));
    setBrandFilter(cleanFilter(initialFilters?.brand));
    setCategoryFilter(cleanFilter(initialFilters?.category));
  }, [
    initialFilters?.q,
    initialFilters?.seller,
    initialFilters?.brand,
    initialFilters?.category,
  ]);

  const qTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  function buildHref(
    nextPage: number,
    next?: Partial<{ q: string; seller: string; brand: string; category: string }>
  ) {
    const params = new URLSearchParams();

    const qv = (next?.q ?? q).trim();
    const sv = (next?.seller ?? sellerFilter).trim();
    const bv = (next?.brand ?? brandFilter).trim();
    const cv = (next?.category ?? categoryFilter).trim();

    if (nextPage > 1) params.set("page", String(nextPage));

    if (order === "default") params.set("order", "default");
    else {
      params.set("order", "random");
      // ✅ GARANTISCI che lo shuffle esista sempre in random
      params.set("shuffle", shuffleKey || makeShuffleSeed());
    }

    if (qv) params.set("q", qv);
    if (sv && sv !== "all") params.set("seller", sv);
    if (bv && bv !== "all") params.set("brand", bv);
    if (cv && cv !== "all") params.set("category", cv);

    const qs = params.toString();
    return qs ? `/spreadsheet?${qs}` : "/spreadsheet";
  }

  function go(
    nextPage: number,
    next?: Partial<{ q: string; seller: string; brand: string; category: string }>
  ) {
    router.push(buildHref(nextPage, next));
  }

  function scheduleSearch(nextQ: string) {
    if (qTimer.current) clearTimeout(qTimer.current);
    qTimer.current = setTimeout(() => {
      go(1, { q: nextQ });
    }, 350);
  }

  function resetFiltersKeepOrder() {
    if (qTimer.current) clearTimeout(qTimer.current);
    qTimer.current = null;

    setQ("");
    setSellerFilter("all");
    setBrandFilter("all");
    setCategoryFilter("all");
    setSortMode("default");

    const params = new URLSearchParams();
    if (order === "default") {
      params.set("order", "default");
    } else {
      params.set("order", "random");
      params.set("shuffle", shuffleKey || makeShuffleSeed());
    }

    const qs = params.toString();
    router.push(qs ? `/spreadsheet?${qs}` : "/spreadsheet");
  }

  /** ✅ back link: passa al dettaglio l’intera query del catalogo */
  const backQS = searchParams?.toString() ?? "";
  const backParam = backQS ? `?back=${encodeURIComponent(backQS)}` : "";
  function itemHref(slug: string) {
    return `/item/${encodeURIComponent(slug)}${backParam}`;
  }

  const baseList = useMemo(() => {
    return (items ?? []).map((it, idx) => {
      const title = pickTitle(it);
      const base = normalizeSlug(it.slug ?? it.id ?? title ?? String(idx));
      const cover = pickCover(it);

      const usfans = buildUsFansLink(it);
      const mulebuy = buildMulebuyLink(it);

      const priceRaw = (it as any)?.price_eur;
      const price =
        typeof priceRaw === "number" && Number.isFinite(priceRaw)
          ? (priceRaw as number)
          : null;

      return {
        idx,
        title,
        baseSlug: base || String(idx),
        cover,
        seller: (it.seller ?? "").trim(),
        brand: ((it as any)?.brand ?? "").toString().trim(),
        category: (it.category ?? "").trim(),
        price,
        usfans,
        mulebuy,
      };
    });
  }, [items]);

  const normalized = useMemo(() => {
    const count = new Map<string, number>();
    for (const x of baseList)
      count.set(x.baseSlug, (count.get(x.baseSlug) ?? 0) + 1);

    return baseList.map((x) => {
      const dup = (count.get(x.baseSlug) ?? 0) > 1;
      const slug = dup ? `${x.baseSlug}-${x.idx}` : x.baseSlug;
      return { ...x, slug };
    });
  }, [baseList]);

  const sellers = useMemo(() => facets?.sellers ?? [], [facets?.sellers]);
  const brands = useMemo(() => facets?.brands ?? [], [facets?.brands]);
  const categories = useMemo(
    () => facets?.categories ?? [],
    [facets?.categories]
  );

  /** ✅ ora NON shuffliamo più lato client: lo fa il server (globale) */
  const filtered = useMemo(() => {
    let out = normalized;

    if (sortMode !== "default") {
      out = [...out].sort((a, b) => {
        const pa = a.price;
        const pb = b.price;
        if (pa == null && pb == null) return 0;
        if (pa == null) return 1;
        if (pb == null) return -1;
        return sortMode === "price_desc" ? pb - pa : pa - pb;
      });
    }

    return out;
  }, [normalized, sortMode]);

  const hasFilters =
    q.trim().length > 0 ||
    sellerFilter !== "all" ||
    brandFilter !== "all" ||
    categoryFilter !== "all" ||
    sortMode !== "default";

  const sortLabel =
    sortMode === "price_desc"
      ? "Prezzo ↓"
      : sortMode === "price_asc"
      ? "Prezzo ↑"
      : "";

  const container = "mx-auto w-full max-w-[1600px] px-5";

  function shuffleNow() {
    const params = new URLSearchParams();
    params.set("order", "random");
    params.set("shuffle", makeShuffleSeed());

    const qv = (q ?? "").trim();
    const sv = (sellerFilter ?? "").trim();
    const bv = (brandFilter ?? "").trim();
    const cv = (categoryFilter ?? "").trim();

    if (qv) params.set("q", qv);
    if (sv && sv !== "all") params.set("seller", sv);
    if (bv && bv !== "all") params.set("brand", bv);
    if (cv && cv !== "all") params.set("category", cv);

    router.push(`/spreadsheet?${params.toString()}`);
  }

  /** ✅ Reset “vero”: torna a random ma con seed nuovo (niente seed0) */
  function resetAll() {
    if (qTimer.current) clearTimeout(qTimer.current);
    qTimer.current = null;

    setQ("");
    setSellerFilter("all");
    setBrandFilter("all");
    setCategoryFilter("all");
    setSortMode("default");

    const seed = makeShuffleSeed();
    router.push(`/spreadsheet?order=random&shuffle=${seed}`);
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "/" && !(e.metaKey || e.ctrlKey || e.altKey)) {
        e.preventDefault();
        inputRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    const onScroll = () => setShowTop(window.scrollY > 800);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  const hrefBase = {
    q: initialFilters?.q ?? "",
    seller: cleanFilter(initialFilters?.seller),
    brand: cleanFilter(initialFilters?.brand),
    category: cleanFilter(initialFilters?.category),
  };

  const prevHref = page > 1 ? buildHref(page - 1, hrefBase) : null;
  const nextHref = page < totalPages ? buildHref(page + 1, hrefBase) : null;

  const totalLabel = hasFilters ? "Risultati" : "Totale";

  const selectClass =
    "h-9 rounded-full px-3 bg-white/5 border border-white/10 text-[12px] text-white/90 outline-none focus:border-white/25";
  const btnCompact =
    "h-9 px-3 rounded-full border border-white/10 bg-white/5 hover:bg-white/8 text-[12px] text-white/85 transition leading-none whitespace-nowrap";

  const noResults = filtered.length === 0;

  const shufflePrimaryClass = [
    "h-9 px-3.5 rounded-full inline-flex items-center gap-2",
    "border border-white/15",
    "bg-gradient-to-r from-violet-300/90 to-emerald-200/90",
    "text-black font-semibold",
    "hover:brightness-105 active:brightness-95",
    "shadow-[0_14px_60px_rgba(160,140,255,0.18)]",
    "transition",
    "whitespace-nowrap",
  ].join(" ");

  const pagerClass =
    "flex items-center h-11 rounded-full border border-white/10 bg-black/45 backdrop-blur-xl overflow-hidden shadow-[0_20px_90px_rgba(0,0,0,0.45)]";

  return (
    <div className="min-h-screen w-full">
      {/* STICKY TOP */}
      <div className="sticky top-0 z-50 border-b border-white/10 bg-black/55 backdrop-blur-xl">
        <div className={`${container} pt-6 pb-4 md:pt-7 md:pb-5`}>
          {/* ROW A */}
          <div className="relative flex items-center justify-center">
            <Link
              href="/"
              className={`${chipBase} absolute left-0 top-1/2 -translate-y-1/2`}
              title="Home"
            >
              ← Home
            </Link>

            <div className="relative w-full max-w-[780px] px-12 md:px-0">
              <input
                ref={inputRef}
                value={q}
                onChange={(e) => {
                  const v = e.target.value;
                  if (!v.trim()) {
                    resetFiltersKeepOrder();
                    return;
                  }
                  setQ(v);
                  scheduleSearch(v);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    e.preventDefault();
                    resetFiltersKeepOrder();
                  }
                  if (e.key === "Enter") {
                    go(1, { q });
                  }
                }}
                placeholder="Cerca (brand, seller, categoria, titolo)…"
                className="h-10 md:h-11 w-full rounded-full px-4 pr-10 bg-white/5 border border-white/10 text-sm text-white/90 outline-none focus:border-white/25"
              />
              {q && (
                <button
                  type="button"
                  onClick={resetFiltersKeepOrder}
                  className="absolute right-3 top-1/2 -translate-y-1/2 h-7 w-7 rounded-full border border-white/10 bg-white/5 hover:bg-white/10 text-white/70 text-sm transition"
                  title="Svuota"
                >
                  ×
                </button>
              )}
            </div>
          </div>

          {/* ROW B */}
          <div className="mt-4 flex justify-center">
            <div className="w-full max-w-[1200px] flex flex-wrap items-center justify-center gap-2">
              <select
                value={sortMode}
                onChange={(e) => setSortMode(e.target.value as SortMode)}
                style={{ colorScheme: "dark" }}
                className={`${selectClass} w-[170px] md:w-[190px]`}
              >
                <option value="default">Ordina</option>
                <option value="price_desc">Prezzo ↓</option>
                <option value="price_asc">Prezzo ↑</option>
              </select>

              <select
                value={sellerFilter}
                onChange={(e) => {
                  const v = e.target.value;
                  setSellerFilter(v);
                  go(1, { seller: v });
                }}
                style={{ colorScheme: "dark" }}
                className={`${selectClass} w-[170px] md:w-[190px]`}
              >
                <option value="all">Seller: Tutti</option>
                {sellers.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>

              <select
                value={brandFilter}
                onChange={(e) => {
                  const v = e.target.value;
                  setBrandFilter(v);
                  go(1, { brand: v });
                }}
                style={{ colorScheme: "dark" }}
                className={`${selectClass} w-[170px] md:w-[190px]`}
              >
                <option value="all">Brand: Tutti</option>
                {brands.map((b) => (
                  <option key={b} value={b}>
                    {b}
                  </option>
                ))}
              </select>

              <select
                value={categoryFilter}
                onChange={(e) => {
                  const v = e.target.value;
                  setCategoryFilter(v);
                  go(1, { category: v });
                }}
                style={{ colorScheme: "dark" }}
                className={`${selectClass} w-[170px] md:w-[190px]`}
              >
                <option value="all">Categoria: Tutte</option>
                {categories.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>

              <button
                type="button"
                onClick={resetAll}
                className={[
                  btnCompact,
                  hasFilters
                    ? "border-white/12 bg-white/[0.06]"
                    : "opacity-55 hover:opacity-80",
                ].join(" ")}
                title="Pulisci filtri"
              >
                Reset
              </button>
            </div>
          </div>

          {/* ROW C */}
          {hasFilters ? (
            <div className="mt-3 flex justify-center">
              <div className="w-full max-w-[1200px] flex items-center gap-2 overflow-x-auto whitespace-nowrap px-1 [-webkit-overflow-scrolling:touch]">
                {q.trim() ? (
                  <FilterChip
                    label={`Ricerca: ${q.trim()}`}
                    onClear={resetFiltersKeepOrder}
                  />
                ) : null}

                {sellerFilter !== "all" ? (
                  <FilterChip
                    label={`Seller: ${sellerFilter}`}
                    onClear={() => {
                      setSellerFilter("all");
                      go(1, { seller: "all" });
                    }}
                  />
                ) : null}

                {brandFilter !== "all" ? (
                  <FilterChip
                    label={`Brand: ${brandFilter}`}
                    onClear={() => {
                      setBrandFilter("all");
                      go(1, { brand: "all" });
                    }}
                  />
                ) : null}

                {categoryFilter !== "all" ? (
                  <FilterChip
                    label={`Categoria: ${categoryFilter}`}
                    onClear={() => {
                      setCategoryFilter("all");
                      go(1, { category: "all" });
                    }}
                  />
                ) : null}

                {sortMode !== "default" ? (
                  <FilterChip
                    label={sortLabel}
                    onClear={() => setSortMode("default")}
                  />
                ) : null}
              </div>
            </div>
          ) : (
            <div className="mt-3 text-center text-[11px] text-white/45">
              Tip: premi <span className="text-white/70 font-semibold">/</span>{" "}
              per cercare
            </div>
          )}

          {/* ROW D */}
          <div className="mt-4 flex items-center justify-between gap-2">
            <div className="text-[12px] text-white/55">
              {totalLabel}:{" "}
              <span className="text-white/90 font-semibold">{totalItems}</span>
              <span className="ml-3 text-white/35">
                Pag {page}/{totalPages}
              </span>
            </div>

            <div className="flex items-center gap-2 shrink-0">
              <button
                type="button"
                onClick={shuffleNow}
                className={shufflePrimaryClass}
                title="Mischia articoli"
              >
                <ShuffleIcon className="h-[18px] w-[18px]" />
                Shuffle
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* GRID + PAGINAZIONE BOTTOM */}
      <div className={`${container} pt-6 pb-14`}>
        {noResults ? (
          <div className="mx-auto max-w-[520px] text-center rounded-3xl border border-white/10 bg-white/[0.04] p-8">
            <div className="text-white/90 font-semibold text-lg">
              Nessun risultato
            </div>
            <div className="mt-2 text-sm text-white/55">
              Prova a cambiare filtri o cercare un termine diverso.
            </div>

            <div className="mt-5 flex items-center justify-center gap-2">
              <button
                onClick={resetAll}
                className="inline-flex items-center justify-center h-10 px-5 rounded-full border border-white/10 bg-white/5 hover:bg-white/8 text-sm text-white/85 transition leading-none"
              >
                Reset filtri
              </button>

              <button
                onClick={() => inputRef.current?.focus()}
                className="inline-flex items-center justify-center h-10 px-5 rounded-full border border-white/10 bg-white/5 hover:bg-white/8 text-sm text-white/85 transition leading-none"
              >
                Cerca
              </button>
            </div>
          </div>
        ) : (
          <>
            <div className="grid gap-4 grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
              {filtered.map((x) => {
                const meta = [x.seller, x.category].filter(Boolean).join(" • ");
                return (
                  <div
                    key={x.slug}
                    role="link"
                    tabIndex={0}
                    onMouseEnter={() => router.prefetch(itemHref(x.slug))}
                    onFocus={() => router.prefetch(itemHref(x.slug))}
                    onClick={() => router.push(itemHref(x.slug))}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        router.push(itemHref(x.slug));
                      }
                    }}
                    className={[
                      "relative group cursor-pointer rounded-3xl border border-white/10 bg-white/[0.04] overflow-hidden cv-auto",
                      "shadow-[0_40px_140px_rgba(0,0,0,0.55)] transition",
                      "hover:border-white/20 hover:bg-white/[0.06] hover:-translate-y-[2px]",
                      "focus:outline-none focus:ring-2 focus:ring-white/20",
                    ].join(" ")}
                  >
                    <div
                      className="absolute inset-0 opacity-0 group-hover:opacity-100 transition duration-300 pointer-events-none"
                      style={{
                        background:
                          "radial-gradient(900px circle at 20% -10%, rgba(255,255,255,0.12), transparent 55%), radial-gradient(650px circle at 80% 0%, rgba(160,140,255,0.14), transparent 55%)",
                      }}
                    />

                    <div className="relative w-full aspect-[4/3] bg-black/20 overflow-hidden">
                      {x.cover ? (
                        <img
                          src={proxMaybe(yupooListSize(x.cover))}
                          alt={x.title}
                          className="w-full h-full object-cover transition-transform duration-300 group-hover:scale-[1.04]"
                          draggable={false}
                          loading="lazy"
                          decoding="async"
                        />
                      ) : (
                        <div className="w-full h-full flex items-center justify-center text-white/30 text-sm">
                          No image
                        </div>
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
                        <div className="mt-2 text-[11px] text-white/55 truncate">
                          {meta}
                        </div>
                      ) : (
                        <div className="mt-2 h-[16px]" />
                      )}

                      <div className="mt-3 flex flex-wrap gap-2">
                        <AgentButton href={x.usfans || undefined} label="USFans" accent />
                        <AgentButton href={x.mulebuy || undefined} label="MuleBuy" />
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>

            {totalPages > 1 ? (
              <div className="mt-10 flex justify-center">
                <div className={pagerClass}>
                  <Link
                    aria-disabled={!prevHref}
                    tabIndex={prevHref ? 0 : -1}
                    href={prevHref ?? "#"}
                    className={[
                      "h-11 w-12 inline-flex items-center justify-center transition",
                      prevHref
                        ? "text-white/85 hover:bg-white/8"
                        : "text-white/35 pointer-events-none",
                    ].join(" ")}
                    title="Pagina precedente"
                  >
                    ←
                  </Link>

                  <div className="px-4 h-11 inline-flex items-center text-[12px] text-white/70 whitespace-nowrap border-x border-white/10">
                    Pag {page}/{totalPages}
                  </div>

                  <Link
                    aria-disabled={!nextHref}
                    tabIndex={nextHref ? 0 : -1}
                    href={nextHref ?? "#"}
                    className={[
                      "h-11 w-12 inline-flex items-center justify-center transition",
                      nextHref
                        ? "text-white/85 hover:bg-white/8"
                        : "text-white/35 pointer-events-none",
                    ].join(" ")}
                    title="Pagina successiva"
                  >
                    →
                  </Link>
                </div>
              </div>
            ) : null}
          </>
        )}
      </div>

      {showTop && (
        <button
          onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}
          className="fixed bottom-6 right-6 z-40 inline-flex items-center justify-center h-11 px-4 rounded-full border border-white/10 bg-black/55 backdrop-blur-xl hover:bg-black/70 text-sm text-white/85 transition leading-none"
          title="Torna su"
        >
          ↑ Su
        </button>
      )}
    </div>
  );
}
