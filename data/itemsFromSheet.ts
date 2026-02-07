// data/itemsFromSheet.ts
import "server-only";

import { getCnyToEurRate } from "./fx";
import { google } from "googleapis";
import fs from "node:fs/promises";
import { normalizeSlug } from "../src/lib/slug";

export type SheetItem = {
  rowNumber: number; // ✅ AGGIUNTO (posizione nel foglio)

  id: string;
  slug: string;
  title: string;

  brand: string;
  category: string;
  seller: string;

  images: string[];
  cover: string;

  source_url: string;
  source_price_cny: string;

  tags: string[];

  price_eur: number | null;
};

const REVALIDATE_SECONDS = (() => {
  const n = Number(process.env.HOME_SHOWCASE_REVALIDATE || "600");
  return Number.isFinite(n) && n > 0 ? n : 600;
})();

const SHEET_ID = (process.env.SHEET_ID || "").trim();
const TAB = (process.env.SHEET_TAB || "items").trim();

const TTL_MS = () => REVALIDATE_SECONDS * 1000;

/** ---------- small utils ---------- */

function slugify(input: string) {
  const s = (input ?? "").toString().trim().toLowerCase();
  if (!s) return "";
  return s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function toNumberLoose(v: string): number | null {
  const s = (v || "")
    .trim()
    .replace(/\s+/g, "")
    .replace("€", "")
    .replace("¥", "")
    .replace("$", "")
    .replace(",", ".");
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function normalizeHttp(u: string) {
  const s = String(u || "").trim();
  if (!s) return "";
  if (s.startsWith("//")) return `https:${s}`;
  // a volte Yupoo dà /photo.yupoo.com/...
  if (s.startsWith("/photo.yupoo.com/")) return `https://${s.slice(1)}`;
  return s;
}

/** --------- Yupoo image helpers (per dedupe smart) --------- */

function yupooImageKey(url: string) {
  try {
    const u = new URL(normalizeHttp(url));
    const host = (u.hostname || "").toLowerCase();
    if (!host.includes("photo.yupoo.com")) return "";
    const parts = u.pathname.split("/").filter(Boolean);
    // tipico: /SELLER/HASH/...
    if (parts.length >= 2) return `${parts[0]}/${parts[1]}`;
    return "";
  } catch {
    return "";
  }
}

function toBigYupooPhotoUrl(url: string) {
  const s0 = String(url || "").trim();
  if (!s0) return "";

  const fixed = normalizeHttp(s0);
  if (!fixed.toLowerCase().includes("photo.yupoo.com")) return fixed;

  // converte /medium.jpg /small.jpg /thumb.jpg /square.jpg -> /big.jpg
  return fixed.replace(
    /\/(medium|small|thumb|square)\.(jpg|jpeg|png|webp)(\?.*)?$/i,
    (_m, _sz, ext, qs) => `/big.${ext}${qs || ""}`
  );
}

function scoreImageUrl(u: string) {
  const s = String(u || "").trim();
  if (!s) return -1;

  let sc = 0;
  const low = s.toLowerCase();

  // preferisci big
  if (low.includes("/big.")) sc += 4;

  // preferisci query (spesso auth_key)
  try {
    const uu = new URL(normalizeHttp(s));
    if ((uu.search || "").length > 0) sc += 2;
  } catch {}

  // leggero tie-breaker
  sc += Math.min(2, Math.floor(s.length / 120));
  return sc;
}

/**
 * ✅ Dedupe immagini "smart":
 * - per photo.yupoo.com dedupe per key seller/hash (ignorando query e size)
 * - sceglie la versione migliore (big + query se presente)
 * - mantiene l'ordine della prima occorrenza
 */
function uniqueKeepOrderImages(list: string[]) {
  const order: string[] = [];
  const chosen = new Map<string, string>(); // key -> bestUrl

  for (const raw of Array.isArray(list) ? list : []) {
    const v0 = String(raw || "").trim();
    if (!v0) continue;

    const v = toBigYupooPhotoUrl(normalizeHttp(v0));
    if (!v) continue;

    const key = yupooImageKey(v);
    const k = key ? `yupoo:${key}` : `url:${v.toLowerCase()}`;

    if (!chosen.has(k)) {
      chosen.set(k, v);
      order.push(k);
    } else {
      const prev = chosen.get(k) || "";
      if (scoreImageUrl(v) > scoreImageUrl(prev)) chosen.set(k, v);
    }
  }

  return order.map((k) => chosen.get(k)!).filter(Boolean);
}

/** ---------- parsing helpers ---------- */

function parseExtraImages(raw: string): string[] {
  const s = (raw || "").trim();
  if (!s) return [];
  const urls = (s.match(/https?:\/\/[^\s,|;]+/gi) || []).map((x) => x.trim());
  return urls
    .map(normalizeHttp)
    .map(toBigYupooPhotoUrl)
    .filter((u) => u && !u.toLowerCase().includes("ci_play.png"));
}

function parseTags(raw: string): string[] {
  const s = (raw || "").trim();
  if (!s) return [];
  return s
    .split(/[\n\r,;|]+/g)
    .map((x) => x.trim())
    .filter(Boolean);
}

function uniqueKeepOrder(list: string[]) {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const x of list) {
    const v = String(x || "").trim();
    if (!v) continue;
    const k = v.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(v);
  }
  return out;
}

function uniqueSorted(list: string[]) {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const x of list) {
    const v = String(x ?? "").trim();
    if (!v) continue;
    const k = v.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(v);
  }
  return out.sort((a, b) => a.localeCompare(b));
}

