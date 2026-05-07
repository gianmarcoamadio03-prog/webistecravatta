import { NextResponse } from "next/server";
import OpenAI from "openai";

export const runtime = "nodejs";

export async function GET() {
  const key = process.env.OPENAI_API_KEY;
  if (!key) {
    return NextResponse.json(
      { ok: false, error: "MISSING_OPENAI_API_KEY" },
      { status: 500 }
    );
  }

  try {
    const client = new OpenAI({ apiKey: key });

    const resp = await client.chat.completions.create({
      model: "gpt-4.1-mini",
      max_tokens: 10,
      messages: [{ role: "user", content: "Rispondi solo con la parola: OK" }],
    });

    const text = resp.choices?.[0]?.message?.content?.trim() ?? "";
    return NextResponse.json({ ok: true, text });
  } catch (err: any) {
    const status = err?.status ?? err?.response?.status;
    const code =
      err?.code ??
      err?.error?.code ??
      err?.response?.data?.error?.code;

    // Quota/billing non attivo
    if (status === 429 && code === "insufficient_quota") {
      return NextResponse.json(
        {
          ok: false,
          error: "INSUFFICIENT_QUOTA",
          hint: "Billing/crediti non attivi sul progetto OpenAI.",
        },
        { status: 402 }
      );
    }

    return NextResponse.json(
      {
        ok: false,
        error: "OPENAI_ERROR",
        status,
        code,
        message: err?.message ?? String(err),
      },
      { status: 500 }
    );
  }
}
