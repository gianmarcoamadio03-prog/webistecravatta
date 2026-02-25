// app/spreadsheet/page.tsx
import SpreadsheetClient from "./SpreadsheetClient";
import { getSpreadsheetPage } from "@/data/itemsFromSheet";
import { redirect } from "next/navigation";
import { unstable_cache } from "next/cache";

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
  images?: string[];
  pics?: string[];
  source_url?: string;
  price_eur?: number | null;
  [key: string]: any;
};

const PAGE_SIZE = 54;
const CACHE_REVALIDATE_SECONDS = 60; // tienilo uguale a export const revalidate

function cleanStr(v: any) {
  if (Array.isArray(v)) v = v[0];
  return (v ?? "").toString().trim();
}

function cleanFilter(v: any) {
  const s = cleanStr(v);
  return s ? s : "all";
}

function clamp(n: number, a: number, b: number) {
  return Math.max(a, Math.min(b, n));
}

function cleanSeed(v: string) {
  return (v || "").trim().slice(0, 64);
}

async function unwrapSearchParams(sp?: SearchParamsMaybePromise): Promise<RawSearchParams> {
  if (!sp) return {};
  if (typeof (sp as any)?.then === "function") return await (sp as Promise<RawSearchParams>);
  return sp as RawSearchParams;
}

// ---------- cache helpers (stabile) ----------
function stableStringify(obj: any): string {
  if (obj === null || obj === undefined) return String(obj);
  const t = typeof obj;
  if (t !== "object") return JSON.stringify(obj);
  if (Array.isArray(obj)) return `[${obj.map(stableStringify).join(",")}]`;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}

function hash36(input: string) {
  let h = 5381;
  for (let i = 0; i < input.length; i++) h = ((h << 5) + h) ^ input.charCodeAt(i);
  return (h >>> 0).toString(36);
}

/**
 * Cache per combinazione (page + size + filtri).
 * Questo evita di chiamare Google Sheets ad ogni request uguale.
 */
async function getSpreadsheetPageCached(
  page: number,
  pageSize: number,
  opts: {
    q: string;
    seller: string;
    brand: string;
    category: string;
    order: "default" | "random";
    seed?: string;
  }
) {
  const keyPayload = stableStringify({ page, pageSize, ...opts });
  const key = `spreadsheetPage:v1:${hash36(keyPayload)}`;

  const cachedFn = unstable_cache(
    async () => getSpreadsheetPage(page, pageSize, opts),
    [key],
    { revalidate: CACHE_REVALIDATE_SECONDS }
  );

  return cachedFn();
}

export default async function Page({
  searchParams,
}: {
  searchParams?: SearchParamsMaybePromise;
}) {
  const sp = await unwrapSearchParams(searchParams);

  const order: "default" | "random" =
    cleanStr(sp.order) === "default" ? "default" : "random";

  const q = cleanStr(sp.q);
  const seller = cleanFilter(sp.seller);
  const brand = cleanFilter(sp.brand);
  const category = cleanFilter(sp.category);

  const pageRaw = parseInt(cleanStr(sp.page) || "1", 10);
  const requestedPage = Number.isFinite(pageRaw) ? pageRaw : 1;

  let shuffle = cleanSeed(cleanStr(sp.shuffle));

  // se sei in random ma manca shuffle, generiamo seed server-side e redirectiamo
  if (order === "random" && !shuffle) {
    shuffle = Date.now().toString(36);

    const params = new URLSearchParams();
    params.set("order", "random");
    params.set("shuffle", shuffle);

    if (requestedPage > 1) params.set("page", String(requestedPage));
    if (q) params.set("q", q);
    if (seller && seller !== "all") params.set("seller", seller);
    if (brand && brand !== "all") params.set("brand", brand);
    if (category && category !== "all") params.set("category", category);

    redirect(`/spreadsheet?${params.toString()}`);
  }

  try {
    const res = await getSpreadsheetPageCached(requestedPage, PAGE_SIZE, {
      q,
      seller,
      brand,
      category,
      order,
      seed: order === "random" ? shuffle : undefined,
    });

    const page = clamp(res.page, 1, res.totalPages);

    return (
      <main className="ss-page">
        <SpreadsheetClient
          items={res.items as SheetItem[]}
          page={page}
          totalPages={res.totalPages}
          totalItems={res.totalItems}
          pageSize={PAGE_SIZE}
          facets={res.facets}
          initialFilters={{ q, seller, brand, category, order }}
        />
      </main>
    );
  } catch (err: any) {
    const msg = String(err?.message || "");
    const status = (err && (err.status || err.code)) ?? "";
    const isQuota =
      status === 429 ||
      msg.toLowerCase().includes("resource has been exhausted") ||
      msg.toLowerCase().includes("quota");

    return (
      <main className="ss-page" style={{ padding: 24 }}>
        <div
          style={{
            maxWidth: 720,
            margin: "0 auto",
            borderRadius: 20,
            border: "1px solid rgba(255,255,255,0.10)",
            background: "rgba(255,255,255,0.04)",
            padding: 20,
          }}
        >
          <div style={{ fontSize: 18, fontWeight: 700, marginBottom: 8 }}>
            {isQuota ? "Spreadsheet temporaneamente occupato" : "Errore nel caricamento"}
          </div>
          <div style={{ opacity: 0.75, lineHeight: 1.5 }}>
            {isQuota
              ? "Il server ha raggiunto un limite di richieste verso Google Sheets. Riprova tra 30–60 secondi."
              : "Si è verificato un errore durante il caricamento della pagina."}
          </div>

          <div style={{ marginTop: 14, opacity: 0.55, fontSize: 12 }}>
            {msg ? `Dettaglio: ${msg}` : null}
          </div>
        </div>
      </main>
    );
  }
}