/**
 * fallback robusto: scansiona tutta la riga e prende solo URL "immagine"
 */
function scanRowForImageUrls(row: string[]): string[] {
  const out: string[] = [];
  for (const cell of row) {
    const s = String(cell ?? "").trim();
    if (!s) continue;

    const urls = s.match(/https?:\/\/[^\s,|;]+/gi) || [];
    for (const u0 of urls) {
      const u = toBigYupooPhotoUrl(normalizeHttp(u0));
      const low = u.toLowerCase();
      if (low.includes("ci_play.png")) continue;

      const looksLikeImage =
        /\.(jpe?g|png|webp|gif|avif)(\?|#|$)/i.test(u) || low.includes("/big.");

      if (!looksLikeImage) continue;
      out.push(u);
    }
  }
  return uniqueKeepOrderImages(out);
}

function normLite(s: string) {
  return (s ?? "")
    .toString()
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

/** ---------- deterministic shuffle ---------- */

function seedFromString(str: string) {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  h = Math.imul(h ^ (h >>> 16), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  return (h ^ (h >>> 16)) >>> 0;
}

function mulberry32(seed: number) {
  let t = seed >>> 0;
  return function () {
    t += 0x6d2b79f5;
    let x = Math.imul(t ^ (t >>> 15), 1 | t);
    x ^= x + Math.imul(x ^ (x >>> 7), 61 | x);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffleInPlace<T>(arr: T[], seed: number) {
  const rnd = mulberry32(seed);
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function getBaseShuffleSeed() {
  const envSeed = (process.env.SPREADSHEET_SHUFFLE_SEED || "").trim();
  if (envSeed) return envSeed;

  const d = new Date();
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

/** ---------- service account ---------- */

async function readServiceAccount() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON?.trim() || "";
  if (!raw) throw new Error("Missing GOOGLE_SERVICE_ACCOUNT_JSON");

  // se è un path leggiamo il file, altrimenti assumiamo JSON string
  if (raw.startsWith("/") || raw.startsWith(".")) {
    const txt = await fs.readFile(raw, "utf8");
    return JSON.parse(txt);
  }
  return JSON.parse(raw);
}

let _sheets:
  | { sheets: ReturnType<typeof google.sheets>; spreadsheetId: string; tab: string }
  | null = null;

async function getSheetsClient() {
  if (_sheets) return _sheets;

  if (!SHEET_ID) throw new Error("Missing SHEET_ID");
  if (!process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    throw new Error("Missing GOOGLE_SERVICE_ACCOUNT_JSON");
  }

  const sa = await readServiceAccount();
  const clientEmail = sa.client_email;
  const privateKey = String(sa.private_key || "").replace(/\\n/g, "\n");

  if (!clientEmail || !privateKey) {
    throw new Error("Invalid service account JSON (missing client_email/private_key)");
  }

  const auth = new google.auth.JWT({
    email: clientEmail,
    key: privateKey,
    scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
  });

  const sheets = google.sheets({ version: "v4", auth });

  _sheets = { sheets, spreadsheetId: SHEET_ID, tab: TAB };
  return _sheets;
}

/** ---------- types ---------- */

type PageResult = {
  items: SheetItem[];
  page: number;
  pageSize: number;
  totalItems: number;
  totalPages: number;
};

export type Facets = {
  brands: string[];
  categories: string[];
  sellers: string[];
};

type MetaRow = {
  rowNumber: number;
  id: string;
  slug: string;
  title: string;
  brand: string;
  category: string;
  seller: string;
};

/** ---------- cache (pruned) ---------- */

function pruneMap<K, V>(m: Map<K, V>, max = 250) {
  if (m.size <= max) return;
  const extra = m.size - max;
  const it = m.keys();
  for (let i = 0; i < extra; i++) {
    const k = it.next().value as K | undefined;
    if (k === undefined) break;
    m.delete(k);
  }
}

let countCache: { ts: number; n: number } | null = null;
const pageCache = new Map<string, { ts: number; data: PageResult }>();
const headCache = new Map<string, { ts: number; items: SheetItem[] }>();
const spreadsheetCache = new Map<
  string,
  { ts: number; data: PageResult & { facets: Facets; order: "default" | "random" } }
>();

let metaCache: { ts: number; rows: MetaRow[]; facets: Facets } | null = null;
const shuffledRowCache = new Map<string, { ts: number; rowNumbers: number[] }>();

/** ---------- meta + facets ---------- */

async function getMeta(): Promise<{ rows: MetaRow[]; facets: Facets }> {
  const ttl = TTL_MS();
  const now = Date.now();
  if (metaCache && now - metaCache.ts < ttl) {
    return { rows: metaCache.rows, facets: metaCache.facets };
  }

  const { sheets, spreadsheetId, tab } = await getSheetsClient();

  // Meta super-leggera: A..F (id, slug, title, brand, category, seller)
  const range = `${tab}!A2:F`;
  const resp = await sheets.spreadsheets.values.get({ spreadsheetId, range });
  const values = (resp.data.values || []) as any[][];

  const rows: MetaRow[] = [];
  const brands: string[] = [];
  const categories: string[] = [];
  const sellers: string[] = [];

  values.forEach((r, i) => {
    const rowNumber = 2 + i;
    const row = Array.isArray(r) ? r.map((c) => String(c ?? "")) : [];
    while (row.length < 6) row.push("");

    const id = String(row[0] ?? "").trim();
    const slug = String(row[1] ?? "").trim();
    const title = String(row[2] ?? "").trim();
    const brand = String(row[3] ?? "").trim();
    const category = String(row[4] ?? "").trim();
    const seller = String(row[5] ?? "").trim();

    if (!title) return;

    rows.push({ rowNumber, id, slug, title, brand, category, seller });
    if (brand) brands.push(brand);
    if (category) categories.push(category);
    if (seller) sellers.push(seller);
  });

  const facets: Facets = {
    brands: uniqueSorted(brands),
    categories: uniqueSorted(categories),
    sellers: uniqueSorted(sellers),
  };

  metaCache = { ts: now, rows, facets };
  return { rows, facets };
}

function filterRowNumbers(
  metaRows: MetaRow[],
  opts: { q?: string; brand?: string; category?: string; seller?: string }
): number[] {
  const q = normLite(opts.q || "");
  const brand = String(opts.brand || "").trim();
  const category = String(opts.category || "").trim();
  const seller = String(opts.seller || "").trim();

  const hasBrand = brand && brand !== "all";
  const hasCategory = category && category !== "all";
  const hasSeller = seller && seller !== "all";

  return metaRows
    .filter((r) => {
      if (hasBrand && r.brand !== brand) return false;
      if (hasCategory && r.category !== category) return false;
      if (hasSeller && r.seller !== seller) return false;

      if (q) {
        const hay = normLite(`${r.title} ${r.brand} ${r.seller} ${r.category}`);
        if (!hay.includes(q)) return false;
      }
      return true;
    })
    .map((r) => r.rowNumber);
}

async function getShuffledRowNumbers(cacheKey: string, rowNumbers: number[]) {
  const ttl = TTL_MS();
  const now = Date.now();
  const cached = shuffledRowCache.get(cacheKey);
  if (cached && now - cached.ts < ttl) return cached.rowNumbers;

  const seed = seedFromString(cacheKey);
  const shuffled = shuffleInPlace([...rowNumbers], seed);
  shuffledRowCache.set(cacheKey, { ts: now, rowNumbers: shuffled });
  pruneMap(shuffledRowCache, 250);
  return shuffled;
}

async function getItemsCount(): Promise<number> {
  const ttl = TTL_MS();
  const now = Date.now();

  if (countCache && now - countCache.ts < ttl) return countCache.n;

  const { sheets, spreadsheetId, tab } = await getSheetsClient();

  const range = `${tab}!C2:C`;
  const resp = await sheets.spreadsheets.values.get({ spreadsheetId, range });
  const values = (resp.data.values || []) as any[][];
  const n = values.filter((r) => String(r?.[0] ?? "").trim() !== "").length;

  countCache = { ts: now, n };
  return n;
}

/**
 * Parser “fixed columns” (A..T):
 * A id
 * B slug
 * C title
 * D brand
 * E category
 * F seller
 * G..N img1..img8
 * O img_extra
 * P status
 * Q yupoo_url
 * R source_url
 * S source_price_cny
 * T tags
 */
function parseRowFixed(row: string[], rowNumber: number, cnyToEur: number): SheetItem | null {
  const title = String(row[2] ?? "").trim();
  const source_url = String(row[17] ?? "").trim();

  if (!title && !source_url && !row.some((c) => String(c ?? "").trim() !== "")) return null;

  const id = String(row[0] ?? "").trim() || `row-${rowNumber}`;
  const rawSlug = String(row[1] ?? "").trim();
  const slug = rawSlug ? slugify(rawSlug) : slugify(title) || id;

  const brand = String(row[3] ?? "").trim();
  const category = String(row[4] ?? "").trim();
  const seller = String(row[5] ?? "").trim();

  // immagini base img1..img8 (G..N)
  const baseImages: string[] = [];
  for (let i = 6; i <= 13; i++) {
    const v = toBigYupooPhotoUrl(normalizeHttp(String(row[i] ?? "").trim()));
    if (v) baseImages.push(v);
  }

  const extraImages = parseExtraImages(String(row[14] ?? ""));

  const headerImages = uniqueKeepOrderImages([...baseImages, ...extraImages]).filter((u) =>
    /^https?:\/\//i.test(u)
  );

  const scannedImages = scanRowForImageUrls(row);
  const imagesRaw = uniqueKeepOrderImages([...headerImages, ...scannedImages]);

  // ✅ COVER = prima immagine
  const cover = imagesRaw[0] || "";
  const images = cover ? [cover, ...imagesRaw.slice(1)] : imagesRaw;

  const source_price_cny = String(row[18] ?? "").trim();
  const priceCny = toNumberLoose(source_price_cny);
  const priceEur = priceCny == null ? null : Math.round(priceCny * cnyToEur * 100) / 100;

  const tagsRaw = String(row[19] ?? "").trim();
  const tags = uniqueKeepOrder(parseTags(tagsRaw));

  return {
    rowNumber, // ✅ AGGIUNTO QUI
    id,
    slug,
    title: title || "Item",
    brand,
    category,
    seller,
    images,
    cover,
    source_url,
    source_price_cny,
    tags,
    price_eur: priceEur,
  };
}

async function fetchItemsByRowNumbers(rowNumbers: number[]): Promise<SheetItem[]> {
  if (!rowNumbers.length) return [];

  const { sheets, spreadsheetId, tab } = await getSheetsClient();
  const ranges = rowNumbers.map((rn) => `${tab}!A${rn}:T${rn}`);

  const resp = await sheets.spreadsheets.values.batchGet({
    spreadsheetId,
    ranges,
  });

  const cnyToEur = await getCnyToEurRate();
  const byRow = new Map<number, SheetItem>();

  for (const vr of resp.data.valueRanges || []) {
    const range = String(vr.range || "");
    const m = range.match(/!A(\d+):T\1$/);
    const rowNumber = m ? Number(m[1]) : NaN;

    const rawRow = (vr.values?.[0] || []) as any[];
    const cells = Array.isArray(rawRow) ? rawRow.map((c) => String(c ?? "")) : [];
    while (cells.length < 20) cells.push("");

    if (Number.isFinite(rowNumber)) {
      const parsed = parseRowFixed(cells, rowNumber, cnyToEur);
      if (parsed) byRow.set(rowNumber, parsed);
    }
  }

  return rowNumbers.map((rn) => byRow.get(rn)).filter(Boolean) as SheetItem[];
}

export async function getItemsPage(page: number, pageSize = 42): Promise<PageResult> {
  const p = Math.max(1, Math.floor(Number(page) || 1));
  const ps = Math.max(1, Math.floor(Number(pageSize) || 42));

  const cacheKey = `${p}:${ps}`;
  const ttl = TTL_MS();
  const now = Date.now();
  const cached = pageCache.get(cacheKey);
  if (cached && now - cached.ts < ttl) return cached.data;

  const totalItems = await getItemsCount();
  const totalPages = Math.max(1, Math.ceil(totalItems / ps));
  const safePage = Math.min(p, totalPages);

  const startRow = 2 + (safePage - 1) * ps;
  const endRow = startRow + ps - 1;

  const { sheets, spreadsheetId, tab } = await getSheetsClient();
  const range = `${tab}!A${startRow}:T${endRow}`;
  const resp = await sheets.spreadsheets.values.get({ spreadsheetId, range });

  const rows = (resp.data.values || []) as any[][];
  const cnyToEur = await getCnyToEurRate();

  const items = rows
    .map((r, idx) => {
      const rowNumber = startRow + idx;
      const row = Array.isArray(r) ? r.map((c) => String(c ?? "")) : [];
      while (row.length < 20) row.push("");
      return parseRowFixed(row, rowNumber, cnyToEur);
    })
    .filter(Boolean) as SheetItem[];

  const data: PageResult = {
    items,
    page: safePage,
    pageSize: ps,
    totalItems,
    totalPages,
  };

  pageCache.set(cacheKey, { ts: now, data });
  pruneMap(pageCache, 180);
  return data;
}

export async function getSpreadsheetPage(
  page: number,
  pageSize = 42,
  opts?: {
    q?: string;
    brand?: string;
    category?: string;
    seller?: string;
    order?: "default" | "random";
    seed?: string;
  }
): Promise<PageResult & { facets: Facets; order: "default" | "random" }> {
  const p = Math.max(1, Math.floor(Number(page) || 1));
  const ps = Math.max(1, Math.floor(Number(pageSize) || 42));

  const order: "default" | "random" = opts?.order === "default" ? "default" : "random";
  const q = (opts?.q || "").trim();
  const brand = (opts?.brand || "").trim();
  const category = (opts?.category || "").trim();
  const seller = (opts?.seller || "").trim();

  const baseSeed = (opts?.seed || "").trim() || getBaseShuffleSeed();
  const filterSeedKey = `${baseSeed}|b=${brand}|c=${category}|s=${seller}|q=${q}`;

  const cacheKey = `sp:${order}:${p}:${ps}:${filterSeedKey}`;
  const ttl = TTL_MS();
  const now = Date.now();
  const cached = spreadsheetCache.get(cacheKey);
  if (cached && now - cached.ts < ttl) return cached.data;

  const meta = await getMeta();
  const allFacets = meta.facets;

  const filteredRowNumbers = filterRowNumbers(meta.rows, { q, brand, category, seller });

  const orderedRowNumbers =
    order === "default"
      ? filteredRowNumbers
      : await getShuffledRowNumbers(filterSeedKey, filteredRowNumbers);

  const totalItems = orderedRowNumbers.length;
  const totalPages = Math.max(1, Math.ceil(totalItems / ps));
  const safePage = Math.min(p, totalPages);

  const startIdx = (safePage - 1) * ps;
  const slice = orderedRowNumbers.slice(startIdx, startIdx + ps);

  const items = await fetchItemsByRowNumbers(slice);

  const data: PageResult & { facets: Facets; order: "default" | "random" } = {
    items,
    page: safePage,
    pageSize: ps,
    totalItems,
    totalPages,
    facets: allFacets,
    order,
  };

  spreadsheetCache.set(cacheKey, { ts: now, data });
  pruneMap(spreadsheetCache, 200);
  return data;
}

export async function getItemsPreview(limit = 18): Promise<SheetItem[]> {
  const ps = Math.max(1, Math.floor(Number(limit) || 18));
  const res = await getItemsPage(1, ps);
  return res.items;
}

export async function getItemsHead(limit = 120): Promise<SheetItem[]> {
  const ps = Math.max(1, Math.floor(Number(limit) || 120));

  const cacheKey = String(ps);
  const ttl = TTL_MS();
  const now = Date.now();
  const cached = headCache.get(cacheKey);
  if (cached && now - cached.ts < ttl) return cached.items;

  const { sheets, spreadsheetId, tab } = await getSheetsClient();
  const endRow = 1 + ps;
  const range = `${tab}!A2:T${endRow}`;

  const resp = await sheets.spreadsheets.values.get({ spreadsheetId, range });
  const rows = (resp.data.values || []) as any[][];
  const cnyToEur = await getCnyToEurRate();

  const items = rows
    .map((r, idx) => {
      const rowNumber = 2 + idx;
      const row = Array.isArray(r) ? r.map((c) => String(c ?? "")) : [];
      while (row.length < 20) row.push("");
      return parseRowFixed(row, rowNumber, cnyToEur);
    })
    .filter(Boolean) as SheetItem[];

  headCache.set(cacheKey, { ts: now, items });
  pruneMap(headCache, 50);
  return items;
}

type ItemIndex = {
  ts: number;
  bySlug: Map<string, number>;
  byTitle: Map<string, number>;
  byId: Map<string, number>;
};

let indexCache: ItemIndex | null = null;

export async function getItemBySlugOrId(slugOrId: string): Promise<SheetItem | null> {
  const wanted = normalizeSlug(decodeURIComponent(slugOrId || ""));
  if (!wanted) return null;

  const ttl = TTL_MS();
  const now = Date.now();

  if (!indexCache || now - indexCache.ts >= ttl) {
    const { sheets, spreadsheetId, tab } = await getSheetsClient();

    const range = `${tab}!A2:C`;
    const resp = await sheets.spreadsheets.values.get({ spreadsheetId, range });
    const rows = (resp.data.values || []) as any[][];

    const bySlug = new Map<string, number>();
    const byTitle = new Map<string, number>();
    const byId = new Map<string, number>();

    rows.forEach((r, i) => {
      const id = String(r?.[0] ?? "").trim();
      const slug = String(r?.[1] ?? "").trim();
      const title = String(r?.[2] ?? "").trim();
      const rowNumber = 2 + i;

      const idKey = normalizeSlug(id);
      const slugKey = normalizeSlug(slug);
      const titleKey = normalizeSlug(title);

      if (idKey && !byId.has(idKey)) byId.set(idKey, rowNumber);
      if (slugKey && !bySlug.has(slugKey)) bySlug.set(slugKey, rowNumber);
      if (titleKey && !byTitle.has(titleKey)) byTitle.set(titleKey, rowNumber);
    });

    indexCache = { ts: now, bySlug, byTitle, byId };
  }

  const rowNumber =
    indexCache.bySlug.get(wanted) ??
    indexCache.byTitle.get(wanted) ??
    indexCache.byId.get(wanted);

  if (!rowNumber) return null;

  const { sheets, spreadsheetId, tab } = await getSheetsClient();
  const range = `${tab}!A${rowNumber}:T${rowNumber}`;
  const resp = await sheets.spreadsheets.values.get({ spreadsheetId, range });
  const row = (resp.data.values?.[0] || []) as any[];

  const cells = Array.isArray(row) ? row.map((c) => String(c ?? "")) : [];
  while (cells.length < 20) cells.push("");

  const cnyToEur = await getCnyToEurRate();
  return parseRowFixed(cells, rowNumber, cnyToEur);
}

export async function getItemsFromSheet(): Promise<SheetItem[]> {
  const total = await getItemsCount();
  const HARD_CAP = Number(process.env.MAX_LOAD_ALL_ITEMS || "5000");

  if (total > HARD_CAP) {
    throw new Error(
      `Too many items (${total}). Don't use getItemsFromSheet() with big sheets. Use getItemsPage(page, 42) or getSpreadsheetPage().`
    );
  }

  const pageSize = 500;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const all: SheetItem[] = [];

  for (let p = 1; p <= pages; p++) {
    const { items } = await getItemsPage(p, pageSize);
    all.push(...items);
  }
  return all;
}
