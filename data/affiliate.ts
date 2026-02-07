// data/affiliate.ts

/**
 * Estrae un parametro in modo "robusto" (supporta itemID / itemId).
 */
function getParam(url: URL, keys: string[]) {
  for (const k of keys) {
    const v = url.searchParams.get(k);
    if (v && v.trim()) return v.trim();
  }
  return null;
}

/**
 * Converte un link Taobao/Tmall/Weidian nel link USFans.
 * Ritorna null se il link non è supportato.
 */
export function toUsFansProductUrl(inputUrl: string, ref: string = "R9K9XG") {
  let url: URL;

  try {
    url = new URL(inputUrl.trim());
  } catch {
    return null;
  }

  const host = url.hostname.toLowerCase();

  // già USFans
  if (host.includes("usfans.com")) return inputUrl;

  // --- TAOBAO / TMALL ---
  if (host.includes("taobao.com") || host.includes("tmall.com")) {
    const id = getParam(url, ["id"]);
    if (!id) return null;

    return `https://www.usfans.com/product/2/${encodeURIComponent(
      id
    )}?ref=${encodeURIComponent(ref)}`;
  }

  // --- WEIDIAN ---
  if (host.includes("weidian.com")) {
    const itemID = getParam(url, ["itemID", "itemId"]);
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
 * Converte un link Taobao/Tmall/Weidian nel link MuleBuy.
 *
 * - Taobao/Tmall:
 *   https://item.taobao.com/item.htm?id=1017471752032
 *   -> https://mulebuy.com/product?id=1017471752032&platform=TAOBAO&ref=200836051
 *
 * - Weidian:
 *   https://shopxxxx.v.weidian.com/item.html?itemID=7611477165
 *   -> https://mulebuy.com/product?id=7611477165&platform=WEIDIAN&ref=200836051
 */
export function toMulebuyProductUrl(
  inputUrl: string,
  ref: string = "200836051"
) {
  let url: URL;

  try {
    url = new URL(inputUrl.trim());
  } catch {
    return null;
  }

  const host = url.hostname.toLowerCase();

  // già MuleBuy
  if (host.includes("mulebuy.com")) return inputUrl;

  // --- TAOBAO / TMALL ---
  if (host.includes("taobao.com") || host.includes("tmall.com")) {
    const id = getParam(url, ["id"]);
    if (!id) return null;

    return `https://mulebuy.com/product?id=${encodeURIComponent(
      id
    )}&platform=TAOBAO&ref=${encodeURIComponent(ref)}`;
  }

  // --- WEIDIAN ---
  if (host.includes("weidian.com")) {
    const itemID = getParam(url, ["itemID", "itemId"]);
    if (!itemID) return null;

    return `https://mulebuy.com/product?id=${encodeURIComponent(
      itemID
    )}&platform=WEIDIAN&ref=${encodeURIComponent(ref)}`;
  }

  return null;
}
