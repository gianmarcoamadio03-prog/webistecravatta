import Link from "next/link";
import { notFound } from "next/navigation";

import Gallery from "./Gallery";
import SupportButton from "./SupportButton";

import { getItemBySlugOrId } from "@/data/itemsFromSheet";
import { toUsFansProductUrl, toMulebuyProductUrl } from "@/data/affiliate";
import { parseCny, cnyToEur, formatEUR } from "@/src/lib/currency";
import { normalizeSlug } from "@/src/lib/slug";

export const revalidate = 60;
export const runtime = "nodejs";

type RawSearchParams = Record<string, string | string[] | undefined>;
type SearchParamsMaybePromise = RawSearchParams | Promise<RawSearchParams>;

type SheetItem = {
  id?: string;
  slug?: string;
  title?: string;

  brand?: string;
  category?: string;
  seller?: string;

  rowNumber?: number;

  images?: string[] | string;
  pics?: string[] | string;

  source_url?: string;
  yupoo_url?: string;

  usfans?: string;
  usfans_link?: string;
  usfans_url?: string;

  mulebuy?: string;
  mulebuy_link?: string;
  mulebuy_url?: string;

  price_eur?: number | null;
  source_price_cny?: string | number | null;

  [key: string]: any;
};

async function unwrapSearchParams(sp?: SearchParamsMaybePromise): Promise<RawSearchParams> {
  if (!sp) return {};
  if (typeof (sp as any)?.then === "function") return await (sp as Promise<RawSearchParams>);
  return sp as RawSearchParams;
}

function getOne(sp: RawSearchParams, key: string) {
  const v = sp[key];
  if (Array.isArray(v)) return (v[0] ?? "").toString();
  return (v ?? "").toString();
}

function safeStr(v: any) {
  return (v ?? "").toString().trim();
}

function isValidUrl(v: any) {
  return typeof v === "string" && /^https?:\/\//i.test(v.trim());
}

function parsePics(input: any): string[] {
  const raw: string[] = Array.isArray(input)
    ? input
    : typeof input === "string"
      ? input.split(/\n|,|\s+/g)
      : [];

  return raw.map((x) => safeStr(x)).filter((x) => x.length > 0 && isValidUrl(x));
}

function pickPics(item: SheetItem): string[] {
  const a = parsePics(item.images);
  const b = parsePics(item.pics);
  return (a.length ? a : b).filter(Boolean);
}

