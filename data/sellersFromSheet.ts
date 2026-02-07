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

/**
 * Prova a leggere il JSON del service account da:
 * - GOOGLE_SERVICE_ACCOUNT_JSON (path o JSON string)
 * - GOOGLE_APPLICATION_CREDENTIALS (path al JSON)
 * - scraper/service-account.json
 * - service-account.json
 */
function tryReadServiceAccountJson(): { email: string; key: string } | null {
  const candidates = [
    process.env.GOOGLE_SERVICE_ACCOUNT_JSON,
    process.env.GOOGLE_APPLICATION_CREDENTIALS,
    "scraper/service-account.json",
    "service-account.json",
  ].filter(Boolean) as string[];

  for (const p of candidates) {
    try {
      // ✅ se è già JSON (inizia con "{"), parsalo direttamente
      if (p.trim().startsWith("{")) {
        const j = JSON.parse(p);
        const email = String(j.client_email || "").trim();
        const key = String(j.private_key || "").trim();
        if (email && key) return { email, key: normalizePrivateKey(key) };
        continue;
      }

      // altrimenti trattalo come path
      const abs = path.isAbsolute(p) ? p : path.join(process.cwd(), p);
      if (!fs.existsSync(abs)) continue;

      const raw = fs.readFileSync(abs, "utf8");
      const j = JSON.parse(raw);

      const email = String(j.client_email || "").trim();
      const key = String(j.private_key || "").trim();

      if (email && key) {
        return { email, key: normalizePrivateKey(key) };
      }
    } catch {
      // ignore e prova il prossimo
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
  const raw =
    (typeof row.get === "function" ? row.get(key) : row?.[key]) ?? "";
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

export async function getSellersAndCards(): Promise<{
  sellers: Seller[];
  cards: SellerCard[];
}> {
  const SHEET_ID =
    process.env.SELLERS_SHEET_ID || process.env.SHEET_ID || mustEnv("SHEET_ID");

  const TAB_SELLERS = process.env.SELLERS_TAB || "sellers";
  const TAB_CARDS = process.env.SELLER_CARDS_TAB || "seller_cards";

  const doc = new GoogleSpreadsheet(SHEET_ID, auth());
  await doc.loadInfo();

  const sellersSheet = pickSheetOrThrow(doc, TAB_SELLERS, 0);
  const cardsSheet = pickSheetOrThrow(doc, TAB_CARDS, 1);

  const sellerRows = await sellersSheet.getRows();
  const cardRows = await cardsSheet.getRows();

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

  return { sellers, cards };
}

/**
 * ✅ Adapter per la Home (quello che importi in app/page.tsx)
 * Formato compatibile con components/SellersSection.tsx
 */
export async function getSellersFromSheet(): Promise<
  { name: string; description?: string; tags?: string[]; verified?: boolean; href?: string }[]
> {
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

    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    const tags = Array.isArray(s.tags) ? s.tags : [];
    const href = (s.store_url || s.yupoo_url || "/sellers") ?? "/sellers";

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
}
