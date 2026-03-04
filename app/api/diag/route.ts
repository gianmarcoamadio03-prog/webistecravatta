import { NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";

export const runtime = "nodejs";

export async function GET() {
  const gacRaw = (process.env.GOOGLE_APPLICATION_CREDENTIALS || "").trim();
  const gac = gacRaw.replace(/^['"]|['"]$/g, "");
  const abs = gac ? (path.isAbsolute(gac) ? gac : path.join(process.cwd(), gac)) : "";
  const exists = abs ? fs.existsSync(abs) : false;

  let email_ok = false;
  let private_key_len = 0;
  let parsed = false;

  try {
    if (exists) {
      const obj = JSON.parse(fs.readFileSync(abs, "utf8"));
      email_ok = !!obj?.client_email;
      private_key_len = (obj?.private_key || "").length;
      parsed = true;
    }
  } catch {}

  return NextResponse.json({
    cwd: process.cwd(),
    SHEET_ID_set: !!(process.env.SHEET_ID || "").trim(),
    GOOGLE_APPLICATION_CREDENTIALS: gacRaw || null,
    resolved_path: abs || null,
    file_exists: exists,
    file_parsed: parsed,
    email_ok,
    private_key_len,
  });
}