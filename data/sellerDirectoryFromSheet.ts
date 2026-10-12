import "server-only";
import { GoogleSpreadsheet } from "google-spreadsheet";
import { auth } from "@/data/sellersFromSheet";

export type DirectorySeller = {
  name: string;
  spreadsheetSeller: string;
  officialUrl: string;
  brands: string[];
};
export type BrandSection = {
  id: string;
  name: string;
  cover: string;
  sellers: DirectorySeller[];
};

const clean = (value: unknown) => String(value ?? "").trim();
const read = (row: { get: (field: string) => unknown }, field: string) => clean(row.get(field));
const canonical = (value: string) => value.normalize("NFKC").trim().toLocaleLowerCase("it");
const splitBrands = (value: string) => value.split(/[,;|\n]+/).map(clean).filter(Boolean);
const imageUrl = (value: string) => value.startsWith("/") || /^https:\/\//i.test(value) ? value : "";
const officialUrl = (value: string) => /^https?:\/\//i.test(value) ? value : "";
const collator = new Intl.Collator("it", { sensitivity: "base", numeric: true });

let cache: { timestamp: number; value: BrandSection[] } | null = null;

export async function getBrandSellerDirectory(): Promise<BrandSection[]> {
  if (cache && Date.now() - cache.timestamp < 60_000) return cache.value;
  const documentId = process.env.SELLERS_SHEET_ID;
  if (!documentId) throw new Error("Imposta SELLERS_SHEET_ID in .env.local");

  try {
    const doc = new GoogleSpreadsheet(documentId, auth());
    await doc.loadInfo();
    const brandSheet = doc.sheetsById[1321971455];
    const sellerSheet = doc.sheetsById[466865418];
    if (!brandSheet || !sellerSheet) {
      throw new Error("Servono solamente le schede seller_brand e seller_directory");
    }

    const [brandRows, sellerRows] = await Promise.all([brandSheet.getRows(), sellerSheet.getRows()]);
    const byBrand = new Map<string, BrandSection>();
    for (const row of brandRows) {
      const name = read(row, "brand");
      if (!name) continue;
      const id = canonical(name);
      if (!byBrand.has(id)) {
        byBrand.set(id, { id, name, cover: imageUrl(read(row, "cover_image")), sellers: [] });
      }
    }

    for (const row of sellerRows) {
      const name = read(row, "name");
      if (!name) continue;
      const seller: DirectorySeller = {
        name,
        spreadsheetSeller: read(row, "spreadsheet_seller"),
        officialUrl: officialUrl(read(row, "official_url")),
        brands: splitBrands(read(row, "brands")),
      };
      const alreadyAdded = new Set<string>();
      for (const entry of seller.brands) {
        const brandId = canonical(entry);
        const brand = byBrand.get(brandId);
        if (!brand || alreadyAdded.has(brandId)) continue;
        alreadyAdded.add(brandId);
        if (!brand.sellers.some(existing => canonical(existing.name) === canonical(name))) {
          brand.sellers.push(seller);
        }
      }
    }
    const value = [...byBrand.values()].sort((a, b) => collator.compare(a.name, b.name));
    value.forEach(brand => brand.sellers.sort((a, b) => collator.compare(a.name, b.name)));
    cache = { timestamp: Date.now(), value };
    return value;
  } catch (error) {
    if (cache) return cache.value;
    throw error;
  }
}
