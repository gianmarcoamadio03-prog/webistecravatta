// app/api/qc/analyze/route.ts
import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";
import { Buffer } from "node:buffer";

export const runtime = "nodejs";

// ENV
const MAX_IMAGES = Number(process.env.QC_MAX_IMAGES ?? 4);
const DAILY_LIMIT = Number(process.env.QC_DAILY_IMAGE_LIMIT ?? 8);
const MODEL = process.env.QC_MODEL ?? "gpt-4.1-mini";

const IMAGE_DETAIL = (process.env.QC_IMAGE_DETAIL ?? "low") as
  | "low"
  | "high"
  | "auto";

const MAX_OUTPUT_TOKENS = Number(process.env.QC_MAX_OUTPUT_TOKENS ?? 220);

const MOCK = ["1", "true", "yes", "on"].includes(
  String(process.env.QC_MOCK ?? "").toLowerCase().trim()
);

// ===== Volatile daily limit (in-memory) =====
type DailyEntry = { day: string; used: number };
const g = globalThis as any;
g.__qcDaily ??= new Map<string, DailyEntry>();
const dailyMap: Map<string, DailyEntry> = g.__qcDaily;

function dayKey(d = new Date()) {
  return d.toISOString().slice(0, 10);
}

function getIP(req: NextRequest) {
  const xf = req.headers.get("x-forwarded-for") || "";
  const ip = xf.split(",")[0]?.trim();
  return ip || req.headers.get("x-real-ip") || "local";
}

function isLikelyImageUrl(s: string) {
  return (
    /^data:image\/(png|jpe?g|webp);base64,/i.test(s) ||
    /^https?:\/\//i.test(s)
  );
}

function isFileLike(v: any): v is File {
  return (
    v &&
    typeof v === "object" &&
    typeof (v as any).arrayBuffer === "function" &&
    typeof (v as any).type === "string"
  );
}

async function fileToDataUrl(file: File) {
  const ab = await file.arrayBuffer();
  const b64 = Buffer.from(ab).toString("base64");
  const mime = file.type || "image/jpeg";

  if (/heic/i.test(mime)) {
    throw new Error("HEIC_NOT_SUPPORTED");
  }

  return `data:${mime};base64,${b64}`;
}

type QcResult = {
  score: number; // 1..100
  summary: string; // 1 frase
  pros: string[]; // 3
  cons: string[]; // 3
};

function clampScore(n: any) {
  const v = Number(n);
  if (!Number.isFinite(v)) return 50;
  return Math.max(1, Math.min(100, Math.round(v)));
}

function list3(x: any) {
  const arr = Array.isArray(x) ? x : [];
  const out = arr
    .map((s) => String(s ?? "").trim())
    .filter(Boolean)
    .slice(0, 3);
  while (out.length < 3) out.push("—");
  return out;
}

function summary1(s: any) {
  const t = String(s ?? "").trim();
  if (!t) return "Analisi completata.";
  // prova a mantenere 1 frase breve
  const one = t.split(/\.\s+/)[0]?.trim();
  const final = one || t;
  return final.length > 220 ? final.slice(0, 220).trim() : final;
}

function mockResult(notes: string): QcResult {
  return {
    score: 84,
    summary: notes
      ? `Mock: analisi simulata. Note: ${notes.slice(0, 90)}`
      : "Mock: analisi simulata.",
    pros: ["Buona resa generale", "Dettagli abbastanza puliti", "Cuciture nella media"],
    cons: ["Serve close-up migliore", "Luce/angolo limita dettagli", "Manca foto etichetta/tag"],
  };
}

export async function GET() {
  return NextResponse.json({
    ok: true,
    message: "QC analyze endpoint ready",
    post: "/api/qc/analyze",
    maxImages: MAX_IMAGES,
    dailyLimit: DAILY_LIMIT,
    model: MODEL,
    mock: MOCK,
    imageDetail: IMAGE_DETAIL,
    maxOutputTokens: MAX_OUTPUT_TOKENS,
  });
}

