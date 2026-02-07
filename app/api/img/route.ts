import { NextRequest, NextResponse } from "next/server";

// ✅ Edge = cold start molto più basso e caching CDN più efficace.
export const runtime = "edge";


function isBlockedHost(hostname: string) {
  const h = hostname.toLowerCase().trim();

  if (h === "localhost" || h === "127.0.0.1" || h === "0.0.0.0" || h === "::1")
    return true;

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

export async function GET(req: NextRequest) {
  const url = req.nextUrl.searchParams.get("url")?.trim();
  if (!url) return new NextResponse("Missing url", { status: 400 });

  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return new NextResponse("Invalid url", { status: 400 });
  }

  if (u.protocol !== "https:" && u.protocol !== "http:") {
    return new NextResponse("Unsupported protocol", { status: 400 });
  }

  if (isBlockedHost(u.hostname)) {
    return new NextResponse("Blocked host", { status: 403 });
  }

  // ✅ anti-recursion: evita /api/img?url=https://TUO_SITO/api/img?url=...
  const selfHost = req.nextUrl.hostname;
  if (u.hostname === selfHost && u.pathname.startsWith("/api/img")) {
    return new NextResponse("Recursive proxy blocked", { status: 400 });
  }

  const upstream = await fetch(u.toString(), {
    redirect: "follow",
    headers: {
      "user-agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome Safari",
      accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
      referer: `${u.protocol}//${u.host}/`,
    },
  });

  if (!upstream.ok || !upstream.body) {
    return new NextResponse("Upstream fetch failed", { status: 502 });
  }

  const contentType = upstream.headers.get("content-type") || "image/jpeg";

  return new NextResponse(upstream.body, {
    status: 200,
    headers: {
      "Content-Type": contentType,
      "Cache-Control": "public, max-age=86400, stale-while-revalidate=604800",
    },
  });
}
