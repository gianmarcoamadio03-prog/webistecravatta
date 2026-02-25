/* eslint-disable @next/next/no-img-element */
"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import TagPill from "@/components/TagPill";
import SellerAvatar from "@/components/SellerAvatar";
import VerifiedBadge from "@/components/VerifiedBadge";

export type Seller = {
  name: string;
  verified?: boolean;
  specialties?: string[];
  previewImages?: string[];
  image?: string;

  url?: string;
  yupoo?: string;
  yupooUrl?: string;
  baseUrl?: string;

  whatsapp?: string;
  wa?: string;
  whatsappUrl?: string;
  contact?: string;

  featured?: boolean;
  best?: boolean;
  rank?: number | string;
  score?: number | string;
  itemsCount?: number | string;
  items_count?: number | string;

  [key: string]: any;
};

export type SellersDirectoryProps = { sellers: Seller[] };

function isUrl(v: string) {
  return /^https?:\/\//i.test((v || "").trim());
}

function normalizeImg(raw: string) {
  const s = String(raw || "").trim();
  if (!s) return "";
  if (isUrl(s)) return s;
  if (s.startsWith("/")) return s;
  if (s.includes("/")) return `/${s.replace(/^\/+/, "")}`;
  return `/sellers/${s}`;
}

function pickImages(s: Seller): string[] {
  const arr =
    (Array.isArray(s.previewImages) && s.previewImages) ||
    (Array.isArray((s as any).preview_images) && (s as any).preview_images) ||
    (Array.isArray((s as any).images) && (s as any).images) ||
    (Array.isArray((s as any).preview) && (s as any).preview) ||
    [];

  const fromArray = arr.map((x: any) => normalizeImg(String(x || ""))).filter(Boolean);

  const single = normalizeImg(String((s as any).image || (s as any).avatar || ""));
  const merged = single ? [single, ...fromArray] : fromArray;

  const seen = new Set<string>();
  const out: string[] = [];
  for (const u of merged) {
    if (seen.has(u)) continue;
    seen.add(u);
    out.push(u);
  }
  return out.slice(0, 8);
}

function pickAvatar(s: Seller): string {
  const imgs = pickImages(s);
  return imgs[0] || "";
}

