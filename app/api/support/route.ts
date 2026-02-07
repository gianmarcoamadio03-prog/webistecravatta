// app/api/support/route.ts
import nodemailer from "nodemailer";

export const runtime = "nodejs";

type Payload = {
  title?: string;
  id?: string;
  slug?: string;
  brand?: string;
  category?: string;
  seller?: string;
  rowNumber?: number | null;
  sourceUrl?: string;
  pageUrl?: string;
  message?: string;

  // compat (se ti rimangono chiamate vecchie)
  source_url?: string;
  page_url?: string;
  note?: string;
  sheet_row?: number | string;
  sheet_id?: string;
  sheet_tab?: string;
};

function mustEnv(name: string) {
  const v = (process.env[name] || "").trim();
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

function clean(v: any) {
  return String(v ?? "").trim();
}

function boolish(v: string) {
  const s = (v || "").trim().toLowerCase();
  return s === "1" || s === "true" || s === "yes";
}

export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as Payload;

    const to = mustEnv("SUPPORT_TO_EMAIL");
    const host = mustEnv("SMTP_HOST");
    const port = Number(mustEnv("SMTP_PORT"));
    const user = mustEnv("SMTP_USER");
    const pass = mustEnv("SMTP_PASS");
    const from = clean(process.env.SMTP_FROM) || user;

    const secure =
      process.env.SMTP_SECURE != null ? boolish(process.env.SMTP_SECURE) : port === 465;

    const title = clean(body.title) || "Articolo";
    const id = clean(body.id);
    const slug = clean(body.slug);
    const brand = clean(body.brand);
    const category = clean(body.category);
    const seller = clean(body.seller);

    const sourceUrl = clean(body.sourceUrl || body.source_url);
    const pageUrl = clean(body.pageUrl || body.page_url);
    const row = body.rowNumber ?? body.sheet_row;

    const note = clean(body.message || body.note);
    if (note.length < 3) {
      return Response.json({ ok: false, error: "Scrivi almeno 3 caratteri" }, { status: 400 });
    }

    const subject = `🆘 Segnalazione: ${title}${seller ? ` (${seller})` : ""}`;

    const lines = [
      `Titolo: ${title}`,
      id ? `ID: ${id}` : null,
      slug ? `Slug: ${slug}` : null,
      brand ? `Brand: ${brand}` : null,
      category ? `Categoria: ${category}` : null,
      seller ? `Seller: ${seller}` : null,
      row != null ? `Riga sheet: ${String(row)}` : null,
      sourceUrl ? `Source URL: ${sourceUrl}` : null,
      pageUrl ? `Pagina: ${pageUrl}` : null,
      "",
      "Messaggio:",
      note,
      "",
      `Timestamp: ${new Date().toISOString()}`,
    ].filter(Boolean);

    const text = lines.join("\n");

    const transporter = nodemailer.createTransport({
      host,
      port,
      secure,
      auth: { user, pass },
    });

    // utile per capire subito auth/connessione
    await transporter.verify();

    await transporter.sendMail({ from, to, subject, text });

    return Response.json({ ok: true });
  } catch (err: any) {
    console.error("support error:", err);
    // ritorno il vero errore al client (così non vedi solo "Send failed")
    return Response.json({ ok: false, error: err?.message || "Send failed" }, { status: 500 });
  }
}
