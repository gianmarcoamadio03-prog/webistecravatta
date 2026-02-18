// app/api/img/route.ts
import { NextRequest, NextResponse } from "next/server";

// ✅ Edge = cold start più basso + caching CDN efficace
export const runtime = "edge";

type ImgSize = "small" | "medium" | "big";

/**
 * ✅ IMPORTANTISSIMO: Allowlist host consentiti.
 * Senza questa lista, /api/img diventa un "open proxy" e ti brucia Fast Origin Transfer.
 */
const ALLOWED_HOST_SUFFIXES = [".yupoo.com"];

function isAllowedHost(hostname: string) {
  const h = hostname.toLowerCase().trim();
  return ALLOWED_HOST_SUFFIXES.some((suf) => h === suf.slice(1) || h.endsWith(suf));
}

function isBlockedHost(hostname: string) {
  const h = hostname.toLowerCase().trim();

  if (h === "localhost" || h === "127.0.0.1" || h === "0.0.0.0" || h === "::1") return true;

  const ipLike = /^\d{1,3}(\.\d{1,3}){3}$/.test(h);
  if (ipLike) {
    const parts = h.split(".").map((n) => Number(n));
    const [a, b] = parts;

    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
  }

  return false;
}

function parseSize(v: string | null): ImgSize {
  const s = (v ?? "").toLowerCase().trim();
  if (s === "small" || s === "medium" || s === "big") return s;
  return "medium";
}

/**
 * ✅ Yupoo spesso usa /small.jpg /medium.jpg /big.jpg
 * Qui riscriviamo SOLO la parte finale del pathname se matcha.
 */
function rewriteYupooSize(u: URL, size: ImgSize) {
  const p = u.pathname;

  const re = /\/(small|medium|big|thumb)\.(jpg|jpeg|png|webp)$/i;
  if (re.test(p)) {
    u.pathname = p.replace(re, `/${size}.$2`);
    return u;
  }

  if (p.endsWith("/big.jpg")) u.pathname = p.replace(/\/big\.jpg$/, `/${size}.jpg`);
  else if (p.endsWith("/medium.jpg")) u.pathname = p.replace(/\/medium\.jpg$/, `/${size}.jpg`);
  else if (p.endsWith("/small.jpg")) u.pathname = p.replace(/\/small\.jpg$/, `/${size}.jpg`);

  return u;
}

/**
 * ✅ NEW: se l'url è tipo .../abcd1234.jpg (non big/medium/small),
 * quando chiedi size=small/medium/big proviamo anche:
 *   .../small.jpg (o small.jpeg, etc)
 * e se non va -> fallback all'originale.
 */