function findFirstSourceUrl(item: SheetItem) {
  if (isValidUrl(item.source_url)) return safeStr(item.source_url);
  if (isValidUrl(item.yupoo_url)) return safeStr(item.yupoo_url);

  for (const [, v] of Object.entries(item)) {
    if (!isValidUrl(v)) continue;
    const s = (v as string).toLowerCase();
    if (s.includes("taobao.com") || s.includes("tmall.com") || s.includes("weidian.com")) {
      return safeStr(v);
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
    if (domainCheck(s)) return safeStr(v);
  }

  for (const [, v] of Object.entries(item)) {
    if (!isValidUrl(v)) continue;
    const s = (v as string).toLowerCase();
    if (domainCheck(s)) return safeStr(v);
  }

  return "";
}

function cleanBackQuery(raw: string) {
  let q = (raw || "").trim();
  try {
    q = decodeURIComponent(q);
  } catch {}
  q = q.replace(/^\?/, "");

  if (!q) return "";
  if (q.includes("http://") || q.includes("https://")) return "";
  if (q.includes("/")) return "";
  return q;
}

/** ✅ pill compatte, wrap pulito (anti clipping) */
function MetaPill({ children }: { children: React.ReactNode }) {
  return (
    <span
      className={[
        "inline-flex items-center",
        "h-7 px-3 rounded-full",
        "border border-white/10 bg-white/5",
        "text-[11px] text-white/80",
        "tracking-[0.18em] uppercase leading-none",
        "max-w-full overflow-hidden text-ellipsis whitespace-nowrap",
      ].join(" ")}
    >
      {children}
    </span>
  );
}

function AgentBtn({
  href,
  label,
  iconSrc,
  variant = "secondary",
  size = "md",
}: {
  href?: string;
  label: string;
  iconSrc: string;
  variant?: "primary" | "secondary";
  size?: "md" | "sm";
}) {
  const disabled = !href;

  const h = size === "sm" ? "h-10" : "h-11";
  const px = size === "sm" ? "px-3.5" : "px-4";
  const text = size === "sm" ? "text-[13px]" : "text-sm";

  // ✅ icone scalate: su sm più piccole (così non “esplodono” su mobile)
  const icoBox = size === "sm" ? "h-5 w-5 rounded-lg" : "h-6 w-6 rounded-xl";
  const icoImg = size === "sm" ? "h-4 w-4" : "h-5 w-5";

  const base = `inline-flex items-center justify-center gap-2 ${h} ${px} rounded-full border transition ${text} font-semibold whitespace-nowrap`;
  const enabled =
    variant === "primary"
      ? "border-white/15 bg-gradient-to-r from-violet-300/90 to-emerald-200/90 text-black hover:brightness-105 active:brightness-95"
      : "border-white/12 bg-white/7 text-white/90 hover:bg-white/10 hover:border-white/20 active:bg-white/12";
  const disabledCls = "opacity-40 cursor-not-allowed border-white/10 bg-white/5 text-white/60";

  return (
    <a
      href={disabled ? undefined : href}
      target={disabled ? undefined : "_blank"}
      rel={disabled ? undefined : "nofollow noreferrer"}
      aria-disabled={disabled}
      tabIndex={disabled ? -1 : 0}
      className={[base, disabled ? disabledCls : enabled].join(" ")}
      title={disabled ? "Link non disponibile" : label}
    >
      <span className={`${icoBox} bg-white/90 grid place-items-center overflow-hidden shrink-0`}>
        <img src={iconSrc} alt="" className={`${icoImg} object-contain block`} />
      </span>
      <span className="leading-none">{label}</span>
    </a>
  );
}

export default async function ItemPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams?: SearchParamsMaybePromise;
}) {
  const { slug } = await params;

  const sp = await unwrapSearchParams(searchParams);
  const wanted = normalizeSlug(decodeURIComponent(slug));

  const found = (await getItemBySlugOrId(wanted)) as SheetItem | null;
  if (!found) notFound();

  const title = safeStr(found.title) || "Articolo";
  const seller = safeStr(found.seller);
  const category = safeStr(found.category);
  const brand = safeStr(found.brand);

  const pics = pickPics(found);

  const eurFromSheet =
    typeof found.price_eur === "number" && Number.isFinite(found.price_eur)
      ? found.price_eur
      : null;

  const p = parseCny(found.source_price_cny);
  const eurFromCny = p != null ? cnyToEur(p) : null;

  const eur = eurFromSheet ?? eurFromCny;
  const eurLabel = eur != null ? formatEUR(eur) : "—";

  const sourceUrl = findFirstSourceUrl(found);

  const usfansDirect = getDirectAgentUrl(found, "usfans");
  const mulebuyDirect = getDirectAgentUrl(found, "mulebuy");

  const usfansUrl = usfansDirect || (sourceUrl ? toUsFansProductUrl(sourceUrl) : "");
  const mulebuyUrl = mulebuyDirect || (sourceUrl ? toMulebuyProductUrl(sourceUrl) : "");

  const backRaw = getOne(sp, "back");
  const backQuery = cleanBackQuery(backRaw);
  const backHref = backQuery ? `/spreadsheet?${backQuery}` : "/spreadsheet";

  const rowNumber =
    typeof found.rowNumber === "number" && Number.isFinite(found.rowNumber)
      ? found.rowNumber
      : null;

  // ✅ padding sotto: sufficiente per dock, ma NON esagerato
  const bottomPad = "pb-[calc(130px+env(safe-area-inset-bottom))] lg:pb-10";

  return (
    <main className={`min-h-screen w-full bg-black text-white ${bottomPad}`}>
      {/* backdrop */}
      <div className="pointer-events-none fixed inset-0 -z-10">
        <div className="absolute inset-0 bg-[radial-gradient(900px_420px_at_50%_0%,rgba(255,255,255,0.08),transparent_60%)]" />
        <div className="absolute inset-0 bg-[radial-gradient(700px_420px_at_15%_80%,rgba(160,255,220,0.06),transparent_65%)]" />
        <div className="absolute inset-0 bg-[radial-gradient(700px_420px_at_85%_70%,rgba(185,130,255,0.06),transparent_65%)]" />
      </div>

      {/* Topbar */}
      <div className="sticky top-0 z-40 border-b border-white/10 bg-black/60 backdrop-blur-xl">
        <div
          className={[
            "mx-auto w-full max-w-5xl",
            "pl-[calc(16px+env(safe-area-inset-left))] pr-[calc(16px+env(safe-area-inset-right))]",
            "sm:px-6 py-3 flex items-center gap-3",
          ].join(" ")}
        >
          <Link
            href={backHref}
            className="inline-flex items-center justify-center h-10 px-4 rounded-full border border-white/12 bg-white/6 hover:bg-white/10 transition text-sm font-semibold"
            title="Torna al catalogo"
          >
            ← Catalogo
          </Link>

          <div className="ml-auto text-[11px] text-white/45 hidden sm:block">
            {seller ? `Seller: ${seller}` : ""}
          </div>
        </div>
      </div>

      {/* Content */}
      <div className="mx-auto w-full max-w-5xl px-4 sm:px-6 pt-4">
        <header className="mb-4">
          <h1 className="text-[26px] leading-[1.08] sm:text-4xl font-extrabold tracking-tight text-white/95">
            {title}
          </h1>

          {/* ✅ TAG: wrap pulito + anti clipping */}
          <div className="mt-3 flex flex-wrap gap-2">
            {brand ? <MetaPill>Brand: {brand}</MetaPill> : null}
            {seller ? <MetaPill>Seller: {seller}</MetaPill> : null}
            {category ? <MetaPill>Categoria: {category}</MetaPill> : null}
            <MetaPill>Foto: {pics.length || 0}</MetaPill>
          </div>
        </header>

        <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr),360px] items-start">
          {/* Left */}
          <section className="min-w-0 space-y-5">
            <div className="rounded-3xl border border-white/10 bg-white/5 shadow-[0_30px_120px_rgba(0,0,0,0.55)] overflow-hidden">
              <Gallery images={pics} title={title} />
            </div>

            {/* ✅ Mobile-only support (ripulito, NO testo sotto) */}
            <div className="lg:hidden rounded-3xl border border-white/10 bg-white/5 p-4">
              <div className="flex items-center justify-between">
                <div className="text-[11px] tracking-[0.32em] uppercase text-white/45">
                  Assistenza
                </div>
                <div className="text-[11px] text-white/35">Help</div>
              </div>

              <div className="mt-3">
                <SupportButton
                  title={title}
                  id={safeStr(found.id) || wanted}
                  slug={safeStr(found.slug) || wanted}
                  brand={brand || undefined}
                  category={category || undefined}
                  seller={seller || undefined}
                  rowNumber={rowNumber ?? undefined}
                  sourceUrl={sourceUrl || undefined}
                />
              </div>
            </div>
          </section>

          {/* Right (desktop only) */}
          <aside className="hidden lg:block">
            <div className="sticky top-24 rounded-3xl border border-white/10 bg-white/5 p-5 shadow-[0_30px_120px_rgba(0,0,0,0.55)]">
              <div className="text-[11px] tracking-[0.32em] uppercase text-white/45">
                Acquisto tramite agent
              </div>

              <div className="mt-4 rounded-3xl border border-white/10 bg-gradient-to-br from-violet-400/20 to-emerald-200/10 p-4">
                <div className="text-[11px] tracking-[0.28em] uppercase text-white/55">
                  Prezzo stimato
                </div>
                <div className="mt-1 text-3xl font-extrabold text-white/95">{eurLabel}</div>
              </div>

              <div className="mt-4 grid gap-2">
                <AgentBtn
                  href={usfansUrl || undefined}
                  label="USFans"
                  iconSrc="/agents/usfans.png"
                  variant="primary"
                />
                <AgentBtn
                  href={mulebuyUrl || undefined}
                  label="MuleBuy"
                  iconSrc="/agents/mulebuy.png"
                  variant="secondary"
                />
              </div>

              {/* ✅ Assistenza desktop ripulita (NO testo sotto) */}
              <div className="mt-5 pt-5 border-t border-white/10">
                <div className="text-[11px] tracking-[0.32em] uppercase text-white/45 mb-3">
                  Assistenza
                </div>

                <SupportButton
                  title={title}
                  id={safeStr(found.id) || wanted}
                  slug={safeStr(found.slug) || wanted}
                  brand={brand || undefined}
                  category={category || undefined}
                  seller={seller || undefined}
                  rowNumber={rowNumber ?? undefined}
                  sourceUrl={sourceUrl || undefined}
                />
              </div>
            </div>
          </aside>
        </div>
      </div>

      {/* Mobile bottom buy bar */}
      <div className="lg:hidden fixed bottom-0 left-0 right-0 z-50 border-t border-white/10 bg-black/72 backdrop-blur-xl">
        <div
          className={[
            "mx-auto w-full max-w-5xl",
            "pl-[calc(16px+env(safe-area-inset-left))] pr-[calc(16px+env(safe-area-inset-right))]",
            "pt-3 pb-[calc(12px+env(safe-area-inset-bottom))]",
          ].join(" ")}
        >
          <div className="rounded-3xl border border-white/10 bg-white/[0.05] p-3 shadow-[0_20px_90px_rgba(0,0,0,0.55)]">
            <div className="flex items-baseline justify-between gap-3">
              <div className="text-[11px] text-white/55 tracking-[0.22em] uppercase">
                Prezzo stimato
              </div>
              <div className="text-[16px] font-extrabold text-white/95">{eurLabel}</div>
            </div>

            <div className="mt-2 grid grid-cols-2 gap-2">
              <AgentBtn
                href={usfansUrl || undefined}
                label="USFans"
                iconSrc="/agents/usfans.png"
                variant="primary"
                size="sm"
              />
              <AgentBtn
                href={mulebuyUrl || undefined}
                label="MuleBuy"
                iconSrc="/agents/mulebuy.png"
                variant="secondary"
                size="sm"
              />
            </div>
          </div>
        </div>
      </div>
    </main>
  );
}
