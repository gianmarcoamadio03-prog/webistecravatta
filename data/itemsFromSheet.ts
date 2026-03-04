// data/itemsFromSheet.ts
import "server-only";

import { getCnyToEurRate } from "./fx";
import { google } from "googleapis";
import fs from "node:fs/promises";
import { Buffer } from "node:buffer";
import { normalizeSlug } from "../src/lib/slug";

export type SheetItem = {
  rowNumber: number;

  id: string;
  slug: string;
  title: string;

  brand: string;
  category: string;
  seller: string;

  images: string[]; // list-mode: solo [cover]; full-mode: cover + altre
  cover: string;

  source_url: string;
  source_price_cny: string;

  tags: string[];
  price_eur: number | null;
};

export type Facets = {
  brands: string[];
  categories: string[];
  sellers: string[];
};

type PageResult = {
  items: SheetItem[];
  page: number;
  pageSize: number;
  totalItems: number;
  totalPages: number;
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

type ParseMode = "list" | "full";

const REVALIDATE_SECONDS = (() => {
  const n = Number(process.env.HOME_SHOWCASE_REVALIDATE || "600");
  return Number.isFinite(n) && n > 0 ? n : 600;
})();

const SHEET_ID = (process.env.SHEET_ID || "").trim();
const TAB = (process.env.SHEET_TAB || "items").trim();

const TTL_MS = () => REVALIDATE_SECONDS * 1000;

// ✅ per evitare payload “giganti” in FULL
const MAX_FULL_IMAGES = Number(process.env.MAX_ITEM_IMAGES || "36") || 36;

function clamp(n: number, a: number, b: number) {
  return Math.max(a, Math.min(b, n));
}

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
  if (s.startsWith("/photo.yupoo.com/")) return `https://${s.slice(1)}`;
  return s;
}

