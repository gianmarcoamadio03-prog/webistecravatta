import "server-only";
import { GoogleSpreadsheet } from "google-spreadsheet";
import { auth } from "@/data/sellersFromSheet";

export type HaulItem = { title: string; url: string };
export type Haul = {
  id: string;
  title: string;
  cover: string;
  weight: string;
  dimensions: string;
  agent: string;
  photos: string[];
  items: HaulItem[];
};

const clean = (x: unknown) => String(x ?? "").trim();
const safeImage = (url: string) => url.startsWith("/") || /^https:\/\//i.test(url) ? url : "";
const safeUrl = (url: string) => /^https?:\/\//i.test(url) ? url : "";
const slugOk = (id: string) => /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id);
const read = (row: { get: (key: string) => unknown }, key: string) => clean(row.get(key));

// Accetta fotografie separate con virgola, barra verticale o a capo.
function parsePhotos(value: string): string[] {
  return [...new Set(value.split(/[,|\r\n]+/).map(s => safeImage(s.trim())).filter(Boolean))];
}

// Riconosce un articolo con URL sulla stessa riga oppure sulla riga successiva.
// Esempi: "Nome ; https://...", "Nome: https://...", "Nome https://...",
// "Nome" seguito da "Link: https://...". Ignora righe vuote.
function parseItems(value: string): HaulItem[] {
  const result: HaulItem[] = [];
  const urlPattern = /https?:\/\/[^\s;|]+/i;

  for (const raw of value.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;

    const match = urlPattern.exec(line);
    if (!match) {
      const title = line.replace(/\s*;\s*$/, "").trim();
      if (title && !/^link\s*:?$/i.test(title)) result.push({ title, url: "" });
      continue;
    }

    const url = safeUrl(match[0].replace(/[),.]+$/, ""));
    const beforeUrl = line.slice(0, match.index)
      .replace(/\s*[;:]\s*$/, "")
      .trim();

    // Una riga "Link: https://..." completa l'articolo precedente.
    if (!beforeUrl || /^link\s*$/i.test(beforeUrl)) {
      const previous = result[result.length - 1];
      if (previous && !previous.url) previous.url = url;
      else result.push({ title: "Articolo", url });
      continue;
    }

    result.push({ title: beforeUrl, url });
  }

  return result;
}

let cached: { time: number; data: Haul[] } | undefined;
export async function getHauls(): Promise<Haul[]> {
  if (cached && Date.now() - cached.time < 60_000) return cached.data;
  const documentId = process.env.HAULS_SHEET_ID;
  if (!documentId) throw new Error("Configura HAULS_SHEET_ID nel file .env.local");
  try {
    const doc = new GoogleSpreadsheet(documentId, auth());
    await doc.loadInfo();
    const tab = doc.sheetsByTitle[process.env.HAULS_TAB || "hauls"];
    if (!tab) throw new Error("La scheda Google deve chiamarsi hauls");
    const rows = await tab.getRows();
    const seen = new Set<string>();
    const data: Haul[] = [];
    for (const row of rows) {
      const id = read(row, "id").toLowerCase();
      const title = read(row, "title");
      const cover = safeImage(read(row, "cover_image"));
      if (!slugOk(id) || !title || !cover || seen.has(id)) continue;
      seen.add(id);
      data.push({
        id, title, cover,
        weight: read(row, "weight_kg"),
        dimensions: read(row, "dimensions_cm"),
        agent: read(row, "shipping_agent"),
        photos: parsePhotos(read(row, "photos")),
        items: parseItems(read(row, "items")),
      });
    }
    cached = { time: Date.now(), data: data.reverse() };
    return cached.data;
  } catch (error) {
    if (cached) return cached.data;
    throw error;
  }
}
