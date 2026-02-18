"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { toUsFansProductUrl, toMulebuyProductUrl } from "../../data/affiliate";
import { imgProxy, type ImgSize } from "@/src/lib/imgProxy";

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
type PickerKind = "sort" | "seller" | "brand" | "category";

function norm(s: string) {
  return (s ?? "")
    .toString()
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

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

  const extra = (x as any).img_extra ?? (x as any).images_extra ?? (x as any).extra_images;

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
  const explicit = (x.img1 ?? (x as any).cover ?? "").toString().trim();
  if (explicit) return explicit;
  const pics = pickPics(x);
  return pics[0] ?? "";
}

function findFirstSourceUrl(item: SheetItem) {
  if (isValidUrl(item?.source_url)) return item.source_url!.trim();

  for (const [, v] of Object.entries(item)) {
    if (!isValidUrl(v)) continue;
    const s = (v as string).toLowerCase();
    if (s.includes("taobao.com") || s.includes("tmall.com") || s.includes("weidian.com")) {
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
    agent === "usfans" ? (s: string) => s.includes("usfans.com") : (s: string) => s.includes("mulebuy.com");

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

/**
 * ✅ Helpers immagini: forziamo proxy + size=small in LISTA (spreadsheet)
 */
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

function makeShuffleSeed() {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

const chipBase =
  "inline-flex items-center justify-center h-8 sm:h-7 px-3 sm:px-2.5 rounded-full border border-white/10 bg-white/[0.04] hover:bg-white/[0.07] text-[12px] sm:text-[11px] text-white/80 transition whitespace-nowrap";

function FilterChip({ label, onClear }: { label: string; onClear: () => void }) {
  return (
    <button type="button" onClick={onClear} className={chipBase} title="Rimuovi filtro">
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

function ChevronDown({ className = "h-4 w-4" }: { className?: string }) {
  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden="true" className={className}>
      <path
        d="M5 7.5l5 5 5-5"
        stroke="currentColor"
        strokeWidth="1.8"
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
  pageSize,
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
  const [sellerFilter, setSellerFilter] = useState<string>(cleanFilter(initialFilters?.seller));
  const [brandFilter, setBrandFilter] = useState<string>(cleanFilter(initialFilters?.brand));
  const [categoryFilter, setCategoryFilter] = useState<string>(cleanFilter(initialFilters?.category));
  const [sortMode, setSortMode] = useState<SortMode>("default");
  const [showTop, setShowTop] = useState(false);

  // ✅ mobile UX
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState<PickerKind | null>(null);
  const [pickerQuery, setPickerQuery] = useState("");

  const order: "default" | "random" = searchParams?.get("order") === "default" ? "default" : "random";
  const shuffleKey = searchParams?.get("shuffle") ?? "";

  // ✅ FIX DIGITAZIONE MOBILE (iOS/Android): composition + non clobberare q mentre scrivi
  const composingRef = useRef(false);
  const ignoreNextChangeRef = useRef(false);
  const pendingQRef = useRef<string | null>(null);
  const lastEditAtRef = useRef(0);

  const qTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  function buildHref(nextPage: number, next?: Partial<{ q: string; seller: string; brand: string; category: string }>) {
    const params = new URLSearchParams();

    const qv = (next?.q ?? q).trim();
    const sv = (next?.seller ?? sellerFilter).trim();
    const bv = (next?.brand ?? brandFilter).trim();
    const cv = (next?.category ?? categoryFilter).trim();

    if (nextPage > 1) params.set("page", String(nextPage));

    if (order === "default") params.set("order", "default");
    else {
      params.set("order", "random");
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
    next?: Partial<{ q: string; seller: string; brand: string; category: string }>,
    mode: "push" | "replace" = "push"
  ) {
    const href = buildHref(nextPage, next);
    if (mode === "replace") router.replace(href);
    else router.push(href);
  }

  function clearQuery() {
    if (qTimer.current) clearTimeout(qTimer.current);
    qTimer.current = null;
    setQ("");
    go(1, { q: "" }, "replace"); // ✅ non sporcate history durante typing
  }

  function scheduleSearch(nextQ: string) {
    if (composingRef.current) {
      pendingQRef.current = nextQ;
      return;
    }

    if (qTimer.current) clearTimeout(qTimer.current);
    qTimer.current = setTimeout(() => {
      go(1, { q: nextQ }, "replace"); // ✅ replace: niente history + meno jank
    }, 350);
  }

  function resetFiltersKeepOrder(mode: "push" | "replace" = "replace") {
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
    const href = qs ? `/spreadsheet?${qs}` : "/spreadsheet";
    if (mode === "replace") router.replace(href);
    else router.push(href);
  }

  useEffect(() => {
    if (order === "random" && !shuffleKey) {
      const params = new URLSearchParams(searchParams?.toString() ?? "");
      params.set("order", "random");
      params.set("shuffle", makeShuffleSeed());
      router.replace(`/spreadsheet?${params.toString()}`);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [order, shuffleKey]);

  // sync da server → state (MA non sovrascrivere q mentre l'utente sta scrivendo)
  useEffect(() => {
    const now = Date.now();
    const isFocused = typeof document !== "undefined" && document.activeElement === inputRef.current;
    const recentlyEdited = now - lastEditAtRef.current < 900;

    if (!(isFocused && recentlyEdited)) {
      setQ(initialFilters?.q ?? "");
    }

    setSellerFilter(cleanFilter(initialFilters?.seller));
    setBrandFilter(cleanFilter(initialFilters?.brand));
    setCategoryFilter(cleanFilter(initialFilters?.category));
  }, [initialFilters?.q, initialFilters?.seller, initialFilters?.brand, initialFilters?.category]);

  // lock scroll quando la bottom-sheet è aperta
  useEffect(() => {
    if (!pickerOpen) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [pickerOpen]);

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
      const price = typeof priceRaw === "number" && Number.isFinite(priceRaw) ? priceRaw : null;

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
    for (const x of baseList) count.set(x.baseSlug, (count.get(x.baseSlug) ?? 0) + 1);

    return baseList.map((x) => {
      const dup = (count.get(x.baseSlug) ?? 0) > 1;
      const slug = dup ? `${x.baseSlug}-${x.idx}` : x.baseSlug;
      return { ...x, slug };
    });
  }, [baseList]);

  const sellers = useMemo(() => facets?.sellers ?? [], [facets?.sellers]);
  const brands = useMemo(() => facets?.brands ?? [], [facets?.brands]);
  const categories = useMemo(() => facets?.categories ?? [], [facets?.categories]);

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

  const sortLabel = sortMode === "price_desc" ? "Prezzo ↓" : sortMode === "price_asc" ? "Prezzo ↑" : "";

  const container = "mx-auto w-full max-w-[1700px] px-4 sm:px-5";

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
    "h-10 sm:h-9 px-4 sm:px-3.5 rounded-full inline-flex items-center justify-center gap-2",
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

  // ✅ mobile
  const mobileWrap = "sm:hidden mx-auto w-full max-w-[520px]";
  const navCircle =
    "h-10 w-10 rounded-full border border-white/10 bg-white/[0.04] hover:bg-white/[0.07] text-white/85 inline-flex items-center justify-center transition";

  // ✅ iOS fix: input font-size >= 16px (anti-zoom + typing jank)
  const searchInput =
    "h-10 w-full rounded-full pl-4 pr-10 bg-white/5 border border-white/10 text-[16px] text-white/90 outline-none focus:border-white/25";

  const pillSecondary =
    "h-10 w-full rounded-full border border-white/10 bg-white/5 hover:bg-white/8 text-[13px] text-white/85 transition inline-flex items-center justify-center";
  const panel =
    "rounded-3xl border border-white/10 bg-white/[0.03] shadow-[0_20px_90px_rgba(0,0,0,0.45)] overflow-hidden";
  const panelInner = "p-3";
  const pickerBtn =
    "h-11 w-full rounded-full px-3 bg-white/5 border border-white/10 text-[13px] text-white/90 outline-none hover:bg-white/7 transition flex items-center justify-between";
  const resetMobile =
    "h-11 w-full rounded-full border border-white/10 bg-white/5 hover:bg-white/8 text-[13px] text-white/85 transition inline-flex items-center justify-center";

  function openPicker(kind: PickerKind) {
    setPickerQuery("");
    setPickerOpen(kind);
  }

  function closePicker() {
    setPickerOpen(null);
    setPickerQuery("");
  }

  function labelFor(kind: PickerKind) {
    if (kind === "sort") return sortMode === "default" ? "Ordina" : sortLabel;
    if (kind === "seller") return sellerFilter === "all" ? "Seller: Tutti" : `Seller: ${sellerFilter}`;
    if (kind === "brand") return brandFilter === "all" ? "Brand: Tutti" : `Brand: ${brandFilter}`;
    return categoryFilter === "all" ? "Categoria: Tutte" : `Categoria: ${categoryFilter}`;
  }

  const pickerData = useMemo(() => {
    const base = { title: "", options: [] as Array<{ value: string; label: string }> };

    if (pickerOpen === "sort") {
      return {
        title: "Ordina",
        options: [
          { value: "default", label: "Ordina" },
          { value: "price_desc", label: "Prezzo ↓" },
          { value: "price_asc", label: "Prezzo ↑" },
        ],
      };
    }
    if (pickerOpen === "seller") {
      return {
        title: "Seller",
        options: [{ value: "all", label: "Seller: Tutti" }, ...sellers.map((s) => ({ value: s, label: s }))],
      };
    }
    if (pickerOpen === "brand") {
      return {
        title: "Brand",
        options: [{ value: "all", label: "Brand: Tutti" }, ...brands.map((b) => ({ value: b, label: b }))],
      };
    }
    if (pickerOpen === "category") {
      return {
        title: "Categoria",
        options: [{ value: "all", label: "Categoria: Tutte" }, ...categories.map((c) => ({ value: c, label: c }))],
      };
    }
    return base;
  }, [pickerOpen, sellers, brands, categories]);

  const pickerNeedsSearch = (pickerData?.options?.length ?? 0) > 12;

  const pickerFilteredOptions = useMemo(() => {
    const qn = norm(pickerQuery);
    if (!qn) return pickerData.options;
    return pickerData.options.filter((o) => norm(o.label).includes(qn));
  }, [pickerData.options, pickerQuery]);

  function pickerCurrentValue(kind: PickerKind) {
    if (kind === "sort") return sortMode;
    if (kind === "seller") return sellerFilter;
    if (kind === "brand") return brandFilter;
    return categoryFilter;
  }

  function applyPickerValue(kind: PickerKind, value: string) {
    if (kind === "sort") {
      setSortMode(value as SortMode);
      closePicker();
      return;
    }

    if (kind === "seller") {
      setSellerFilter(value);
      go(1, { seller: value }, "push");
      closePicker();
      return;
    }

    if (kind === "brand") {
      setBrandFilter(value);
      go(1, { brand: value }, "push");
      closePicker();
      return;
    }

    setCategoryFilter(value);
    go(1, { category: value }, "push");
    closePicker();
  }

  // shared handlers per input
  const onSearchChange = (v: string) => {
    lastEditAtRef.current = Date.now();
    setQ(v);

    if (ignoreNextChangeRef.current) {
      ignoreNextChangeRef.current = false;
      return;
    }

    if (composingRef.current) return;

    if (v.length === 0) {
      clearQuery();
      return;
    }

    scheduleSearch(v);
  };

  const onSearchCompositionStart = () => {
    composingRef.current = true;
  };

  const onSearchCompositionEnd = (e: React.CompositionEvent<HTMLInputElement>) => {
    composingRef.current = false;
    ignoreNextChangeRef.current = true;

    const v = e.currentTarget.value;
    pendingQRef.current = null;

    if (v.length === 0) clearQuery();
    else scheduleSearch(v);
  };

  const onSearchKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      if (q.trim()) clearQuery();
      else resetFiltersKeepOrder("replace");
    }
    if (e.key === "Enter") {
      go(1, { q }, "replace");
    }
  };

  return (
    <div className="min-h-screen w-full">
      {/* STICKY TOP */}
      <div className="sticky top-0 z-50 border-b border-white/10 bg-black/55 backdrop-blur-xl">
        <div className={`${container} pt-3 pb-3 sm:pt-7 sm:pb-5`}>
          {/* ✅ MOBILE HEADER */}
          <div className={mobileWrap}>
            <div className="grid grid-cols-[40px_1fr_40px] gap-2 items-center">
              <Link href="/" className={navCircle} title="Home" aria-label="Home">
                ←
              </Link>

              <div className="relative">
                <input
                  ref={inputRef}
                  value={q}
                  onChange={(e) => onSearchChange(e.target.value)}
                  onCompositionStart={onSearchCompositionStart}
                  onCompositionEnd={onSearchCompositionEnd}
                  onKeyDown={onSearchKeyDown}
                  placeholder="Cerca (brand, seller, categoria, titolo)…"
                  className={searchInput}
                  inputMode="search"
                  enterKeyHint="search"
                  autoCorrect="off"
                  autoCapitalize="none"
                  spellCheck={false}
                />

                {q && (
                  <button
                    type="button"
                    onClick={clearQuery}
                    className="absolute right-2 top-1/2 -translate-y-1/2 h-8 w-8 rounded-full border border-white/10 bg-white/5 hover:bg-white/10 text-white/70 text-sm transition"
                    title="Svuota"
                    aria-label="Svuota"
                  >
                    ×
                  </button>
                )}
              </div>

              <div className="h-10 w-10" aria-hidden="true" />
            </div>

            <div className="mt-2 grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => setFiltersOpen((v) => !v)}
                className={pillSecondary}
                title={filtersOpen ? "Chiudi filtri" : "Apri filtri"}
              >
                {filtersOpen ? "Chiudi filtri" : "Filtri"}
              </button>

              <button type="button" onClick={shuffleNow} className={shufflePrimaryClass} title="Mischia articoli">
                <ShuffleIcon className="h-[18px] w-[18px]" />
                Shuffle
              </button>
            </div>

            {filtersOpen && (
              <div className={`mt-3 ${panel}`}>
                <div className={panelInner}>
                  <div className="grid grid-cols-2 gap-2">
                    <button type="button" className={pickerBtn} onClick={() => openPicker("sort")}>
                      <span className="truncate">{labelFor("sort")}</span>
                      <span className="text-white/55">
                        <ChevronDown />
                      </span>
                    </button>

                    <button type="button" className={pickerBtn} onClick={() => openPicker("seller")}>
                      <span className="truncate">{labelFor("seller")}</span>
                      <span className="text-white/55">
                        <ChevronDown />
                      </span>
                    </button>

                    <button type="button" className={pickerBtn} onClick={() => openPicker("brand")}>
                      <span className="truncate">{labelFor("brand")}</span>
                      <span className="text-white/55">
                        <ChevronDown />
                      </span>
                    </button>

                    <button type="button" className={pickerBtn} onClick={() => openPicker("category")}>
                      <span className="truncate">{labelFor("category")}</span>
                      <span className="text-white/55">
                        <ChevronDown />
                      </span>
                    </button>

                    <button
                      type="button"
                      onClick={resetAll}
                      className={`col-span-2 ${resetMobile} ${hasFilters ? "border-white/12 bg-white/[0.06]" : "opacity-70"}`}
                      title="Pulisci filtri"
                    >
                      Reset
                    </button>
                  </div>
                </div>
              </div>
            )}

            {hasFilters ? (
              <div className="mt-3">
                <div className="flex items-center gap-2 overflow-x-auto whitespace-nowrap px-1 [-webkit-overflow-scrolling:touch]">
                  {q.trim() ? <FilterChip label={`Ricerca: ${q.trim()}`} onClear={clearQuery} /> : null}

                  {sellerFilter !== "all" ? (
                    <FilterChip
                      label={`Seller: ${sellerFilter}`}
                      onClear={() => {
                        setSellerFilter("all");
                        go(1, { seller: "all" }, "push");
                      }}
                    />
                  ) : null}

                  {brandFilter !== "all" ? (
                    <FilterChip
                      label={`Brand: ${brandFilter}`}
                      onClear={() => {
                        setBrandFilter("all");
                        go(1, { brand: "all" }, "push");
                      }}
                    />
                  ) : null}

                  {categoryFilter !== "all" ? (
                    <FilterChip
                      label={`Categoria: ${categoryFilter}`}
                      onClear={() => {
                        setCategoryFilter("all");
                        go(1, { category: "all" }, "push");
                      }}
                    />
                  ) : null}

                  {sortMode !== "default" ? <FilterChip label={sortLabel} onClear={() => setSortMode("default")} /> : null}
                </div>
              </div>
            ) : null}

            <div className="mt-3 flex items-center justify-between gap-2">
              <div className="text-[12px] text-white/55">
                {totalLabel}: <span className="text-white/90 font-semibold">{totalItems}</span>
              </div>
              <div className="text-[12px] text-white/35 whitespace-nowrap">
                Pag {page}/{totalPages}
              </div>
            </div>
          </div>

          {/* ✅ DESKTOP HEADER */}
          <div className="hidden sm:block">
            <div className="relative flex items-center justify-center">
              <Link
                href="/"
                className={`${chipBase} absolute left-0 top-1/2 -translate-y-1/2 hidden sm:inline-flex`}
                title="Home"
              >
                ← Home
              </Link>

              <div className="relative w-full max-w-[780px] px-10 sm:px-12 md:px-0">
                <input
                  ref={inputRef}
                  value={q}
                  onChange={(e) => onSearchChange(e.target.value)}
                  onCompositionStart={onSearchCompositionStart}
                  onCompositionEnd={onSearchCompositionEnd}
                  onKeyDown={onSearchKeyDown}
                  placeholder="Cerca (brand, seller, categoria, titolo)…"
                  className="h-11 w-full rounded-full px-4 pr-10 bg-white/5 border border-white/10 text-sm text-white/90 outline-none focus:border-white/25"
                  inputMode="search"
                  enterKeyHint="search"
                  autoCorrect="off"
                  autoCapitalize="none"
                  spellCheck={false}
                />

                {q && (
                  <button
                    type="button"
                    onClick={clearQuery}
                    className="absolute right-3 top-1/2 -translate-y-1/2 h-7 w-7 rounded-full border border-white/10 bg-white/5 hover:bg-white/10 text-white/70 text-sm transition"
                    title="Svuota"
                  >
                    ×
                  </button>
                )}
              </div>
            </div>

            <div className="mt-4 flex justify-center">
              <div className="w-full max-w-[1200px] flex flex-wrap items-center justify-center gap-2">
                <select
                  value={sortMode}
                  onChange={(e) => setSortMode(e.target.value as SortMode)}
                  style={{ colorScheme: "dark" }}
                  className={`${selectClass} w-[160px] sm:w-[170px] md:w-[190px]`}
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
                    go(1, { seller: v }, "push");
                  }}
                  style={{ colorScheme: "dark" }}
                  className={`${selectClass} w-[160px] sm:w-[170px] md:w-[190px]`}
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
                    go(1, { brand: v }, "push");
                  }}
                  style={{ colorScheme: "dark" }}
                  className={`${selectClass} w-[160px] sm:w-[170px] md:w-[190px]`}
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
                    go(1, { category: v }, "push");
                  }}
                  style={{ colorScheme: "dark" }}
                  className={`${selectClass} w-[160px] sm:w-[170px] md:w-[190px]`}
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
                    hasFilters ? "border-white/12 bg-white/[0.06]" : "opacity-55 hover:opacity-80",
                  ].join(" ")}
                  title="Pulisci filtri"
                >
                  Reset
                </button>
              </div>
            </div>

            {hasFilters ? (
              <div className="mt-3 flex justify-center">
                <div className="w-full max-w-[1200px] flex items-center gap-2 overflow-x-auto whitespace-nowrap px-1 [-webkit-overflow-scrolling:touch]">
                  {q.trim() ? <FilterChip label={`Ricerca: ${q.trim()}`} onClear={clearQuery} /> : null}

                  {sellerFilter !== "all" ? (
                    <FilterChip
                      label={`Seller: ${sellerFilter}`}
                      onClear={() => {
                        setSellerFilter("all");
                        go(1, { seller: "all" }, "push");
                      }}
                    />
                  ) : null}

                  {brandFilter !== "all" ? (
                    <FilterChip
                      label={`Brand: ${brandFilter}`}
                      onClear={() => {
                        setBrandFilter("all");
                        go(1, { brand: "all" }, "push");
                      }}
                    />
                  ) : null}

                  {categoryFilter !== "all" ? (
                    <FilterChip
                      label={`Categoria: ${categoryFilter}`}
                      onClear={() => {
                        setCategoryFilter("all");
                        go(1, { category: "all" }, "push");
                      }}
                    />
                  ) : null}

                  {sortMode !== "default" ? <FilterChip label={sortLabel} onClear={() => setSortMode("default")} /> : null}
                </div>
              </div>
            ) : null}

            <div className="mt-4 flex items-center justify-between gap-2">
              <div className="text-[12px] text-white/55">
                {totalLabel}: <span className="text-white/90 font-semibold">{totalItems}</span>
                <span className="ml-3 text-white/35">
                  Pag {page}/{totalPages}
                </span>
              </div>

              <div className="flex items-center gap-2 shrink-0">
                <button type="button" onClick={shuffleNow} className={shufflePrimaryClass} title="Mischia articoli">
                  <ShuffleIcon className="h-[18px] w-[18px]" />
                  Shuffle
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* GRID + PAGINAZIONE BOTTOM */}
      <div className={`${container} pt-6 pb-14`}>
        {noResults ? (
          <div className="mx-auto max-w-[520px] text-center rounded-3xl border border-white/10 bg-white/[0.04] p-8">
            <div className="text-white/90 font-semibold text-lg">Nessun risultato</div>
            <div className="mt-2 text-sm text-white/55">Prova a cambiare filtri o cercare un termine diverso.</div>

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
            <div
              className={[
                "grid gap-4",
                "grid-cols-1 min-[420px]:grid-cols-2",
                "sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 2xl:grid-cols-7",
              ].join(" ")}
            >
              {filtered.map((x) => {
                const meta = [x.seller, x.category].filter(Boolean).join(" • ");
                const img = x.cover ? coverSrc(x.cover, "small") : "";

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

                      {meta ? <div className="mt-2 text-[11px] text-white/55 truncate">{meta}</div> : <div className="mt-2 h-[16px]" />}

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
                      prevHref ? "text-white/85 hover:bg-white/8" : "text-white/35 pointer-events-none",
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
                      nextHref ? "text-white/85 hover:bg-white/8" : "text-white/35 pointer-events-none",
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

      {/* ✅ MOBILE CUSTOM PICKER (bottom-sheet) */}
      {pickerOpen ? (
        <div className="sm:hidden fixed inset-0 z-[100]">
          <button
            type="button"
            className="absolute inset-0 bg-black/60 backdrop-blur-[2px]"
            onClick={closePicker}
            aria-label="Chiudi"
          />
          <div className="absolute inset-x-0 bottom-0">
            <div className="mx-auto w-full max-w-[520px] rounded-t-3xl border border-white/10 bg-black/85 backdrop-blur-xl shadow-[0_-30px_120px_rgba(0,0,0,0.65)]">
              <div className="p-4">
                <div className="flex items-center justify-between gap-3">
                  <div className="text-white/90 font-semibold text-[15px]">{pickerData.title}</div>
                  <button
                    type="button"
                    onClick={closePicker}
                    className="h-9 w-9 rounded-full border border-white/10 bg-white/5 hover:bg-white/8 text-white/80 transition"
                    aria-label="Chiudi"
                    title="Chiudi"
                  >
                    ×
                  </button>
                </div>

                {pickerNeedsSearch ? (
                  <div className="mt-3">
                    <input
                      value={pickerQuery}
                      onChange={(e) => setPickerQuery(e.target.value)}
                      placeholder="Cerca…"
                      className="h-11 w-full rounded-full px-4 bg-white/5 border border-white/10 text-[16px] text-white/90 outline-none focus:border-white/25"
                      inputMode="search"
                      autoCorrect="off"
                      autoCapitalize="none"
                      spellCheck={false}
                    />
                  </div>
                ) : null}

                <div className="mt-3 max-h-[60vh] overflow-auto -mx-2 px-2 pb-2 [-webkit-overflow-scrolling:touch]">
                  {pickerFilteredOptions.map((opt) => {
                    const current = pickerCurrentValue(pickerOpen);
                    const selected = String(current) === String(opt.value);
                    return (
                      <button
                        key={`${pickerOpen}:${opt.value}`}
                        type="button"
                        onClick={() => applyPickerValue(pickerOpen, opt.value)}
                        className={[
                          "w-full h-12 px-4 rounded-2xl flex items-center justify-between text-left transition",
                          "border border-transparent",
                          selected ? "bg-white/10 border-white/10" : "hover:bg-white/7",
                        ].join(" ")}
                      >
                        <span className="text-[15px] text-white/90 truncate">{opt.label}</span>
                        {selected ? <span className="text-white/70 text-[14px]">✓</span> : null}
                      </button>
                    );
                  })}

                  {pickerFilteredOptions.length === 0 ? (
                    <div className="py-10 text-center text-white/45 text-sm">Nessun risultato</div>
                  ) : null}
                </div>

                <div className="h-4" />
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