function pickItemsCount(s: Seller): number | null {
  const v = (s.itemsCount ?? s.items_count ?? (s as any).items ?? (s as any).count) as any;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function toWhatsAppUrl(vRaw: string): string {
  const v = (vRaw || "").trim();
  if (!v) return "";
  if (isUrl(v)) return v;

  const digits = v.replace(/[^\d+]/g, "");
  const cleaned = digits.startsWith("+") ? digits.slice(1) : digits;
  if (cleaned.length < 7) return "";
  return `https://wa.me/${cleaned}`;
}

function pickWhatsApp(s: Seller): string {
  const raw =
    String(s.whatsappUrl || "").trim() ||
    String(s.whatsapp || "").trim() ||
    String(s.wa || "").trim() ||
    String(s.contact || "").trim();
  return toWhatsAppUrl(raw);
}

function pickSpreadsheetHref(name: string) {
  return `/spreadsheet?seller=${encodeURIComponent(name)}`;
}

function scoreForSort(s: Seller) {
  const featured = s.featured || s.best ? 1 : 0;
  const verified = s.verified ? 1 : 0;

  const score = Number(s.score);
  const rank = Number(s.rank);
  const items = pickItemsCount(s) ?? 0;

  const scoreN = Number.isFinite(score) ? score : 0;
  const rankN = Number.isFinite(rank) ? rank : 0;

  const rankBoost = rankN > 0 ? 1000 - Math.min(rankN, 999) : 0;

  return featured * 1_000_000 + scoreN * 10_000 + rankBoost * 100 + verified * 50 + items;
}

function BarsDivider({ size = "lg" }: { size?: "lg" | "md" }) {
  const wA = size === "lg" ? "w-24" : "w-16";
  const wB = size === "lg" ? "w-10" : "w-8";
  const wC = size === "lg" ? "w-16" : "w-12";

  return (
    <div aria-hidden className="mt-5 flex items-center justify-center gap-2 opacity-95">
      <div className={`h-[2px] ${wA} rounded-full bg-white/18`} />
      <div className={`h-[2px] ${wB} rounded-full bg-white/12`} />
      <div className={`h-[2px] ${wC} rounded-full bg-white/18`} />
      <div className={`h-[2px] ${wB} rounded-full bg-white/12`} />
      <div className={`h-[2px] ${wA} rounded-full bg-white/18`} />
    </div>
  );
}

function HeroSectionTitle({
  title,
  tone = "primary",
}: {
  title: string;
  tone?: "primary" | "secondary";
}) {
  const isPrimary = tone === "primary";
  return (
    <div className="text-center">
      <div className="relative inline-block">
        <div
          aria-hidden
          className="pointer-events-none absolute -inset-x-24 -inset-y-12 blur-3xl"
          style={{
            opacity: isPrimary ? 0.85 : 0.65,
            background:
              "radial-gradient(closest-side at 50% 50%, rgba(255,255,255,0.16), transparent 70%)",
          }}
        />
        <h2
          className={[
            "relative font-semibold tracking-[-0.01em] text-white",
            isPrimary ? "text-3xl md:text-4xl" : "text-2xl md:text-3xl",
          ].join(" ")}
        >
          {title}
        </h2>
        <div className="mt-2 text-[11px] uppercase tracking-[0.38em] text-white/45">
          Curated picks
        </div>
      </div>
      <BarsDivider size={isPrimary ? "lg" : "md"} />
    </div>
  );
}

function FeaturedCard({ s }: { s: Seller }) {
  const imgs = pickImages(s);
  const wa = pickWhatsApp(s);
  const specs = (s.specialties || []).slice(0, 3).map(String);
  const itemsCount = pickItemsCount(s);

  return (
    <div className="group overflow-hidden rounded-3xl border border-white/10 bg-white/5 backdrop-blur-xl">
      <div className="relative h-[160px] w-full overflow-hidden border-b border-white/10 bg-white/5">
        {imgs[0] ? (
          <img
            src={imgs[0]}
            alt=""
            className="h-full w-full object-cover opacity-85 transition duration-700 group-hover:scale-[1.04]"
            loading="lazy"
          />
        ) : (
          <div className="h-full w-full" />
        )}
        <div className="absolute inset-0 bg-gradient-to-b from-black/10 via-black/20 to-black/70" />

        <div className="absolute bottom-0 left-0 right-0 p-4">
          <div className="flex items-center gap-2">
            <div className="truncate text-lg font-semibold tracking-tight text-white">
              {String(s.name)}
            </div>
            {s.verified ? <VerifiedBadge size={16} /> : null}
          </div>

          <div className="mt-2 flex flex-wrap gap-2">
            {specs.length ? specs.map((x) => <TagPill key={x} label={x} />) : <TagPill label="Premium" />}
            {itemsCount != null ? (
              <span className="inline-flex items-center rounded-full border border-white/10 bg-black/25 px-2.5 py-1 text-[11px] text-white/70">
                {itemsCount} articoli
              </span>
            ) : null}
          </div>
        </div>
      </div>

      <div className="p-4">
        <div className="grid grid-cols-2 gap-3">
          {wa ? (
            <a
              href={wa}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center justify-center rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-sm text-white/85 hover:bg-white/10"
            >
              WhatsApp
            </a>
          ) : (
            <div className="inline-flex items-center justify-center rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-sm text-white/45">
              WhatsApp N/D
            </div>
          )}

          <Link
            href={pickSpreadsheetHref(String(s.name))}
            className="inline-flex items-center justify-center rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-sm text-white/85 hover:bg-white/10"
          >
            Articoli →
          </Link>
        </div>
      </div>
    </div>
  );
}

/**
 * Carousel mobile
 */
function FeaturedCarouselMobile({ sellers }: { sellers: Seller[] }) {
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const trackRef = useRef<HTMLDivElement | null>(null);
  const [hasOverflow, setHasOverflow] = useState(false);

  const halfRef = useRef(0);
  const posRef = useRef(0);
  const initedRef = useRef(false);

  const paused = useRef(false);
  const resumeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const loopItems = useMemo(() => {
    const base = Array.isArray(sellers) ? sellers : [];
    return base.length ? [...base, ...base] : [];
  }, [sellers]);

  const syncPos = () => {
    const sc = scrollerRef.current;
    if (sc) posRef.current = sc.scrollLeft;
  };

  const pauseFor = (ms = 1400) => {
    paused.current = true;
    syncPos();
    if (resumeTimer.current) clearTimeout(resumeTimer.current);
    resumeTimer.current = setTimeout(() => {
      syncPos();
      paused.current = false;
    }, ms);
  };

  useEffect(() => {
    const sc = scrollerRef.current;
    const tr = trackRef.current;
    if (!sc || !tr) return;

    const baseCount = Array.isArray(sellers) ? sellers.length : 0;

    const measure = () => {
      if (!baseCount) return;

      const children = Array.from(tr.children) as HTMLElement[];
      const firstHalf = children.slice(0, baseCount);

      const style = window.getComputedStyle(tr);
      const gapStr = (style.columnGap || style.gap || "0px") as string;
      const gap = Number.parseFloat(gapStr) || 0;

      let half = 0;
      firstHalf.forEach((el, i) => {
        half += el.offsetWidth;
        if (i !== firstHalf.length - 1) half += gap;
      });

      halfRef.current = half;
      setHasOverflow(half > sc.clientWidth + 4);

      if (!initedRef.current && half > 0) {
        initedRef.current = true;
        posRef.current = half;
        sc.scrollLeft = half;
      }
    };

    const r1 = requestAnimationFrame(measure);
    const t2 = setTimeout(measure, 250);

    const onResize = () => measure();
    window.addEventListener("resize", onResize);

    return () => {
      cancelAnimationFrame(r1);
      clearTimeout(t2);
      window.removeEventListener("resize", onResize);
      if (resumeTimer.current) clearTimeout(resumeTimer.current);
    };
  }, [sellers, loopItems.length]);

  useEffect(() => {
    const sc = scrollerRef.current;
    if (!sc) return;

    const prefersReduced =
      typeof window !== "undefined" &&
      window.matchMedia &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    if (prefersReduced) return;

    let raf = 0;
    let last = performance.now();

    const SPEED = 20;
    const DIR = -1;

    const tick = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;

      const half = halfRef.current;

      if (half > 0 && !paused.current) {
        let next = posRef.current + DIR * SPEED * dt;
        if (next <= 0) next += half;
        if (next > half) next -= half;
        posRef.current = next;
        sc.scrollLeft = next;
      }

      raf = requestAnimationFrame(tick);
    };

    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [loopItems.length]);

  useEffect(() => {
    const sc = scrollerRef.current;
    if (!sc) return;

    const onWheel = () => pauseFor(1200);
    const onTouch = () => pauseFor(1600);

    sc.addEventListener("wheel", onWheel, { passive: true });
    sc.addEventListener("touchstart", onTouch, { passive: true });
    sc.addEventListener("touchmove", onTouch, { passive: true });

    return () => {
      sc.removeEventListener("wheel", onWheel);
      sc.removeEventListener("touchstart", onTouch);
      sc.removeEventListener("touchmove", onTouch);
    };
  }, []);

  useEffect(() => {
    const sc = scrollerRef.current;
    if (!sc) return;

    const st = { down: false, x: 0, left: 0, pid: -1, moved: false };
    const THRESH = 6;

    const onDown = (e: PointerEvent) => {
      if (e.pointerType === "mouse" && e.button !== 0) return;
      st.down = true;
      st.moved = false;
      st.x = e.clientX;
      st.left = sc.scrollLeft;
      st.pid = e.pointerId;
      paused.current = true;
      syncPos();
      try {
        sc.setPointerCapture(e.pointerId);
      } catch {}
    };

    const onMove = (e: PointerEvent) => {
      if (!st.down) return;
      const dx = e.clientX - st.x;
      if (!st.moved && Math.abs(dx) < THRESH) return;
      st.moved = true;
      sc.scrollLeft = st.left - dx;
      syncPos();
    };

    const onUp = () => {
      if (!st.down) return;
      st.down = false;
      try {
        sc.releasePointerCapture(st.pid);
      } catch {}
      pauseFor(1400);
    };

    sc.addEventListener("pointerdown", onDown);
    sc.addEventListener("pointermove", onMove);
    sc.addEventListener("pointerup", onUp);
    sc.addEventListener("pointercancel", onUp);
    sc.addEventListener("pointerleave", onUp);

    return () => {
      sc.removeEventListener("pointerdown", onDown);
      sc.removeEventListener("pointermove", onMove);
      sc.removeEventListener("pointerup", onUp);
      sc.removeEventListener("pointercancel", onUp);
      sc.removeEventListener("pointerleave", onUp);
    };
  }, []);

  if (!sellers.length) return null;

  const FADE = 38;

  return (
    <div className="md:hidden mt-10 relative w-screen left-1/2 -translate-x-1/2">
      <div
        ref={scrollerRef}
        className={[
          "relative z-10 overflow-x-auto overflow-y-hidden",
          "[-webkit-overflow-scrolling:touch] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
          "pl-[calc(16px+env(safe-area-inset-left))] pr-[calc(16px+env(safe-area-inset-right))]",
        ].join(" ")}
        style={{
          scrollBehavior: "auto",
          touchAction: "pan-x",
          ...(hasOverflow
            ? {
                WebkitMaskImage: `linear-gradient(to right,
                  transparent 0px,
                  black ${FADE}px,
                  black calc(100% - ${FADE}px),
                  transparent 100%)`,
                maskImage: `linear-gradient(to right,
                  transparent 0px,
                  black ${FADE}px,
                  black calc(100% - ${FADE}px),
                  transparent 100%)`,
                WebkitMaskRepeat: "no-repeat",
                maskRepeat: "no-repeat",
                WebkitMaskSize: "100% 100%",
                maskSize: "100% 100%",
              }
            : {}),
        }}
      >
        <div ref={trackRef} className="flex gap-4 py-2 w-max">
          {loopItems.map((s, idx) => (
            <div key={`${String(s.name)}-${idx}`} className="shrink-0 w-[78vw] max-w-[420px]">
              <FeaturedCard s={s} />
            </div>
          ))}
        </div>
      </div>

      <div className="mt-3 text-center text-[11px] text-white/40">
        Scorre in automatico — puoi comunque trascinare
      </div>
    </div>
  );
}

export default function SellersDirectory({ sellers }: SellersDirectoryProps) {
  const filtered = useMemo(() => {
    const list = Array.isArray(sellers) ? sellers : [];
    const out = list
      .filter((s) => {
        const name = String(s?.name || "").trim();
        return !!name;
      })
      .slice();

    out.sort((a, b) => {
      const A = scoreForSort(a);
      const B = scoreForSort(b);
      if (B !== A) return B - A;
      return String(a.name).localeCompare(String(b.name));
    });

    return out;
  }, [sellers]);

  const featured = useMemo(() => {
    const topExplicit = filtered.filter((s) => !!(s.featured || s.best));
    const base = topExplicit.length ? topExplicit : filtered;
    return base.slice(0, 6);
  }, [filtered]);

  const listBars = useMemo(() => filtered.slice(0, 60), [filtered]);

  return (
    <div className="relative min-h-screen">
      <Link
        href="/"
        className="fixed left-5 top-5 z-50 inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/6 px-4 py-2 text-sm text-white/85 backdrop-blur hover:bg-white/10 md:left-8 md:top-8"
      >
        ← Home
      </Link>

      <div className="pointer-events-none absolute inset-0">
        <div className="absolute -top-32 left-1/2 h-[520px] w-[520px] -translate-x-1/2 rounded-full bg-white/10 blur-3xl" />
        <div className="absolute top-[30%] right-[-120px] h-[420px] w-[420px] rounded-full bg-white/5 blur-3xl" />
        <div className="absolute bottom-[-120px] left-[-120px] h-[420px] w-[420px] rounded-full bg-white/5 blur-3xl" />
      </div>

      <div className="relative mx-auto w-full max-w-6xl px-4 pb-14 pt-24 md:px-8 md:pt-28">
        <section className="mb-16">
          <HeroSectionTitle title="Best seller of the month" tone="primary" />

          <div className="hidden md:grid mt-10 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {featured.map((s) => (
              <FeaturedCard key={String(s.name)} s={s} />
            ))}
          </div>

          <FeaturedCarouselMobile sellers={featured} />
        </section>

        <section>
          <HeroSectionTitle title="Best seller" tone="secondary" />

          <div className="mt-10 grid gap-3 md:grid-cols-2">
            {listBars.map((s) => {
              const specs = (s.specialties || []).slice(0, 3).map(String);
              const wa = pickWhatsApp(s);
              const avatar = pickAvatar(s);

              return (
                <div
                  key={String(s.name)}
                  className="group flex items-center justify-between gap-3 rounded-2xl border border-white/12 bg-white/[0.035] px-4 py-3 backdrop-blur transition hover:bg-white/[0.055] hover:border-white/20 hover:-translate-y-[1px]"
                >
                  <div className="min-w-0 flex items-center gap-3">
                    <SellerAvatar name={String(s.name)} src={avatar} size={40} />

                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <div className="truncate text-sm font-semibold text-white">
                          {String(s.name)}
                        </div>
                        {s.verified ? <VerifiedBadge size={16} /> : null}
                      </div>

                      <div className="mt-1 flex flex-wrap gap-1.5">
                        {specs.length ? (
                          specs.map((x) => <TagPill key={x} label={x} />)
                        ) : (
                          <span className="text-[11px] text-white/45">Nessuna specialty</span>
                        )}
                      </div>
                    </div>
                  </div>

                  <div className="flex shrink-0 items-center gap-2">
                    {wa ? (
                      <a
                        href={wa}
                        target="_blank"
                        rel="noreferrer"
                        className="rounded-full border border-white/10 bg-white/5 px-3 py-1.5 text-[12px] text-white/80 hover:bg-white/10"
                        title="Apri WhatsApp"
                      >
                        WA
                      </a>
                    ) : (
                      <div
                        className="rounded-full border border-white/10 bg-white/5 px-3 py-1.5 text-[12px] text-white/40"
                        title="WhatsApp non disponibile"
                      >
                        WA
                      </div>
                    )}

                    <Link
                      href={pickSpreadsheetHref(String(s.name))}
                      className="rounded-full border border-white/10 bg-white/5 px-3 py-1.5 text-[12px] text-white/80 hover:bg-white/10"
                      title="Vai agli articoli filtrati"
                    >
                      Articoli →
                    </Link>
                  </div>
                </div>
              );
            })}
          </div>

          <div className="mt-10 md:hidden">
            <Link
              href="/"
              className="inline-flex rounded-full border border-white/10 bg-white/5 px-4 py-2 text-sm text-white/80 backdrop-blur hover:bg-white/10"
            >
              ← Home
            </Link>
          </div>
        </section>
      </div>
    </div>
  );
}