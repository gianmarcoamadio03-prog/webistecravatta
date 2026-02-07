import { NextResponse } from "next/server";

export const runtime = "nodejs";

export async function GET() {
  return NextResponse.json({
    ok: true,
    message: "QC API alive",
    endpoints: { test: "/api/qc/test" },
  });
}

export async function POST() {
  return NextResponse.json(
    { ok: false, error: "NOT_IMPLEMENTED_YET", hint: "Use /api/qc/test for now" },
    { status: 501 }
  );
}