/** ✅ blocca VIDEO che a volte finiscono in cover/images (es: .mp4) */
function isLikelyImageUrl(u: string) {
  const s = String(u || "").trim();
  if (!s) return false;
  const low = s.toLowerCase();

  // ❌ video
  if (/\.(mp4|webm|mov|m4v)(\?|#|$)/i.test(low)) return false;

  // ✅ immagini classiche
  if (/\.(jpe?g|png|webp|gif|avif)(\?|#|$)/i.test(low)) return true;

  // ✅ yupoo size endpoints
  if (
    low.includes("/big.") ||
    low.includes("/small.") ||
    low.includes("/medium.") ||
    low.includes("/thumb.")
  ) return true;

  // ✅ fallback “soft”: se è yupoo photo ma non è video, lo teniamo
  try {
    const uu = new URL(normalizeHttp(s));
    const host = (uu.hostname || "").toLowerCase();
    if (host.includes("photo.yupoo.com")) return true;
  } catch {}

  return false;
}

/* ---------------- retry/backoff ---------------- */

async function withBackoff<T>(fn: () => Promise<T>, _label: string, tries = 3): Promise<T> {
  let lastErr: any;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e: any) {
      lastErr = e;
      const status = e?.code || e?.status;
      const msg = String(e?.message || "").toLowerCase();
      const retriable =
        status === 429 ||
        status === 500 ||
        status === 503 ||
        msg.includes("resource has been exhausted") ||
        msg.includes("quota");

      if (!retriable || i === tries - 1) break;

      const wait = 500 * Math.pow(2, i) + Math.floor(Math.random() * 250);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw lastErr;
}

/* ---------------- global in-memory caches ---------------- */

type CacheEntry<T> = { at: number; data: T };

function g<T = any>() {
  return globalThis as any as T;
}

function isFresh(at: number, ttl: number) {
  return Date.now() - at < ttl;
}

function getMetaCache(): CacheEntry<{ rows: MetaRow[]; facets: Facets }> | null {
  return (g() as any).__CRAVATTA_META_CACHE ?? null;
}
function setMetaCache(v: CacheEntry<{ rows: MetaRow[]; facets: Facets }>) {
  (g() as any).__CRAVATTA_META_CACHE = v;
}

function getFxCache(): CacheEntry<number> | null {
  return (g() as any).__CRAVATTA_FX_CACHE ?? null;
}
function setFxCache(v: CacheEntry<number>) {
  (g() as any).__CRAVATTA_FX_CACHE = v;
}

function rowListCache(): Map<number, CacheEntry<SheetItem>> {
  const gg: any = g();
  if (!gg.__CRAVATTA_ROW_LIST_CACHE) gg.__CRAVATTA_ROW_LIST_CACHE = new Map();
  return gg.__CRAVATTA_ROW_LIST_CACHE as Map<number, CacheEntry<SheetItem>>;
}
function rowFullCache(): Map<number, CacheEntry<SheetItem>> {
  const gg: any = g();
  if (!gg.__CRAVATTA_ROW_FULL_CACHE) gg.__CRAVATTA_ROW_FULL_CACHE = new Map();
  return gg.__CRAVATTA_ROW_FULL_CACHE as Map<number, CacheEntry<SheetItem>>;
}

function shuffleCache(): Map<string, CacheEntry<number[]>> {
  const gg: any = g();
  if (!gg.__CRAVATTA_SHUFFLE_CACHE) gg.__CRAVATTA_SHUFFLE_CACHE = new Map();
  return gg.__CRAVATTA_SHUFFLE_CACHE as Map<string, CacheEntry<number[]>>;
}

/* ---------------- yupoo helpers (dedupe smart) ---------------- */

function yupooImageKey(url: string) {
  try {
    const u = new URL(normalizeHttp(url));
    const host = (u.hostname || "").toLowerCase();
    if (!host.includes("photo.yupoo.com")) return "";
    const parts = u.pathname.split("/").filter(Boolean);
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

  if (low.includes("/big.")) sc += 4;

  try {
    const uu = new URL(normalizeHttp(s));
    if ((uu.search || "").length > 0) sc += 2;
  } catch {}

  sc += Math.min(2, Math.floor(s.length / 120));
  return sc;
}

function uniqueKeepOrderImages(list: string[]) {
  const order: string[] = [];
  const chosen = new Map<string, string>();

  for (const raw of Array.isArray(list) ? list : []) {
    const v0 = String(raw || "").trim();
    if (!v0) continue;

    const v = toBigYupooPhotoUrl(normalizeHttp(v0));
    if (!v) continue;

    // ✅ filtra roba non immagine (es. mp4)
    if (!isLikelyImageUrl(v)) continue;

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

/* ---------------- parsing helpers ---------------- */

function parseExtraImages(raw: string): string[] {
  const s = (raw || "").trim();
  if (!s) return [];
  const urls = (s.match(/https?:\/\/[^\s,|;]+/gi) || []).map((x) => x.trim());
  return urls
    .map(normalizeHttp)
    .map(toBigYupooPhotoUrl)
    .filter((u) => u && !u.toLowerCase().includes("ci_play.png"))
    .filter(isLikelyImageUrl);
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
      if (!isLikelyImageUrl(u)) continue;

      out.push(u);
    }
  }

  // ✅ cap per sicurezza
  return uniqueKeepOrderImages(out).slice(0, MAX_FULL_IMAGES);
}

function normLite(s: string) {
  return (s ?? "")
    .toString()
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

/* ---------------- deterministic shuffle + cache ---------------- */

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

function getOrBuildShuffled(key: string, rowNumbers: number[]) {
  const ttl = TTL_MS();
  const sc = shuffleCache();
  const cached = sc.get(key);
  if (cached && isFresh(cached.at, ttl)) return cached.data;

  const seed = seedFromString(key);
  const data = shuffleInPlace([...rowNumbers], seed);
  sc.set(key, { at: Date.now(), data });
  return data;
}

/* ---------------- service account (robust) ---------------- */

type ServiceAccount = { client_email: string; private_key: string };

function normalizePrivateKey(key: string) {
  return String(key || "").replace(/\\n/g, "\n");
}

async function tryReadJsonFile(p: string): Promise<any | null> {
  try {
    const txt = await fs.readFile(p, "utf8");
    return JSON.parse(txt);
  } catch {
    return null;
  }
}

async function readServiceAccount(): Promise<ServiceAccount> {
  const raw =
    process.env.GOOGLE_SERVICE_ACCOUNT_JSON?.trim() ||
    process.env.GOOGLE_SERVICE_ACCOUNT?.trim() ||
    "";

  if (raw && (raw.startsWith("/") || raw.startsWith("."))) {
    const obj = await tryReadJsonFile(raw);
    if (obj?.client_email && obj?.private_key) return obj as ServiceAccount;
  }

  if (raw && raw.startsWith("{")) {
    try {
      const obj = JSON.parse(raw);
      if (obj?.client_email && obj?.private_key) return obj as ServiceAccount;
    } catch {}
  }

  if (raw && !raw.startsWith("{") && !raw.startsWith("/") && !raw.startsWith(".")) {
    try {
      const decoded = Buffer.from(raw, "base64").toString("utf8");
      if (decoded.trim().startsWith("{")) {
        const obj = JSON.parse(decoded);
        if (obj?.client_email && obj?.private_key) return obj as ServiceAccount;
      }
    } catch {}
  }

  const gac = process.env.GOOGLE_APPLICATION_CREDENTIALS?.trim();
  if (gac) {
    const obj = await tryReadJsonFile(gac);
    if (obj?.client_email && obj?.private_key) return obj as ServiceAccount;
  }

  for (const p of ["service-account.json", "scraper/service-account.json"]) {
    const obj = await tryReadJsonFile(p);
    if (obj?.client_email && obj?.private_key) return obj as ServiceAccount;
  }

  const client_email =
    process.env.GOOGLE_CLIENT_EMAIL?.trim() ||
    process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL?.trim() ||
    "";

  const private_key =
    process.env.GOOGLE_PRIVATE_KEY?.trim() ||
    process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY?.trim() ||
    "";

  if (client_email && private_key) return { client_email, private_key };

  throw new Error(
    "Missing Google credentials. Provide GOOGLE_SERVICE_ACCOUNT_JSON (JSON/path/base64) OR GOOGLE_APPLICATION_CREDENTIALS OR GOOGLE_CLIENT_EMAIL + GOOGLE_PRIVATE_KEY."
  );
}

let _sheets:
  | { sheets: ReturnType<typeof google.sheets>; spreadsheetId: string; tab: string }
  | null = null;

async function getSheetsClient() {
  if (_sheets) return _sheets;
  if (!SHEET_ID) throw new Error("Missing SHEET_ID");

  const sa = await readServiceAccount();
  const clientEmail = sa.client_email;
  const privateKey = normalizePrivateKey(sa.private_key);

  if (!clientEmail || !privateKey) {
    throw new Error("Invalid service account credentials (missing client_email/private_key)");
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

/* ---------------- FX cached (in-memory, 1h) ---------------- */

async function getCnyToEurRateCached(): Promise<number> {
  const ttl = 60 * 60 * 1000;
  const cached = getFxCache();
  if (cached && isFresh(cached.at, ttl)) return cached.data;

  // ✅ in-flight dedupe (anti burst)
  const gg: any = g();
  if (gg.__CRAVATTA_FX_INFLIGHT) return gg.__CRAVATTA_FX_INFLIGHT as Promise<number>;

  gg.__CRAVATTA_FX_INFLIGHT = (async () => {
    const rate = await getCnyToEurRate();
    setFxCache({ at: Date.now(), data: rate });
    return rate;
  })().finally(() => {
    gg.__CRAVATTA_FX_INFLIGHT = null;
  });

  return gg.__CRAVATTA_FX_INFLIGHT as Promise<number>;
}

/* ---------------- row parsing ---------------- */

function parseRowFixed(
  row: string[],
  rowNumber: number,
  cnyToEur: number,
  mode: ParseMode
): SheetItem | null {
  const title = String(row[2] ?? "").trim();
  const source_url = String(row[17] ?? "").trim();

  if (!title && !source_url && !row.some((c) => String(c ?? "").trim() !== "")) return null;

  const id = String(row[0] ?? "").trim() || `row-${rowNumber}`;
  const rawSlug = String(row[1] ?? "").trim();
  const slug = rawSlug ? slugify(rawSlug) : slugify(title) || id;

  const brand = String(row[3] ?? "").trim();
  const category = String(row[4] ?? "").trim();
  const seller = String(row[5] ?? "").trim();

  const baseImages: string[] = [];
  for (let i = 6; i <= 13; i++) {
    const v = toBigYupooPhotoUrl(normalizeHttp(String(row[i] ?? "").trim()));
    if (v && isLikelyImageUrl(v)) baseImages.push(v);
  }

  const extraImages = parseExtraImages(String(row[14] ?? ""));
  const headerImages = uniqueKeepOrderImages([...baseImages, ...extraImages]).filter((u) =>
    /^https?:\/\//i.test(u)
  );

  const imagesRaw =
    mode === "full"
      ? uniqueKeepOrderImages([...headerImages, ...scanRowForImageUrls(row)])
      : uniqueKeepOrderImages(headerImages);

  const cover = imagesRaw[0] || "";

  const images =
    mode === "list"
      ? (cover ? [cover] : [])
      : (cover ? [cover, ...imagesRaw.slice(1)] : imagesRaw).slice(0, MAX_FULL_IMAGES);

  const source_price_cny = String(row[18] ?? "").trim();
  const priceCny = toNumberLoose(source_price_cny);
  const priceEur = priceCny == null ? null : Math.round(priceCny * cnyToEur * 100) / 100;

  const tagsRaw = String(row[19] ?? "").trim();
  const tags = uniqueKeepOrder(parseTags(tagsRaw));

  return {
    rowNumber,
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

function toListFromFull(full: SheetItem): SheetItem {
  const cover = full.cover || full.images?.[0] || "";
  return { ...full, cover, images: cover ? [cover] : [] };
}

/* ---------------- META (cached in-memory) ---------------- */

async function _getMetaUncached(): Promise<{ rows: MetaRow[]; facets: Facets }> {
  const { sheets, spreadsheetId, tab } = await getSheetsClient();

  const range = `${tab}!A2:F`;
  const resp = await withBackoff(
    () => sheets.spreadsheets.values.get({ spreadsheetId, range }),
    "getMeta(values.get)"
  );

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

  return { rows, facets };
}

async function getMeta(): Promise<{ rows: MetaRow[]; facets: Facets }> {
  const ttl = TTL_MS();
  const cached = getMetaCache();
  if (cached && isFresh(cached.at, ttl)) return cached.data;

  // ✅ in-flight dedupe (anti burst quando scade cache)
  const gg: any = g();
  if (gg.__CRAVATTA_META_INFLIGHT) return gg.__CRAVATTA_META_INFLIGHT as Promise<{ rows: MetaRow[]; facets: Facets }>;

  gg.__CRAVATTA_META_INFLIGHT = _getMetaUncached()
    .then((data) => {
      setMetaCache({ at: Date.now(), data });
      return data;
    })
    .finally(() => {
      gg.__CRAVATTA_META_INFLIGHT = null;
    });

  return gg.__CRAVATTA_META_INFLIGHT as Promise<{ rows: MetaRow[]; facets: Facets }>;
}

/* ---------------- filters ---------------- */

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

/* ---------------- fetch rows (batchGet, with row cache) ---------------- */

async function batchFetchRows(rowNumbers: number[]) {
  if (!rowNumbers.length) return new Map<number, string[]>();

  const { sheets, spreadsheetId, tab } = await getSheetsClient();
  const ranges = rowNumbers.map((rn) => `${tab}!A${rn}:T${rn}`);

  const resp = await withBackoff(
    () => sheets.spreadsheets.values.batchGet({ spreadsheetId, ranges }),
    "fetchRows(batchGet)"
  );

  const out = new Map<number, string[]>();

  for (const vr of resp.data.valueRanges || []) {
    const range = String(vr.range || "");
    const m = range.match(/!A(\d+):T\1$/);
    const rowNumber = m ? Number(m[1]) : NaN;

    const rawRow = (vr.values?.[0] || []) as any[];
    const cells = Array.isArray(rawRow) ? rawRow.map((c) => String(c ?? "")) : [];
    while (cells.length < 20) cells.push("");

    if (Number.isFinite(rowNumber)) out.set(rowNumber, cells);
  }

  return out;
}

async function fetchItemsByRowNumbers(rowNumbers: number[], mode: ParseMode): Promise<SheetItem[]> {
  const ttl = TTL_MS();
  const listC = rowListCache();
  const fullC = rowFullCache();
  const cache = mode === "full" ? fullC : listC;

  const missing: number[] = [];
  for (const rn of rowNumbers) {
    const ce = cache.get(rn);
    if (!ce || !isFresh(ce.at, ttl)) missing.push(rn);
  }

  if (missing.length) {
    const rowsMap = await batchFetchRows(missing);
    const cnyToEur = await getCnyToEurRateCached();

    for (const rn of missing) {
      const cells = rowsMap.get(rn);
      if (!cells) continue;

      if (mode === "full") {
        const full = parseRowFixed(cells, rn, cnyToEur, "full");
        if (full) {
          fullC.set(rn, { at: Date.now(), data: full });
          listC.set(rn, { at: Date.now(), data: toListFromFull(full) });
        }
      } else {
        const list = parseRowFixed(cells, rn, cnyToEur, "list");
        if (list) listC.set(rn, { at: Date.now(), data: list });
      }
    }
  }

  const out: SheetItem[] = [];
  for (const rn of rowNumbers) {
    const ce = cache.get(rn);
    if (ce && isFresh(ce.at, ttl)) out.push(ce.data);
  }
  return out;
}

/* ---------------- public APIs ---------------- */

export async function getItemsPage(page: number, pageSize = 42): Promise<PageResult> {
  const p = Math.max(1, Math.floor(Number(page) || 1));
  const ps = Math.max(1, Math.floor(Number(pageSize) || 42));

  const meta = await getMeta();
  const totalItems = meta.rows.length;
  const totalPages = Math.max(1, Math.ceil(totalItems / ps));
  const safePage = Math.min(p, totalPages);

  const startIdx = (safePage - 1) * ps;
  const sliceRows = meta.rows.slice(startIdx, startIdx + ps).map((r) => r.rowNumber);

  const items = await fetchItemsByRowNumbers(sliceRows, "list");
  return { items, page: safePage, pageSize: ps, totalItems, totalPages };
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

  const meta = await getMeta();
  const allFacets = meta.facets;

  const filteredRowNumbers = filterRowNumbers(meta.rows, { q, brand, category, seller });
  const orderedRowNumbers =
    order === "default" ? filteredRowNumbers : getOrBuildShuffled(filterSeedKey, filteredRowNumbers);

  const totalItems = orderedRowNumbers.length;
  const totalPages = Math.max(1, Math.ceil(totalItems / ps));
  const safePage = clamp(p, 1, totalPages);

  const startIdx = (safePage - 1) * ps;
  const slice = orderedRowNumbers.slice(startIdx, startIdx + ps);

  const items = await fetchItemsByRowNumbers(slice, "list");

  return {
    items,
    page: safePage,
    pageSize: ps,
    totalItems,
    totalPages,
    facets: allFacets,
    order,
  };
}

export async function getItemsPreview(limit = 18): Promise<SheetItem[]> {
  const ps = Math.max(1, Math.floor(Number(limit) || 18));
  const res = await getItemsPage(1, ps);
  return res.items;
}

export async function getItemsHead(limit = 120): Promise<SheetItem[]> {
  const ps = Math.max(1, Math.floor(Number(limit) || 120));
  const res = await getItemsPage(1, ps);
  return res.items;
}

/* ---------------- item lookup (FULL mode) ---------------- */

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
    const meta = await getMeta();

    const bySlug = new Map<string, number>();
    const byTitle = new Map<string, number>();
    const byId = new Map<string, number>();

    meta.rows.forEach((r) => {
      const idKey = normalizeSlug(r.id);
      const slugKey = normalizeSlug(r.slug);
      const titleKey = normalizeSlug(r.title);

      if (idKey && !byId.has(idKey)) byId.set(idKey, r.rowNumber);
      if (slugKey && !bySlug.has(slugKey)) bySlug.set(slugKey, r.rowNumber);
      if (titleKey && !byTitle.has(titleKey)) byTitle.set(titleKey, r.rowNumber);
    });

    indexCache = { ts: now, bySlug, byTitle, byId };
  }

  const rowNumber =
    indexCache.bySlug.get(wanted) ??
    indexCache.byTitle.get(wanted) ??
    indexCache.byId.get(wanted);

  if (!rowNumber) return null;

  const items = await fetchItemsByRowNumbers([rowNumber], "full");
  return items[0] || null;
}

/* ---------------- safety API (rarely used) ---------------- */

export async function getItemsFromSheet(): Promise<SheetItem[]> {
  const meta = await getMeta();
  const total = meta.rows.length;

  const HARD_CAP = Number(process.env.MAX_LOAD_ALL_ITEMS || "5000");
  if (total > HARD_CAP) {
    throw new Error(
      `Too many items (${total}). Don't use getItemsFromSheet() with big sheets. Use getItemsPage() or getSpreadsheetPage().`
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