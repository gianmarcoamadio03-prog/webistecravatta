// data/sellersFromSheet.ts
import "server-only";
import fs from "node:fs";
import path from "node:path";
import { GoogleSpreadsheet } from "google-spreadsheet";
import { JWT } from "google-auth-library";
import type { Seller, SellerCard } from "./sellersShared";

function mustEnv(name: string) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

function normalizePrivateKey(key: string) {
  return key.replace(/\\n/g, "\n");
}

function tryReadServiceAccountJson(): { email: string; key: string } | null {
  const candidates = [
    process.env.GOOGLE_SERVICE_ACCOUNT_JSON,
    process.env.GOOGLE_APPLICATION_CREDENTIALS,
    "scraper/service-account.json",
    "service-account.json",
  ].filter(Boolean) as string[];

  for (const p of candidates) {
    try {
      if (p.trim().startsWith("{")) {
        const j = JSON.parse(p);
        const email = String(j.client_email || "").trim();
        const key = String(j.private_key || "").trim();
        if (email && key) return { email, key: normalizePrivateKey(key) };
        continue;
      }

      const abs = path.isAbsolute(p) ? p : path.join(process.cwd(), p);
      if (!fs.existsSync(abs)) continue;

      const raw = fs.readFileSync(abs, "utf8");
      const j = JSON.parse(raw);

      const email = String(j.client_email || "").trim();
      const key = String(j.private_key || "").trim();

      if (email && key) return { email, key: normalizePrivateKey(key) };
    } catch {
      // ignore
    }
  }
  return null;
}

function auth() {
  const email =
    process.env.GOOGLE_CLIENT_EMAIL ||
    process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL ||
    process.env.GCP_CLIENT_EMAIL;

  let key =
    process.env.GOOGLE_PRIVATE_KEY ||
    process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY ||
    process.env.GCP_PRIVATE_KEY;

  if (email && key) {
    key = normalizePrivateKey(key);
    return new JWT({
      email,
      key,
      scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
    });
  }

  const fromJson = tryReadServiceAccountJson();
  if (fromJson) {
    return new JWT({
      email: fromJson.email,
      key: fromJson.key,
      scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
    });
  }

  throw new Error(
    [
      "Missing Google Service Account creds.",
      "Opzioni supportate:",
      '- set GOOGLE_CLIENT_EMAIL + GOOGLE_PRIVATE_KEY in ".env.local"',
      "- oppure set GOOGLE_SERVICE_ACCOUNT_JSON (path o JSON string)",
      "- oppure set GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json",
    ].join("\n")
  );
}

function pickSheetOrThrow(
  doc: GoogleSpreadsheet,
  preferredTitle: string,
  fallbackIndex: number
) {
  const byTitle = doc.sheetsByTitle?.[preferredTitle];
  const byIndex = doc.sheetsByIndex?.[fallbackIndex];
  const sheet = byTitle ?? byIndex;

  if (!sheet) {
    const available = Object.keys(doc.sheetsByTitle || {});
    throw new Error(
      [
        `Sheet tab non trovato: "${preferredTitle}" (fallback index ${fallbackIndex}).`,
        available.length
          ? `Tabs disponibili: ${available.join(", ")}`
          : "Nessun tab disponibile.",
        "",
        "➡️ Fix:",
        `- crea/renomina il tab in Google Sheets a "${preferredTitle}"`,
        `- oppure setta in .env.local:`,
        `  SELLERS_TAB="nome_esatto_tab_sellers"`,
        `  SELLER_CARDS_TAB="nome_esatto_tab_cards"`,
      ].join("\n")
    );
  }

  return sheet;
}

function v(row: any, key: string) {
  const raw = (typeof row.get === "function" ? row.get(key) : row?.[key]) ?? "";
  const s = String(raw).trim();
  return s.length ? s : "";
}

function splitTags(raw: string): string[] {
  if (!raw) return [];
  const parts = raw
    .split(/[,;|/\n]+/g)
    .map((x) => x.trim())
    .filter(Boolean);

  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of parts) {
    const k = p.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(p);
  }
  return out;
}

/* ---------------- retry + cache (anti 503) ---------------- */

