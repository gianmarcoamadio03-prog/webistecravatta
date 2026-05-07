// app/api/items/route.ts
import { NextRequest, NextResponse } from "next/server";
import { getItemsPage } from "@/data/itemsFromSheet";

export const runtime = "nodejs";

function toInt(v: string | null, def: number) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : def;
}

function isAuthorized(req: NextRequest): boolean {
  const apiKey = (process.env.API_SECRET_KEY || "").trim();
  if (!apiKey) return true; // nessuna chiave configurata = aperto (backward compat)

  const headerKey = req.headers.get("x-api-key") || "";
  const queryKey  = req.nextUrl.searchParams.get("key") || "";

  return headerKey === apiKey || queryKey === apiKey;
}

export async function GET(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  try {
    const { searchParams } = new URL(req.url);
    const page  = toInt(searchParams.get("page"), 1);
    const limit = Math.min(toInt(searchParams.get("limit"), 200), 500);

    const res = await getItemsPage(page, limit);

    return NextResponse.json(
      { ok: true, page: res.page, limit: res.pageSize, totalItems: res.totalItems, rows: res.items },
      { headers: { "Cache-Control": "public, max-age=30, stale-while-revalidate=300" } }
    );
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: String(e?.message || e) }, { status: 500 });
  }
}
