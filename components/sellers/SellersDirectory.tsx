/* eslint-disable @next/next/no-img-element */
"use client";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import type { BrandSection } from "@/data/sellerDirectoryFromSheet";


type CardTheme = {
  accent: string;
  border: string;
  surface: string;
  glow: string;
};

const CARD_THEMES: CardTheme[] = [
  {
    accent: "#e879a0",
    border: "rgba(232,121,160,.42)",
    surface: "rgba(232,121,160,.095)",
    glow: "rgba(232,121,160,.15)",
  },
  {
    accent: "#65d8a1",
    border: "rgba(101,216,161,.40)",
    surface: "rgba(101,216,161,.09)",
    glow: "rgba(101,216,161,.14)",
  },
  {
    accent: "#6dcaf6",
    border: "rgba(109,202,246,.42)",
    surface: "rgba(109,202,246,.09)",
    glow: "rgba(109,202,246,.14)",
  },
  {
    accent: "#bf93ff",
    border: "rgba(191,147,255,.42)",
    surface: "rgba(191,147,255,.09)",
    glow: "rgba(191,147,255,.15)",
  },
  {
    accent: "#ffbc78",
    border: "rgba(255,188,120,.42)",
    surface: "rgba(255,188,120,.09)",
    glow: "rgba(255,188,120,.14)",
  },
  {
    accent: "#f18d81",
    border: "rgba(241,141,129,.42)",
    surface: "rgba(241,141,129,.09)",
    glow: "rgba(241,141,129,.14)",
  },
  {
    accent: "#dfc77b",
    border: "rgba(223,199,123,.42)",
    surface: "rgba(223,199,123,.09)",
    glow: "rgba(223,199,123,.14)",
  },
  {
    accent: "#8dd4cb",
    border: "rgba(141,212,203,.42)",
    surface: "rgba(141,212,203,.09)",
    glow: "rgba(141,212,203,.14)",
  },
];

function makeRandomThemes(ids: string[]) {
  const map: Record<string, CardTheme> = {};

  const shuffled = [...CARD_THEMES];

  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }

  ids.forEach((id, index) => {
    map[id] = shuffled[index % shuffled.length];
  });

  return map;
}


function CategoryIcon({ name }: { name: string }) {
  const common = {
    width: 18,
    height: 18,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.8,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true as const,
  };

  if (name === "jacket") return (
    <svg {...common}>
      <path d="m8 4-4 3-2 10 4 2 2-5v7h8v-7l2 5 4-2-2-10-4-3"/>
      <path d="M8 4c1 2 2.3 3 4 3s3-1 4-3M12 7v14"/>
    </svg>
  );

  if (name === "shoe") return (
    <svg {...common}>
      <path d="M3 14c3 0 5-3 6-7l4 2 2 5 6 3v3H3z"/>
      <path d="M3 17h18M10 11l3 1M9 14l4 1"/>
    </svg>
  );

  if (name === "bag") return (
    <svg {...common}>
      <rect x="4" y="8" width="16" height="13" rx="2"/>
      <path d="M9 8V6a3 3 0 0 1 6 0v2"/>
    </svg>
  );

  return (
    <svg {...common}>
      <circle cx="7" cy="13" r="4"/>
      <circle cx="17" cy="13" r="4"/>
      <path d="M11 13c.5-2 1.5-2 2 0M3 12l-1-1m19 1 1-1"/>
    </svg>
  );
}

// BRAND_QUICK_CATEGORY_LINKS
const QUICK_CATEGORIES = [
  { label: "Giubotti", icon: "jacket", category: "JACKETS", color: "#c7a4ff", background: "#241b32", border: "#604779" },
  { label: "Shoes", icon: "shoe", category: "SNEAKERS", color: "#80d9bc", background: "#182b27", border: "#3b6a5a" },
  { label: "Bags", icon: "bag", category: "BAGS", color: "#f0be85", background: "#30251a", border: "#755638" },
  { label: "Accessories", icon: "glasses", category: "ACCESSORIES", color: "#8ccaf1", background: "#192832", border: "#42677e" },
] as const;

