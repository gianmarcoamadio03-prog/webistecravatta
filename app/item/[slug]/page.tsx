// app/item/[slug]/page.tsx
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

  return (
    <main className="it-page">
      <div className="it-backdrop" />

      <div className="it-container">
        {/* TOPBAR */}
        <div className="it-topbar">
          <Link href={backHref} className="it-btn">
            ← Catalogo
          </Link>
          <div className="it-topbarSpacer" />
        </div>

        {/* HERO */}
        <header className="it-hero">
          <h1 className="it-title">{title}</h1>

          <div className="it-metaRow">
            {seller ? <span className="it-pill">SELLER: {seller}</span> : null}
            {category ? <span className="it-pill">CATEGORIA: {category}</span> : null}
            <span className="it-pill">FOTO: {pics.length || 0}</span>
          </div>
        </header>

        {/* MAIN */}
        <div className="it-main">
          {/* LEFT */}
          <section className="it-left">
            <div className="it-card it-card--gallery">
              <Gallery images={pics} title={title} />
            </div>
          </section>

          {/* RIGHT */}
          <aside className="it-right">
            <div className="it-card it-card--side">
              <div className="it-sideTop">
                <div className="it-sideLabel">ACQUISTO TRAMITE AGENT</div>
              </div>

              <div className="it-priceBox">
                <div className="it-priceLabel">PREZZO STIMATO</div>
                <div className="it-priceValue">{eurLabel}</div>
              </div>

              {/* ✅ SOLO pulsanti agent qui dentro */}
              <div className="it-actions">
                {/* USFANS */}
                <a
                  className={["it-agentbtn it-agentbtn--usfans", usfansUrl ? "" : "is-disabled"].join(" ")}
                  href={usfansUrl || undefined}
                  target={usfansUrl ? "_blank" : undefined}
                  rel={usfansUrl ? "nofollow noreferrer" : undefined}
                >
                  <span className="it-agentbtn-logo">
                    <img src="/agents/usfans.png" alt="USFans" />
                  </span>
                  <span className="it-agentbtn-text">
                    {usfansUrl ? "USFans Link" : "Coming soon"}
                  </span>
                </a>

                {/* MULEBUY */}
                <a
                  className={["it-agentbtn it-agentbtn--mulebuy", mulebuyUrl ? "" : "is-disabled"].join(" ")}
                  href={mulebuyUrl || undefined}
                  target={mulebuyUrl ? "_blank" : undefined}
                  rel={mulebuyUrl ? "nofollow noreferrer" : undefined}
                >
                  <span className="it-agentbtn-logo">
                    <img src="/agents/mulebuy.png" alt="MuleBuy" />
                  </span>
                  <span className="it-agentbtn-text">
                    {mulebuyUrl ? "MuleBuy Link" : "Coming soon"}
                  </span>
                </a>

                <div className="it-agentbtn it-agentbtn--soon is-disabled">
                  <span className="it-agentbtn-logo" />
                  <span className="it-agentbtn-text">Coming soon</span>
                </div>

                <div className="it-agentbtn it-agentbtn--soon is-disabled">
                  <span className="it-agentbtn-logo" />
                  <span className="it-agentbtn-text">Coming soon</span>
                </div>
              </div>

              {/* ✅ SOS FUORI dalla sezione agent (con separatore FORZATO) */}
              <div
                className="it-supportRow"
                style={{
                  marginTop: 12,
                  paddingTop: 12,
                  borderTop: "1px solid rgba(255,255,255,0.08)",
                }}
              >
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

              <p className="it-sideNote">
                Se il prezzo non compare è perché in sheet <code>price_eur</code> e{" "}
                <code>source_price_cny</code> sono vuoti / non validi.
              </p>
            </div>
          </aside>
        </div>
      </div>
    </main>
  );
}
