// src/lib/imgProxy.ts
export type ImgSize = "small" | "medium" | "big";

export function isProxyUrl(u: string) {
  const s = (u ?? "").trim();
  return s.startsWith("/api/img?") || s.includes("/api/img?url=");
}

export function isYupooUrl(u: string) {
  const s = (u ?? "").trim().toLowerCase();
  return (
    s.includes("photo.yupoo.com") ||
    s.includes(".yupoo.com/") ||
    s.includes("u.yupoo.com") ||
    s.includes("wd.yupoo.com")
  );
}

/** Forza/aggiunge size=... anche se l’URL è già /api/img?... */
export function forceImgSize(proxyUrl: string, size: ImgSize) {
  const s = (proxyUrl ?? "").trim();
  if (!s) return "";

  try {
    // gestisce sia URL relativi che assoluti
    const base = s.startsWith("http") ? undefined : "http://local";
    const url = new URL(s, base);

    // se non è la route, non tocchiamo
    if (!url.pathname.includes("/api/img")) return s;

    url.searchParams.set("size", size);

    if (base) return `${url.pathname}?${url.searchParams.toString()}`;
    return url.toString();
  } catch {
    // fallback robusto
    if (s.includes("size=")) return s.replace(/([?&])size=[^&]+/i, `$1size=${size}`);
    return s + (s.includes("?") ? "&" : "?") + `size=${size}`;
  }
}

/** Crea URL proxato /api/img?url=...&size=... (se già proxato -> force size) */
export function imgProxy(url: string, size: ImgSize = "medium") {
  const u = (url ?? "").trim();
  if (!u) return "";
  if (isProxyUrl(u)) return forceImgSize(u, size);
  return `/api/img?url=${encodeURIComponent(u)}&size=${size}`;
}

/** Usa proxy SOLO per Yupoo; per altri host lascia l’URL com’è */
export function toProxyIfNeeded(url: string, size: ImgSize = "small") {
  const u = (url ?? "").trim();
  if (!u) return "";
  if (u.startsWith("data:")) return u;

  if (isProxyUrl(u)) return forceImgSize(u, size);
  if (isYupooUrl(u)) return imgProxy(u, size);

  return u;
}
