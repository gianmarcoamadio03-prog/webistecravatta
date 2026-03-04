// app/api/items/route.ts
import { NextRequest, NextResponse } from "next/server";
import { getItemsPage } from "@/data/itemsFromSheet";

export const runtime = "nodejs";

function toInt(v: string | null, def: number) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : def;
}

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const page = toInt(searchParams.get("page"), 1);
    const limit = Math.min(toInt(searchParams.get("limit"), 200), 500);

    const res = await getItemsPage(page, limit);

    return NextResponse.json(
      { ok: true, page: res.page, limit: res.pageSize, totalItems: res.totalItems, rows: res.items },
      {
        headers: {
          // cache “soft” lato browser (non obbligatorio)
          "Cache-Control": "public, max-age=30, stale-while-revalidate=300",
        },
      }
    );
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: String(e?.message || e) }, { status: 500 });
  }
}