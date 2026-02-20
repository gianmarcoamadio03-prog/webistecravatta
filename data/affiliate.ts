// data/affiliate.ts

/**
 * Estrae un parametro in modo "robusto" (supporta varianti di casing).
 */
function getParam(url: URL, keys: string[]) {
  for (const k of keys) {
    const v = url.searchParams.get(k);
    if (v && v.trim()) return v.trim();
  }
  return null;
}

/**
 * Prova a costruire un URL anche se manca lo schema (https://).
 */
function safeUrl(input: string): URL | null {
  const s = input.trim();
  if (!s) return null;

  try {
    return new URL(s);
  } catch {
    try {
      return new URL(`https://${s.replace(/^\/\//, "")}`);
    } catch {
      return null;
    }
  }
}

function normalizeHost(hostname: string) {
  return hostname.toLowerCase().trim();
}

/**
 * Estrae l'offerId da URL 1688 tipo:
 * - https://detail.1688.com/offer/983510390062.html
 * - https://m.1688.com/offer/983510390062.html
 * - https://detail.1688.com/offer/983510390062.html?spm=...
 */
function extract1688OfferId(url: URL): string | null {
  const host = normalizeHost(url.hostname);

  // accetta: detail.1688.com, m.1688.com, 1688.com, ecc.
  if (!host.includes("1688.com")) return null;

  // pattern più comune: /offer/<id>.html
  const m = url.pathname.match(/\/offer\/(\d+)\.html/i);
  if (m?.[1]) return m[1];

  // fallback: alcune varianti potrebbero avere id in query (raro)
  const q = getParam(url, ["offerId", "offerID", "offer_id", "id"]);
  if (q && /^\d+$/.test(q)) return q;

  return null;
}

/**
 * Converte un link Taobao/Tmall/Weidian/1688 nel link USFans.
 * Ritorna null se il link non è supportato.
 */
export function toUsFansProductUrl(inputUrl: string, ref: string = "R9K9XG") {
  const url = safeUrl(inputUrl);
  if (!url) return null;

  const host = normalizeHost(url.hostname);

  // già USFans
  if (host.includes("usfans.com")) return inputUrl.trim();

  // --- 1688 (ALI_1688) ---
  // USFans: product/1/<offerId>
  const offerId = extract1688OfferId(url);
  if (offerId) {
    return `https://www.usfans.com/product/1/${encodeURIComponent(
      offerId
    )}?ref=${encodeURIComponent(ref)}`;
  }

  // --- TAOBAO / TMALL ---
  if (host.includes("taobao.com") || host.includes("tmall.com")) {
    // alcuni casi usano anche item_id
    const id = getParam(url, ["id", "item_id", "itemId", "itemID"]);
    if (!id) return null;

    return `https://www.usfans.com/product/2/${encodeURIComponent(
      id
    )}?ref=${encodeURIComponent(ref)}`;
  }

  // --- WEIDIAN ---
  if (host.includes("weidian.com")) {
    const itemID = getParam(url, ["itemID", "itemId", "itemid", "item_id"]);
    if (!itemID) return null;

    return `https://www.usfans.com/product/3/${encodeURIComponent(
      itemID
    )}?ref=${encodeURIComponent(ref)}`;
  }

  return null;
}

/**
 * 🔁 BACKWARD COMPAT:
 * se nel sito hai ancora import tipo:
 * import { toCnFansProductUrl } from "@/data/affiliate";
 *
 * allora NON rompi nulla: ora punta a USFans.
 */
export function toCnFansProductUrl(inputUrl: string, ref: string = "R9K9XG") {
  return toUsFansProductUrl(inputUrl, ref);
}

/**
 * Converte un link Taobao/Tmall/Weidian/1688 nel link MuleBuy.
 */
export function toMulebuyProductUrl(
  inputUrl: string,
  ref: string = "200836051"
) {
  const url = safeUrl(inputUrl);
  if (!url) return null;

  const host = normalizeHost(url.hostname);

  // già MuleBuy
  if (host.includes("mulebuy.com")) return inputUrl.trim();

  // --- 1688 (ALI_1688) ---
  // MuleBuy: product?id=<offerId>&platform=ALI_1688
  const offerId = extract1688OfferId(url);
  if (offerId) {
    return `https://mulebuy.com/product?id=${encodeURIComponent(
      offerId
    )}&platform=ALI_1688&ref=${encodeURIComponent(ref)}`;
  }

  // --- TAOBAO / TMALL ---
  if (host.includes("taobao.com") || host.includes("tmall.com")) {
    const id = getParam(url, ["id", "item_id", "itemId", "itemID"]);
    if (!id) return null;

    return `https://mulebuy.com/product?id=${encodeURIComponent(
      id
    )}&platform=TAOBAO&ref=${encodeURIComponent(ref)}`;
  }

  // --- WEIDIAN ---
  if (host.includes("weidian.com")) {
    const itemID = getParam(url, ["itemID", "itemId", "itemid", "item_id"]);
    if (!itemID) return null;

    return `https://mulebuy.com/product?id=${encodeURIComponent(
      itemID
    )}&platform=WEIDIAN&ref=${encodeURIComponent(ref)}`;
  }

  return null;
}
