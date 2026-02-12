// app/spreadsheet/page.tsx
import SpreadsheetClient from "./SpreadsheetClient";
import { getSpreadsheetPage } from "@/data/itemsFromSheet";
import { redirect } from "next/navigation";

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

  const res = await getSpreadsheetPage(requestedPage, PAGE_SIZE, {
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

}
