import { google } from "googleapis";
import crypto from "node:crypto";

type CacheEntry<T> = { exp: number; value?: T; promise?: Promise<T> };

// TTL cache (ms). In dev puoi alzarlo (es: 120000) per non bruciare quota con HMR.
const TTL_MS = Number(process.env.SHEETS_TTL_MS ?? 30_000);

function mustEnv(name: string) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

function normalizePrivateKey(key: string) {
  return key.replace(/\\n/g, "\n");
}

function getSheetsClient() {
  const g = globalThis as any;
  if (g.__SHEETS_V4__) return g.__SHEETS_V4__;

  const email =
    process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL ||
    process.env.GOOGLE_CLIENT_EMAIL ||
    process.env.GOOGLE_SERVICE_ACCOUNT_CLIENT_EMAIL;

  const key =
    process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY ||
    process.env.GOOGLE_PRIVATE_KEY ||
    process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY_PEM;

  if (!email) throw new Error("Missing env: GOOGLE_SERVICE_ACCOUNT_EMAIL (or GOOGLE_CLIENT_EMAIL)");
  if (!key) throw new Error("Missing env: GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY (or GOOGLE_PRIVATE_KEY)");

  const auth = new google.auth.JWT({
  email,
  key: normalizePrivateKey(key),
  scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
});

  g.__SHEETS_V4__ = google.sheets({ version: "v4", auth });
  return g.__SHEETS_V4__;
}

function getMemCache(): Map<string, CacheEntry<any>> {
  const g = globalThis as any;
  if (!g.__SHEETS_MEM_CACHE__) g.__SHEETS_MEM_CACHE__ = new Map();
  return g.__SHEETS_MEM_CACHE__;
}

async function memo<T>(key: string, fn: () => Promise<T>, ttlMs = TTL_MS): Promise<T> {
  const mem = getMemCache();
  const now = Date.now();
  const hit = mem.get(key);

  if (hit?.value !== undefined && hit.exp > now) return hit.value;
  if (hit?.promise) return hit.promise;

  const p = fn()
    .then((v) => {
      mem.set(key, { exp: Date.now() + ttlMs, value: v });
      return v;
    })
    .catch((e) => {
      mem.delete(key);
      throw e;
    });

  mem.set(key, { exp: now + ttlMs, promise: p });
  return p;
}

function toSegments(rows: number[]): Array<[number, number]> {
  const uniq = Array.from(new Set(rows.filter((n) => Number.isFinite(n) && n > 0))).sort((a, b) => a - b);
  if (!uniq.length) return [];
  const segs: Array<[number, number]> = [];
  let s = uniq[0], e = uniq[0];
  for (let i = 1; i < uniq.length; i++) {
    const r = uniq[i];
    if (r === e + 1) e = r;
    else { segs.push([s, e]); s = e = r; }
  }
  segs.push([s, e]);
  return segs;
}

/**
 * Legge righe specifiche con UNA sola request batchGet (per segmenti contigui).
 * Ritorna un array di row values nello stesso ordine di rowNumbers.
 */
export async function fetchRowsByNumbersCached(rowNumbers: number[]) {
  const spreadsheetId = mustEnv("SHEET_ID");

  // Allineati ai tuoi env (adattali se usi nomi diversi)
  const tab = process.env.ITEMS_TAB || process.env.TAB || "items";
  const colLast = process.env.ITEMS_COL_LAST || process.env.COL_LAST || "K";

  const segs = toSegments(rowNumbers);
  if (!segs.length) return [];

  const sig = `${tab}|${colLast}|` + segs.map(([a, b]) => `${a}-${b}`).join(",");
  const key = "rows:" + crypto.createHash("sha1").update(sig).digest("hex");

  return memo(key, async () => {
    const sheets = getSheetsClient();
    const ranges = segs.map(([a, b]) => `${tab}!A${a}:${colLast}${b}`);

    const res = await sheets.spreadsheets.values.batchGet({
      spreadsheetId,
      ranges,
      valueRenderOption: "UNFORMATTED_VALUE",
    });

    const valueRanges = res.data.valueRanges ?? [];
    const map = new Map<number, any[]>();

    for (let idx = 0; idx < segs.length; idx++) {
      const [start] = segs[idx];
      const vals = valueRanges[idx]?.values ?? [];
      for (let i = 0; i < vals.length; i++) {
        map.set(start + i, vals[i]);
      }
    }

    return rowNumbers.map((r) => map.get(r) ?? []);
  });
}
