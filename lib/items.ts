import { unstable_cache } from "next/cache";
import { google } from "googleapis";
import fs from "node:fs";
import path from "node:path";
import { Buffer } from "node:buffer";

function mustEnv(name: string) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

function stripQuotes(v: string) {
  return v.replace(/^['"]|['"]$/g, "").trim();
}

function normalizePrivateKey(key: string) {
  // supporta env con \n letterali
  return key.replace(/\\n/g, "\n");
}

type SA = { email: string; key: string };

function readServiceAccountJsonFromString(
  vRaw: string
): { client_email: string; private_key: string } | null {
  const v = stripQuotes(vRaw);

  // A) JSON string
  if (v.startsWith("{")) {
    try {
      const obj = JSON.parse(v);
      if (obj?.client_email && obj?.private_key) return obj;
    } catch {}
  }

  // B) base64(JSON)
  try {
    const decoded = Buffer.from(v, "base64").toString("utf8").trim();
    if (decoded.startsWith("{")) {
      const obj = JSON.parse(decoded);
      if (obj?.client_email && obj?.private_key) return obj;
    }
  } catch {}

  // C) treat as file path
  try {
    const abs = path.isAbsolute(v) ? v : path.join(process.cwd(), v);
    if (fs.existsSync(abs)) {
      const obj = JSON.parse(fs.readFileSync(abs, "utf8"));
      if (obj?.client_email && obj?.private_key) return obj;
    }
  } catch {}

  return null;
}

function tryReadServiceAccount(): SA | null {
  // 1) JSON/base64/path in env
  const jsonEnv = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (jsonEnv) {
    const obj = readServiceAccountJsonFromString(jsonEnv);
    if (obj?.client_email && obj?.private_key) {
      return { email: obj.client_email, key: obj.private_key };
    }
  }

  // 2) file path in env + fallback paths
  const fileEnv =
    process.env.GOOGLE_APPLICATION_CREDENTIALS ||
    process.env.GOOGLE_SERVICE_ACCOUNT_FILE;

  const candidates = [
    fileEnv,
    "scraper/service-account.json",
    "service-account.json",
  ].filter(Boolean) as string[];

  for (const pRaw of candidates) {
    const p = stripQuotes(pRaw);
    try {
      const abs = path.isAbsolute(p) ? p : path.join(process.cwd(), p);
      if (!fs.existsSync(abs)) continue;
      const obj = JSON.parse(fs.readFileSync(abs, "utf8"));
      if (obj?.client_email && obj?.private_key) {
        return { email: obj.client_email, key: obj.private_key };
      }
    } catch {}
  }

  // 3) fallback env separate (se mai ti serve)
  const email =
    process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || process.env.GOOGLE_CLIENT_EMAIL;
  const key =
    process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY || process.env.GOOGLE_PRIVATE_KEY;

  if (email && key) return { email, key };

  return null;
}

// cache auth (evita token ad ogni request)
let _authPromise: Promise<any> | null = null;

async function getAuth() {
  if (_authPromise) return _authPromise;

  _authPromise = (async () => {
    const sa = tryReadServiceAccount();
    if (!sa) {
      throw new Error(
        "Missing Google credentials. Set GOOGLE_APPLICATION_CREDENTIALS=scraper/service-account.json (recommended)."
      );
    }

    const email = stripQuotes(sa.email);
    const key = normalizePrivateKey(stripQuotes(sa.key));

    if (!email) throw new Error("Invalid service account: missing client_email");
    if (!key || key.length < 200) {
      throw new Error(`Invalid service account: missing private_key (len=${key?.length ?? 0})`);
    }

    // ✅ Forma object: evita bug di parametri (key/keyFile)
    const auth = new google.auth.JWT({
      email,
      key,
      scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
    });

    await auth.authorize();
    return auth;
  })().catch((e) => {
    _authPromise = null;
    throw e;
  });

  return _authPromise;
}

const TAB = process.env.ITEMS_TAB || "items";
const COL_LAST = process.env.ITEMS_COL_LAST || "K";

async function fetchHeader() {
  const auth = await getAuth();
  const sheets = google.sheets({ version: "v4" });
  const spreadsheetId = mustEnv("SHEET_ID");
  const range = `${TAB}!A1:${COL_LAST}1`;

  const res = await sheets.spreadsheets.values.get({
    auth,
    spreadsheetId,
    range,
    valueRenderOption: "UNFORMATTED_VALUE",
  });

  return (res.data.values?.[0] ?? []).map((x) => String(x ?? "").trim());
}

export const getHeader = unstable_cache(fetchHeader, ["sheet-header"], { revalidate: 300 });

async function fetchItemsPage(page: number, limit: number) {
  const auth = await getAuth();
  const sheets = google.sheets({ version: "v4" });
  const spreadsheetId = mustEnv("SHEET_ID");

  const startRow = 2 + (page - 1) * limit;
  const endRow = startRow + limit - 1;
  const range = `${TAB}!A${startRow}:${COL_LAST}${endRow}`;

  const [header, res] = await Promise.all([
    getHeader(),
    sheets.spreadsheets.values.get({
      auth,
      spreadsheetId,
      range,
      valueRenderOption: "UNFORMATTED_VALUE",
    }),
  ]);

  const values = res.data.values ?? [];
  return values.map((row) => {
    const obj: Record<string, any> = {};
    for (let i = 0; i < header.length; i++) obj[header[i] || `col_${i}`] = row[i] ?? "";
    return obj;
  });
}

export const getItemsPage = unstable_cache(fetchItemsPage, ["items-page"], { revalidate: 60 });