function isRetryable(err: any) {
  const msg = String(err?.message || err || "");
  return (
    msg.includes("[503]") ||
    msg.includes(" 503") ||
    msg.includes("503") ||
    msg.includes("[429]") ||
    msg.includes(" 429") ||
    msg.includes("ETIMEDOUT") ||
    msg.includes("ECONNRESET") ||
    msg.includes("EAI_AGAIN") ||
    msg.includes("ENOTFOUND")
  );
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function withRetry<T>(fn: () => Promise<T>, tries = 3) {
  let lastErr: any = null;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (!isRetryable(e) || i === tries - 1) break;
      await sleep(250 * Math.pow(2, i)); // 250ms, 500ms, 1s
    }
  }
  throw lastErr;
}

type CacheKey = string;
type CacheVal = { at: number; data: { sellers: Seller[]; cards: SellerCard[] } };

function cacheStore(): Map<CacheKey, CacheVal> {
  const g = globalThis as any;
  if (!g.__CRAVATTA_SELLERS_CACHE) g.__CRAVATTA_SELLERS_CACHE = new Map();
  return g.__CRAVATTA_SELLERS_CACHE as Map<CacheKey, CacheVal>;
}

export async function getSellersAndCards(): Promise<{
  sellers: Seller[];
  cards: SellerCard[];
}> {
  const SHEET_ID =
    process.env.SELLERS_SHEET_ID || process.env.SHEET_ID || mustEnv("SHEET_ID");

  const TAB_SELLERS = process.env.SELLERS_TAB || "sellers";
  const TAB_CARDS = process.env.SELLER_CARDS_TAB || "seller_cards";

  const key = `${SHEET_ID}::${TAB_SELLERS}::${TAB_CARDS}`;
  const store = cacheStore();
  const cached = store.get(key);

  // cache breve (dev friendly)
  const TTL = 60_000; // 60s
  if (cached && Date.now() - cached.at < TTL) return cached.data;

  try {
    const doc = new GoogleSpreadsheet(SHEET_ID, auth());

    await withRetry(() => doc.loadInfo(), 3);

    const sellersSheet = pickSheetOrThrow(doc, TAB_SELLERS, 0);
    const cardsSheet = pickSheetOrThrow(doc, TAB_CARDS, 1);

    const sellerRows = await withRetry(() => sellersSheet.getRows(), 3);
    const cardRows = await withRetry(() => cardsSheet.getRows(), 3);

    const sellers: Seller[] = sellerRows
      .map((r: any) => {
        const id = v(r, "id");
        const name = v(r, "name");
        const tagsRaw = v(r, "tags") || v(r, "specialities") || v(r, "brands");
        if (!id || !name) return null;

        return {
          id,
          name,
          tags: splitTags(tagsRaw),
          yupoo_url: v(r, "yupoo_url") || null,
          whatsapp: v(r, "whatsapp") || null,
          store_url: v(r, "store_url") || null,
        } satisfies Seller;
      })
      .filter(Boolean) as Seller[];

    const cards: SellerCard[] = cardRows
      .map((r: any) => {
        const id = v(r, "id");
        const seller_id = v(r, "seller_id");
        const title = v(r, "title");
        const description = v(r, "description") || v(r, "subtitle");
        const image = v(r, "image");
        if (!id || !seller_id || !title) return null;

        return {
          id,
          seller_id,
          title,
          description: description || null,
          image: image || null,
        } satisfies SellerCard;
      })
      .filter(Boolean) as SellerCard[];

    const data = { sellers, cards };
    store.set(key, { at: Date.now(), data });
    return data;
  } catch (e) {
    // se ho cache vecchia, uso quella invece di “rompere” la home
    if (cached?.data) return cached.data;
    throw e;
  }
}

/**
 * ✅ Adapter per la Home
 */
export async function getSellersFromSheet(): Promise<
  { name: string; description?: string; tags?: string[]; verified?: boolean; href?: string }[]
> {
  try {
    const { sellers } = await getSellersAndCards();

    const seen = new Set<string>();
    const out: {
      name: string;
      description?: string;
      tags?: string[];
      verified?: boolean;
      href?: string;
    }[] = [];

    for (const s of sellers) {
      const name = (s?.name ?? "").trim();
      if (!name) continue;

      const k = name.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);

      const tags = Array.isArray((s as any).tags) ? (s as any).tags : [];
      const href = (s as any).store_url || (s as any).yupoo_url || "/sellers";

      out.push({
        name,
        tags,
        verified: true,
        href,
        description:
          tags.length > 0
            ? `Specialità: ${tags.slice(0, 3).join(" · ")}`
            : "Seller selezionato per consistenza e affidabilità.",
      });
    }

    return out;
  } catch (e) {
    console.error("getSellersFromSheet failed (fallback to []):", e);
    return [];
  }
}
