// app/api/report-item/route.ts
import { sendMail } from "@/src/lib/sendMail";

export const runtime = "nodejs";

type Payload = {
  title?: string;
  slug?: string;
  seller?: string;
  category?: string;
  source_url?: string;
  sheet_row?: number | string;
  sheet_id?: string;
  sheet_tab?: string;
  page_url?: string;
  note?: string; // opzionale, se vuoi far scrivere un motivo in futuro
};

function mustEnv(name: string) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as Payload;


    const title = (body.title || "").trim() || "Articolo (titolo mancante)";
    const slug = (body.slug || "").trim();
    const seller = (body.seller || "").trim();
    const category = (body.category || "").trim();
    const sourceUrl = (body.source_url || "").trim();
    const pageUrl = (body.page_url || "").trim();

    // payload minimo obbligatorio (evita spam “vuoti”)
    if (!slug && !sourceUrl && !pageUrl) {
      return Response.json({ ok: false, error: "Missing identifiers" }, { status: 400 });
    }

    const subject = `🛟 Segnalazione articolo: ${title}${seller ? ` (${seller})` : ""}`;

    const lines = [
      `Titolo: ${title}`,
      seller ? `Seller: ${seller}` : null,
      category ? `Categoria: ${category}` : null,
      slug ? `Slug: ${slug}` : null,
      sourceUrl ? `Source URL: ${sourceUrl}` : null,
      pageUrl ? `Pagina sul sito: ${pageUrl}` : null,
      body.sheet_row != null ? `Riga Spreadsheet: ${String(body.sheet_row)}` : null,
      body.sheet_id ? `Sheet ID: ${body.sheet_id}` : null,
      body.sheet_tab ? `Tab: ${body.sheet_tab}` : null,
      body.note ? `Nota: ${body.note}` : null,
      `Timestamp: ${new Date().toISOString()}`,
    ].filter(Boolean);

    const text = lines.join("\n");

    const html = `
      <div style="font-family: ui-sans-serif, system-ui, -apple-system; line-height:1.5">
        <h2 style="margin:0 0 12px">Segnalazione articolo</h2>
        <pre style="background:#0b0b0b;color:#fff;padding:14px;border-radius:12px;white-space:pre-wrap">${escapeHtml(
          text
        )}</pre>
      </div>
    `;

    await sendMail({ subject, text, html });

    return Response.json({ ok: true });
  } catch (err: any) {
    console.error("report-item error:", err);
    return Response.json({ ok: false, error: "Send failed" }, { status: 500 });
  }
}

function escapeHtml(s: string) {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