function buildCandidates(original: URL, size: ImgSize): URL[] {
  const out: URL[] = [];

  // 1) tenta rewrite classico (big.jpg -> small.jpg, ecc)
  {
    const u = new URL(original.toString());
    const before = u.pathname;
    rewriteYupooSize(u, size);
    if (u.pathname !== before) out.push(u);
  }

  // 2) tenta sostituendo l'ultimo filename con small/medium/big.<ext>
  //    es: /xxxx/f720b9ef.jpg -> /xxxx/small.jpg
  {
    const p = original.pathname;
    const m = p.match(/\/([^/]+)\.(jpg|jpeg|png|webp)$/i);
    if (m) {
      const base = m[1].toLowerCase();
      const ext = m[2].toLowerCase();

      const reserved = new Set(["small", "medium", "big", "thumb"]);
      if (!reserved.has(base)) {
        // prova stesso ext
        const uSameExt = new URL(original.toString());
        uSameExt.pathname = p.replace(/\/[^/]+\.(jpg|jpeg|png|webp)$/i, `/${size}.${ext}`);
        out.push(uSameExt);

        // se ext != jpg, prova anche .jpg (Yupoo spesso è jpg)
        if (ext !== "jpg") {
          const uJpg = new URL(original.toString());
          uJpg.pathname = p.replace(/\/[^/]+\.(jpg|jpeg|png|webp)$/i, `/${size}.jpg`);
          out.push(uJpg);
        }
      }
    }
  }

  // 3) fallback sempre all'originale
  out.push(original);

  // dedupe
  const seen = new Set<string>();
  return out.filter((u) => {
    const k = u.toString();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

const BROWSER_MAX_AGE = 60 * 60 * 24 * 30; // 30 giorni
const CDN_MAX_AGE = 60 * 60 * 24 * 365; // 1 anno
const CDN_SWR = 60 * 60 * 24; // 1 giorno stale-while-revalidate

async function fetchUpstream(u: URL, isHead: boolean, signal: AbortSignal) {
  const headers: Record<string, string> = {
    "user-agent":
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome Safari",
    accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
    referer: `${u.protocol}//${u.host}/`,
  };

  // ✅ evita HEAD verso Yupoo (spesso 567); usa GET con range minimo
  if (isHead) headers["range"] = "bytes=0-0";

  return fetch(u.toString(), {
    method: "GET",
    redirect: "follow",
    signal,
    headers,
  });
}

async function handle(req: NextRequest, isHead = false) {
  const raw = req.nextUrl.searchParams.get("url")?.trim();
  if (!raw) return new NextResponse("Missing url", { status: 400 });

  const size = parseSize(req.nextUrl.searchParams.get("size"));

  let original: URL;
  try {
    original = new URL(raw);
  } catch {
    return new NextResponse("Invalid url", { status: 400 });
  }

  if (original.protocol !== "https:" && original.protocol !== "http:") {
    return new NextResponse("Unsupported protocol", { status: 400 });
  }

  if (isBlockedHost(original.hostname)) {
    return new NextResponse("Blocked host", { status: 403 });
  }

  if (!isAllowedHost(original.hostname)) {
    return new NextResponse("Host not allowed", { status: 403 });
  }

  // ✅ anti-recursion
  const selfHost = req.nextUrl.hostname;
  if (original.hostname === selfHost && original.pathname.startsWith("/api/img")) {
    return new NextResponse("Recursive proxy blocked", { status: 400 });
  }

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 12_000);

  try {
    const candidates = buildCandidates(original, size);

    let upstream: Response | null = null;
    let used = "";

    for (const cand of candidates) {
      const res = await fetchUpstream(cand, isHead, controller.signal);

      // valida: deve essere OK + content-type image/*
      const ct = (res.headers.get("content-type") || "").toLowerCase();
      const isImage = ct.startsWith("image/");
      if (res.ok && isImage) {
        upstream = res;
        used = cand.toString();
        break;
      }

      // se non lo usiamo, chiudiamo il body per sicurezza
      try {
        res.body?.cancel();
      } catch {}
    }

    if (!upstream) {
      return new NextResponse("Upstream fetch failed", { status: 502 });
    }

    const contentType = upstream.headers.get("content-type") || "image/jpeg";
    const etag = upstream.headers.get("etag") || "";
    const lastModified = upstream.headers.get("last-modified") || "";

    const headers: Record<string, string> = {
      "Content-Type": contentType,
      "X-Content-Type-Options": "nosniff",

      "Vercel-CDN-Cache-Control": `public, max-age=${CDN_MAX_AGE}, stale-while-revalidate=${CDN_SWR}`,
      "CDN-Cache-Control": `public, max-age=${CDN_MAX_AGE}, stale-while-revalidate=${CDN_SWR}`,
      "Cache-Control": `public, max-age=${BROWSER_MAX_AGE}, immutable`,
    };

    if (etag) headers["ETag"] = etag;
    if (lastModified) headers["Last-Modified"] = lastModified;

    // debug solo in dev
    if (process.env.NODE_ENV !== "production" && used) {
      headers["X-Img-Upstream"] = used;
    }

    return new NextResponse(isHead ? null : upstream.body, {
      status: 200,
      headers,
    });
  } catch {
    return new NextResponse("Upstream fetch failed", { status: 502 });
  } finally {
    clearTimeout(t);
  }
}

export async function GET(req: NextRequest) {
  return handle(req, false);
}

export async function HEAD(req: NextRequest) {
  return handle(req, true);
}