export default function SellersDirectory({ brands }: { brands: BrandSection[] }) {
  const [search, setSearch] = useState("");
  const [themes, setThemes] = useState<Record<string, CardTheme>>({});
  const initialized = useRef(false);

  useEffect(() => {
    if (initialized.current) return;
    initialized.current = true;

    setThemes(makeRandomThemes(brands.map((brand) => String(brand.id))));
  }, [brands]);

  const sections = useMemo(() => {
    const q = search.trim().toLocaleLowerCase("it");
    return [...brands].sort((a, b) => a.name.localeCompare(b.name, "it", { sensitivity: "base" })).map(brand => {
      const matchesBrand = brand.name.toLocaleLowerCase("it").includes(q);
      const matchedSellers = !q || matchesBrand ? brand.sellers : brand.sellers.filter(s => s.name.toLocaleLowerCase("it").includes(q));
      const sellers = [...matchedSellers].sort((a, b) => a.name.localeCompare(b.name, "it", { sensitivity: "base" }));
      return { ...brand, sellers };
    }).filter(brand => !q || brand.name.toLocaleLowerCase("it").includes(q) || brand.sellers.length > 0);
  }, [brands, search]);
  const totalSellers = new Set(brands.flatMap(b => b.sellers.map(s => s.name.trim().toLocaleLowerCase("it")))).size;
  return <main className="relative min-h-screen bg-[#070709] px-4 pb-28 pt-24 text-white md:px-8 md:pt-32">
    <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-[450px] bg-[radial-gradient(ellipse_at_50%_0%,rgba(149,110,255,.17),transparent_65%)]" />
    <div className="relative mx-auto max-w-7xl">
      <div className="mb-12 text-center">
        <p className="mb-3 text-xs font-semibold uppercase tracking-[.32em] text-violet-300">CRAVATTA DIRECTORY</p>
        <h1 className="text-4xl font-bold tracking-tight md:text-6xl">Seller per <span className="bg-gradient-to-r from-[#c1a3ff] to-[#70d6bd] bg-clip-text text-transparent">brand</span></h1>
        <p className="mx-auto mt-4 max-w-xl text-sm leading-6 text-white/55 md:text-base">Esplora i venditori per marchio, visita il loro store e trova i prodotti nello Spreadsheet.</p>
        <p className="mt-4 text-xs text-white/40">{brands.length} brand · {totalSellers} seller</p>
      </div>

      <div className="sticky top-4 z-20 mx-auto mb-12 max-w-6xl rounded-2xl border border-white/10 bg-[#18171f]/95 p-2 shadow-xl shadow-black/30 backdrop-blur-xl">
        <div className="flex flex-col gap-2 lg:flex-row lg:items-center">
          <div className="min-w-0 flex-1">
            <label htmlFor="seller-search" className="sr-only">
              Cerca brand o seller
            </label>
            <input
              id="seller-search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Cerca un brand o un seller..."
              className="w-full rounded-xl bg-white/[.05] px-5 py-3.5 text-sm text-white outline-none placeholder:text-white/35 focus:ring-2 focus:ring-violet-500/50"
            />
          </div>

          <nav
            aria-label="Categorie rapide dello Spreadsheet"
            className="flex min-w-0 gap-2 overflow-x-auto py-1"
          >
            {QUICK_CATEGORIES.map((item) => (
              <button
                key={item.label}
                type="button"
                onClick={() => {
                  const destinations: Record<string, string> = {
                    Giacche: "Giubotti",
                    Giubotti: "Giubotti",
                    Scarpe: "Shoes",
                    Shoes: "Shoes",
                    Borse: "Bags",
                    Bags: "Bags",
                    Accessori: "Accessories",
                    Accessories: "Accessories",
                  };
                  const target = destinations[item.label] ?? item.label;
                  setSearch("");
                  requestAnimationFrame(() => {
                    requestAnimationFrame(() => {
                      document
                        .querySelector<HTMLElement>(
                          `[data-brand-name="${target.toLowerCase()}"]`
                        )
                        ?.scrollIntoView({
                          behavior: "smooth",
                          block: "start",
                        });
                    });
                  });
                }}
                className="flex min-h-[46px] shrink-0 items-center justify-center gap-2 rounded-xl border px-3 text-xs font-semibold transition hover:-translate-y-0.5 hover:brightness-125 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
                style={{
                  color: item.color,
                  backgroundColor: item.background,
                  borderColor: item.border,
                }}
                title={`Vai alla sezione ${item.label}`}
              >
                <CategoryIcon name={item.icon} />
                <span>{item.label}</span>
              </button>
            ))}
          </nav>
        </div>
      </div>
      {sections.length === 0 && <p className="py-20 text-center text-white/55">Nessun risultato per questa ricerca.</p>}
      <div className="columns-1 lg:columns-2 lg:gap-7">
        {sections.map(brand => <section
          key={brand.id}
          data-brand-name={brand.name.trim().toLocaleLowerCase("it")} className="mb-6 inline-block w-full break-inside-avoid overflow-hidden rounded-[22px] border bg-[#111116] align-top transition-colors duration-300 lg:mb-7"
          style={{
            borderColor: themes[String(brand.id)]?.border ?? "rgba(255,255,255,.12)",
            background: themes[String(brand.id)]
              ? `linear-gradient(180deg, ${themes[String(brand.id)].surface}, #101014 48%)`
              : "#111116",
            boxShadow: themes[String(brand.id)]
              ? `0 12px 32px -18px ${themes[String(brand.id)].glow}`
              : "0 12px 32px -18px rgba(0,0,0,.3)",
          }}>
          <div className="relative min-h-[185px] overflow-hidden border-b border-white/10 md:min-h-[205px]">
            {brand.cover && <img src={brand.cover} alt="" loading="lazy" className="absolute inset-0 h-full w-full object-cover opacity-50" />}
            <div
              className="absolute inset-0"
              style={{
                background: "linear-gradient(90deg,rgba(0,0,0,.92),rgba(0,0,0,.52),rgba(0,0,0,.22))",
              }}
            />
            <div className="relative flex min-h-[185px] flex-col justify-end p-6 md:min-h-[205px] md:p-9">
              <span className="mb-2 text-xs uppercase tracking-[.2em]" style={{ color: themes[String(brand.id)]?.accent ?? "#c4b5fd" }}>Brand directory</span>
              <h2 className="text-3xl font-bold tracking-tight md:text-5xl">{brand.name}</h2>
              <p className="mt-3 text-xs text-white/50">{brand.sellers.length} seller</p>
            </div>
          </div>
          <div className="grid grid-cols-1 gap-3 p-4 md:p-5">
            {brand.sellers.map(seller => <div key={seller.name} className="rounded-2xl border p-4 transition hover:bg-white/[.06]"
              style={{
                borderColor: "rgba(255,255,255,.10)",
                backgroundColor: "rgba(255,255,255,.045)",
                boxShadow: "inset 0 1px 0 rgba(255,255,255,.02)",
              }}>
              <h3 className="mb-3 truncate text-base font-semibold">{seller.name}</h3>
              <div className="grid grid-cols-2 gap-2">
                {seller.officialUrl ? <a href={seller.officialUrl} target="_blank" rel="noopener noreferrer" className="rounded-xl border px-2 py-3 text-center text-xs font-semibold transition hover:brightness-125"
                  style={{
                    borderColor: themes[String(brand.id)]?.border ?? "rgba(255,255,255,.15)",
                    color: themes[String(brand.id)]?.accent ?? "#fff",
                    backgroundColor: themes[String(brand.id)]?.surface ?? "rgba(255,255,255,.04)",
                  }}>Sito ufficiale ↗</a> : <span className="rounded-xl border border-white/10 bg-black/15 px-2 py-3 text-center text-xs text-white/35">Sito da aggiungere</span>}
                {seller.spreadsheetSeller ? <Link href={`/spreadsheet?seller=${encodeURIComponent(seller.spreadsheetSeller)}`} className="rounded-xl border px-2 py-3 text-center text-xs font-semibold text-white transition hover:brightness-125"
                  style={{
                    borderColor: themes[String(brand.id)]?.border ?? "rgba(255,255,255,.15)",
                    backgroundColor: themes[String(brand.id)]?.accent ?? "#7c3aed",
                    color: "#08080b",
                  }}>Vedi articoli →</Link> : <span className="rounded-xl border border-white/10 bg-black/15 px-2 py-3 text-center text-xs text-white/35">Non in spreadsheet</span>}
              </div>
            </div>)}
            {brand.sellers.length === 0 && <p className="py-8 text-center text-sm text-white/45">Nessun seller associato a questo brand.</p>}
          </div>
        </section>)}
      </div>
    </div>
  </main>;
}
