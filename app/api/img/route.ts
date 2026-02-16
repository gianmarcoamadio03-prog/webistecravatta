import { NextRequest, NextResponse } from "next/server";

// ✅ Edge = cold start più basso + caching CDN efficace
export const runtime = "edge";

/**
 * ✅ IMPORTANTISSIMO: Allowlist host consentiti.
 * Senza questa lista, /api/img diventa un "open proxy" e ti brucia Fast Origin Transfer.
 *
 * Se usi anche altri host (es: img.alicdn.com, etc), aggiungili qui.
 */
const ALLOWED_HOST_SUFFIXES = [
  ".yupoo.com",
  // ".yupoo.com.cn", // se mai servisse
];

function isAllowedHost(hostname: string) {
  const h = hostname.toLowerCase().trim();
  return ALLOWED_HOST_SUFFIXES.some((suf) => h === suf.slice(1) || h.endsWith(suf));
}

function isBlockedHost(hostname: string) {
  const h = hostname.toLowerCase().trim();

  if (h === "localhost" || h === "127.0.0.1" || h === "0.0.0.0" || h === "::1") return true;

  // blocca IP diretti (SSRF)
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

const BROWSER_MAX_AGE = 60 * 60 * 24 * 30; // 30 giorni
const CDN_MAX_AGE = 60 * 60 * 24 * 365; // 1 anno
const CDN_SWR = 60 * 60 * 24; // 1 giorno stale-while-revalidate

async function handle(req: NextRequest, isHead = false) {
  const raw = req.nextUrl.searchParams.get("url")?.trim();
  if (!raw) return new NextResponse("Missing url", { status: 400 });

  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return new NextResponse("Invalid url", { status: 400 });
  }

  if (u.protocol !== "https:" && u.protocol !== "http:") {
    return new NextResponse("Unsupported protocol", { status: 400 });
  }

  if (isBlockedHost(u.hostname)) {
    return new NextResponse("Blocked host", { status: 403 });
  }

  // ✅ blocca host non in allowlist (anti open-proxy)
  if (!isAllowedHost(u.hostname)) {
    return new NextResponse("Host not allowed", { status: 403 });
  }

  // ✅ anti-recursion: evita /api/img?url=https://TUO_SITO/api/img?url=...
  const selfHost = req.nextUrl.hostname;
  if (u.hostname === selfHost && u.pathname.startsWith("/api/img")) {
    return new NextResponse("Recursive proxy blocked", { status: 400 });
  }

  // ✅ timeout fetch (evita richieste appese)
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 12_000);

  let upstream: Response;
  try {
    upstream = await fetch(u.toString(), {
      method: isHead ? "HEAD" : "GET",
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "user-agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome Safari",
        accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
        referer: `${u.protocol}//${u.host}/`,
      },
    });
  } catch {
    clearTimeout(t);
    return new NextResponse("Upstream fetch failed", { status: 502 });
  } finally {
    clearTimeout(t);
  }

  if (!upstream.ok) {
    return new NextResponse("Upstream fetch failed", { status: 502 });
  }

  // Su HEAD non serve body; su GET pretendiamo body
  if (!isHead && !upstream.body) {
    return new NextResponse("Upstream body missing", { status: 502 });
  }

  const contentType = upstream.headers.get("content-type") || "image/jpeg";
  const etag = upstream.headers.get("etag") || "";
  const lastModified = upstream.headers.get("last-modified") || "";

  const headers: Record<string, string> = {
    "Content-Type": contentType,
    "X-Content-Type-Options": "nosniff",

    /**
     * ✅ Cache Vercel (priorità massima): riduce drasticamente "Fast Origin Transfer".
     * Vercel userà questo per la sua CDN cache.
     */
    "Vercel-CDN-Cache-Control": `public, max-age=${CDN_MAX_AGE}, stale-while-revalidate=${CDN_SWR}`,

    /**
     * ✅ Cache per eventuali CDN downstream / proxy intermedi:
     */
    "CDN-Cache-Control": `public, max-age=${CDN_MAX_AGE}, stale-while-revalidate=${CDN_SWR}`,

    /**
     * ✅ Cache browser (client):
     */
    "Cache-Control": `public, max-age=${BROWSER_MAX_AGE}, immutable`,
  };

  if (etag) headers["ETag"] = etag;
  if (lastModified) headers["Last-Modified"] = lastModified;

  return new NextResponse(isHead ? null : upstream.body, {
    status: 200,
    headers,
  });
}

export async function GET(req: NextRequest) {
  return handle(req, false);
}

export async function HEAD(req: NextRequest) {
  return handle(req, true);
}