export async function POST(req: NextRequest) {
  try {
    let images: string[] = [];
    let notes = "";

    const ct = req.headers.get("content-type") || "";

    if (ct.includes("multipart/form-data")) {
      const fd = await req.formData();
      const raw = fd.getAll("images");
      const files = raw.filter(isFileLike).slice(0, MAX_IMAGES);
      notes = String(fd.get("notes") ?? "").trim();

      if (files.length) {
        try {
          images = await Promise.all(files.map(fileToDataUrl));
        } catch (e: any) {
          if (String(e?.message) === "HEIC_NOT_SUPPORTED") {
            return NextResponse.json(
              {
                ok: false,
                error: "HEIC_NOT_SUPPORTED",
                hint:
                  "Formato HEIC non supportato lato server. Usa JPG/PNG oppure lascia attiva la compressione lato client (che converte in JPG).",
              },
              { status: 400 }
            );
          }
          throw e;
        }
      }
    } else {
      let body: any;
      try {
        body = await req.json();
      } catch {
        return NextResponse.json(
          { ok: false, error: "INVALID_JSON_BODY" },
          { status: 400 }
        );
      }

      const raw = Array.isArray(body?.images) ? body.images : [];
      notes = typeof body?.notes === "string" ? body.notes.trim() : "";

      images = raw
        .map((x: any) => String(x ?? "").trim())
        .filter(Boolean)
        .filter(isLikelyImageUrl)
        .slice(0, MAX_IMAGES);
    }

    if (images.length === 0) {
      return NextResponse.json(
        {
          ok: false,
          error: "NO_IMAGES",
          hint:
            "Invia immagini via FormData (images=@file) oppure JSON { images:[dataUrl|httpUrl] }",
        },
        { status: 400 }
      );
    }

    // Daily limit (per IP)
    const ip = getIP(req);
    const day = dayKey();
    const entry = dailyMap.get(ip);
    const usedSoFar = entry && entry.day === day ? entry.used : 0;

    const willUse = images.length;
    if (usedSoFar + willUse > DAILY_LIMIT) {
      return NextResponse.json(
        {
          ok: false,
          error: "DAILY_LIMIT_REACHED",
          dailyLimit: DAILY_LIMIT,
          usedToday: usedSoFar,
          remainingToday: Math.max(0, DAILY_LIMIT - usedSoFar),
        },
        { status: 429 }
      );
    }

    // MOCK
    if (MOCK) {
      dailyMap.set(ip, { day, used: usedSoFar + willUse });
      return NextResponse.json({
        ok: true,
        result: mockResult(notes),
        dailyLimit: DAILY_LIMIT,
        usedToday: usedSoFar + willUse,
        remainingToday: Math.max(0, DAILY_LIMIT - (usedSoFar + willUse)),
        mock: true,
      });
    }

    // REAL OpenAI
    const key = process.env.OPENAI_API_KEY;
    if (!key) {
      return NextResponse.json(
        { ok: false, error: "MISSING_OPENAI_API_KEY" },
        { status: 500 }
      );
    }

    const client = new OpenAI({ apiKey: key });

    // ✅ 3/3 + score 1..100 + no redFlags
    const json_schema = {
      name: "qc_result",
      strict: true,
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          score: { type: "integer", minimum: 1, maximum: 100 },
          summary: { type: "string" },
          pros: {
            type: "array",
            items: { type: "string" },
            minItems: 3,
            maxItems: 3,
          },
          cons: {
            type: "array",
            items: { type: "string" },
            minItems: 3,
            maxItems: 3,
          },
        },
        required: ["score", "summary", "pros", "cons"],
      },
    };

    // ✅ Prompt “forte” sempre incluso + note utente separate
    const systemPrompt = `
Sei un ispettore di Quality Check (QC) per abbigliamento/accessori.
Ispeziona l’articolo nelle immagini e valuta la QUALITÀ COSTRUTTIVA.

Output richiesto (SOLO JSON conforme allo schema):
- score: intero 1–100 (coerente con pro/contro)
- pros: ESATTAMENTE 3 punti
- cons: ESATTAMENTE 3 punti
- summary: 1 frase breve

Cosa valutare (solo se VISIBILE):
- cuciture (drittezza, densità, simmetria, fili)
- materiali/texture (uniformità, grana, pelucchi)
- stampe/ricami/loghi (centratura, sbavature, bordi)
- etichette/tag (qualità stampa, allineamento, cucitura)
- hardware (zip/bottoni) se presenti
- difetti evidenti (macchie, aloni, pieghe anomale)

Regole:
- Non inventare: se non è chiaro, mettilo nei CONS.
- Ogni punto: max 10 parole, specifico, no frasi vaghe.
- Se mancano foto utili (tag, close-up), deve comparire nei CONS.
- Score guida:
  90–100 eccellente, 80–89 molto buono, 70–79 buono,
  55–69 medio, 1–54 scarso.
`.trim();

    const userText = notes
      ? `Note utente (da considerare): ${notes}`
      : "Note utente: nessuna.";

    const resp = await client.chat.completions.create({
      model: MODEL,
      temperature: 0.2,
      max_tokens: MAX_OUTPUT_TOKENS,
      response_format: { type: "json_schema", json_schema } as any,
      messages: [
        { role: "system", content: systemPrompt },
        {
          role: "user",
          content: [
            { type: "text", text: userText },
            ...images.map((url) => ({
              type: "image_url",
              image_url: { url, detail: IMAGE_DETAIL },
            })),
          ] as any,
        },
      ],
    });

    const content = resp.choices?.[0]?.message?.content ?? "{}";

    let parsed: QcResult;
    try {
      const j = JSON.parse(content);
      parsed = {
        score: clampScore(j?.score),
        summary: summary1(j?.summary),
        pros: list3(j?.pros),
        cons: list3(j?.cons),
      };
    } catch {
      parsed = {
        score: 50,
        summary: "Parse error",
        pros: ["—", "—", "—"],
        cons: ["—", "—", "—"],
      };
    }

    dailyMap.set(ip, { day, used: usedSoFar + willUse });

    return NextResponse.json({
      ok: true,
      result: parsed,
      dailyLimit: DAILY_LIMIT,
      usedToday: usedSoFar + willUse,
      remainingToday: Math.max(0, DAILY_LIMIT - (usedSoFar + willUse)),
      mock: false,
    });
  } catch (err: any) {
    const status = err?.status ?? err?.response?.status;
    const code = err?.code ?? err?.error?.code;

    if (status === 429 && code === "insufficient_quota") {
      return NextResponse.json(
        {
          ok: false,
          error: "INSUFFICIENT_QUOTA",
          hint: "Attiva billing/crediti sul progetto OpenAI per usare l’analisi reale.",
        },
        { status: 402 }
      );
    }

    return NextResponse.json(
      { ok: false, error: "ROUTE_CRASH", message: err?.message ?? String(err) },
      { status: 500 }
    );
  }
}
