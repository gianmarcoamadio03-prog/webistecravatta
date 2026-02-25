"use strict";

/**
 * corrector-category.mjs (v8)
 *
 * v8 ADD:
 * - Page-hint BEFORE AI: usa la pagina Yupoo (colonna Q) per leggere breadcrumb/meta/keywords/JSON
 *   e prova a dedurre category con le stesse REGEX/ALIASES dello scraper (gratis).
 * - Taxonomy/aliases/rules allineati allo scraper (ALLOWED_TYPES + FOOTWEAR_TYPES + CATEGORY_ALIASES + rules).
 *
 * Restano:
 * - Scansiona SOLO righe con category=OTHER (default)
 * - Title-based detection (gratis) prima di tutto
 * - AI multi-immagine (img1..img8 + extra_images) con pass1/pass2
 * - Flush a blocchi
 * - Cache su disco
 * - Priming / challenge helper per photo.yupoo.com (headful opzionale)
 * - NO negative-cache su fetch/blocco/too-large
 * - Fallback size: big -> medium -> small
 * - Album fallback images: og:image + photo.yupoo urls
 */

import fs from "fs";
import path from "path";
import dotenv from "dotenv";
import { google } from "googleapis";
import { chromium } from "playwright";
import { fileURLToPath } from "url";
import readline from "node:readline";
import OpenAI from "openai";

// =====================================================
// ESM __dirname + Project root
// =====================================================
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, "..");

// =====================================================
// DOTENV (sempre dal root progetto)
// =====================================================
dotenv.config({ path: path.join(PROJECT_ROOT, ".env.local") });

// =====================================================
// ENV
// =====================================================
const VERSION =
  "2026-02-24 | corrector v8: page-hint from Yupoo URL (col Q) before AI + scraper-aligned taxonomy/rules";

const SHEET_ID = (process.env.SHEET_ID || "").trim();
const SHEET_TAB = (process.env.SHEET_TAB || "items").trim();
const SERVICE_ACCOUNT_JSON = (process.env.GOOGLE_SERVICE_ACCOUNT_JSON || "./service-account.json").trim();

const NAV_TIMEOUT = Number(String(process.env.NAV_TIMEOUT || "90000").trim());
const REAL_UA =
  (process.env.USER_AGENT || "").trim() ||
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";
const ACCEPT_LANG = (process.env.ACCEPT_LANGUAGE || "it-IT,it;q=0.9,en;q=0.8").trim();

const YUPOO_STORAGE_STATE = (process.env.YUPOO_STORAGE_STATE || "./scraper/yupoo_state.json").trim();
const CORRECTOR_HEADFUL = String(process.env.CORRECTOR_HEADFUL || "0").trim() === "1";

const CORRECTOR_DRY_RUN = String(process.env.CORRECTOR_DRY_RUN || "0").trim() === "1";
const CORRECTOR_ALLOW_AI_IN_DRY_RUN = String(process.env.CORRECTOR_ALLOW_AI_IN_DRY_RUN || "0").trim() === "1";

const CORRECTOR_ONLY_OTHER = String(process.env.CORRECTOR_ONLY_OTHER || "1").trim() !== "0";
const CORRECTOR_USE_TITLE_HINT_FIRST = String(process.env.CORRECTOR_USE_TITLE_HINT_FIRST || "1").trim() !== "0";

// ✅ NEW: page-hint da colonna Q (yupoo_url) prima dell'AI
const CORRECTOR_USE_PAGE_HINT_FIRST = String(process.env.CORRECTOR_USE_PAGE_HINT_FIRST || "1").trim() !== "0";
const CORRECTOR_PAGE_HINT_MIN_CONF = Math.max(
  0,
  Math.min(1, Number(String(process.env.CORRECTOR_PAGE_HINT_MIN_CONF || "0.70").trim()) || 0.7)
);

const CORRECTOR_FLUSH_EVERY = Math.max(1, Number(String(process.env.CORRECTOR_FLUSH_EVERY || "5").trim()) || 5);
const CORRECTOR_CONCURRENCY = Math.max(1, Number(String(process.env.CORRECTOR_CONCURRENCY || "2").trim()) || 2);

const CORRECTOR_LIMIT = Math.max(0, Number(String(process.env.CORRECTOR_LIMIT || "0").trim()) || 0);
const CORRECTOR_ONLY_SELLER = String(process.env.CORRECTOR_ONLY_SELLER || "").trim().toLowerCase();

const CORRECTOR_MODEL = (process.env.CORRECTOR_MODEL || process.env.SCRAPER_DETECT_MODEL || "gpt-4o-mini").trim();
const CORRECTOR_IMAGE_DETAIL = (process.env.CORRECTOR_IMAGE_DETAIL || "low").trim();
const CORRECTOR_SECOND_PASS_DETAIL = (process.env.CORRECTOR_SECOND_PASS_DETAIL || "auto").trim();
const CORRECTOR_MAX_OUTPUT_TOKENS = Math.max(
  60,
  Number(String(process.env.CORRECTOR_MAX_OUTPUT_TOKENS || "140").trim()) || 140
);

const CORRECTOR_RETRIES = Math.max(0, Number(String(process.env.CORRECTOR_RETRIES || "1").trim()) || 1);

// IMPORTANT: CORRECTOR_MAX_IMAGES_TO_TRY conta SOLO immagini con fetch OK
const CORRECTOR_MAX_IMAGES_TO_TRY = Math.max(
  1,
  Number(String(process.env.CORRECTOR_MAX_IMAGES_TO_TRY || "3").trim()) || 3
);

const CORRECTOR_MIN_CONFIDENCE = Math.max(
  0,
  Math.min(1, Number(String(process.env.CORRECTOR_MIN_CONFIDENCE || "0.60").trim()) || 0.6)
);

const CORRECTOR_CACHE_FILE = (process.env.CORRECTOR_CACHE_FILE || "./corrector-category/ai_cache.json").trim();
const CORRECTOR_CACHE_FLUSH_EVERY = Math.max(
  5,
  Number(String(process.env.CORRECTOR_CACHE_FLUSH_EVERY || "40").trim()) || 40
);

const CORRECTOR_AI_MAX_BYTES = Math.max(
  200000,
  Number(String(process.env.CORRECTOR_AI_MAX_BYTES || process.env.SCRAPER_AI_MAX_BYTES || "2500000").trim()) || 2500000
);

const CORRECTOR_KEEP_TITLE_INDEX = String(process.env.CORRECTOR_KEEP_TITLE_INDEX || "0").trim() === "1";

// API key priority: CORRECTOR_OPENAI_API_KEY -> SCRAPER_OPENAI_API_KEY -> OPENAI_API_KEY
const CORRECTOR_OPENAI_API_KEY = String(
  process.env.CORRECTOR_OPENAI_API_KEY || process.env.SCRAPER_OPENAI_API_KEY || process.env.OPENAI_API_KEY || ""
).trim();

const AI_ENABLED = !!CORRECTOR_OPENAI_API_KEY && (!CORRECTOR_DRY_RUN || CORRECTOR_ALLOW_AI_IN_DRY_RUN);
const openai = AI_ENABLED ? new OpenAI({ apiKey: CORRECTOR_OPENAI_API_KEY }) : null;

function absPathFromRoot(p) {
  const raw = String(p || "").trim();
  if (!raw) return "";
  return path.isAbsolute(raw) ? raw : path.join(PROJECT_ROOT, raw.replace(/^\.\//, ""));
}

const absCredPath = path.isAbsolute(SERVICE_ACCOUNT_JSON)
  ? SERVICE_ACCOUNT_JSON
  : path.join(PROJECT_ROOT, SERVICE_ACCOUNT_JSON.replace(/^\.\//, ""));

if (!SHEET_ID) {
  console.error("❌ ERRORE: SHEET_ID mancante nel .env.local (root progetto)");
  process.exit(1);
}
if (!fs.existsSync(absCredPath)) {
  console.error("❌ ERRORE: credenziali non trovate:", absCredPath);
  process.exit(1);
}

console.log("====================================");
console.log("✅ Corrector Category");
console.log("VERSION:", VERSION);
console.log("ROOT:", PROJECT_ROOT);
console.log("SHEET_ID:", SHEET_ID);
console.log("TAB:", SHEET_TAB);
console.log("DRY_RUN:", CORRECTOR_DRY_RUN ? "ON" : "OFF", "| AI:", AI_ENABLED ? `ON (${CORRECTOR_MODEL})` : "OFF");
console.log("FLUSH_EVERY:", CORRECTOR_FLUSH_EVERY, "| CONCURRENCY:", CORRECTOR_CONCURRENCY);
console.log("MAX_IMAGES_TO_TRY:", CORRECTOR_MAX_IMAGES_TO_TRY, "| MIN_CONF:", CORRECTOR_MIN_CONFIDENCE);
console.log("PAGE_HINT:", CORRECTOR_USE_PAGE_HINT_FIRST ? `ON (min=${CORRECTOR_PAGE_HINT_MIN_CONF})` : "OFF");
console.log("storageState:", absPathFromRoot(YUPOO_STORAGE_STATE));
console.log("====================================");

// =====================================================
// Utils
// =====================================================
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function waitEnter(promptText) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(promptText, () => {
      rl.close();
      resolve();
    });
  });
}

function sheetA1Tab(tab) {
  const safe = String(tab || "").replace(/'/g, "''");
  return `'${safe}'`;
}

function padToLen(arr, len) {
  const out = Array.isArray(arr) ? [...arr] : [];
  while (out.length < len) out.push("");
  return out.slice(0, len);
}

function normalizeForMatch(text) {
  let t = String(text || "").toLowerCase();
  t = t.normalize("NFKD");
  t = t.replace(/[‐-‒–—−]/g, "-");
  t = t.replace(/[^\p{L}\p{N}\s-]+/gu, " ");
  t = t.replace(/\s+/g, " ").trim();
  return t;
}

// =====================================================
// Category taxonomy (scraper-aligned)
// =====================================================
const ALLOWED_TYPES = new Set([
  "SNEAKERS","SHOES","BOOTS","CHELSEA_BOOTS","HIKING_BOOTS","LOAFERS","DERBIES","OXFORDS",
  "HEELS","FLATS","MULES","CLOGS","ESPADRILLES","SANDALS","SLIDES",

  "JACKETS","BOMBERS","WINDBREAKERS","RAIN_JACKETS","PUFFERS","PARKAS","COATS","TRENCH_COATS",
  "LEATHER_JACKETS","DENIM_JACKETS","BLAZERS","VESTS",

  "TSHIRTS","LONGSLEEVES","SHIRTS","BLOUSES","POLOS","TANK_TOPS","CROP_TOPS","BODYSUITS",

  "HOODIES","SWEATSHIRTS","SWEATERS","CARDIGANS","KNITWEAR",

  "PANTS","SWEATPANTS","JOGGERS","JEANS","SHORTS","SKIRTS","LEGGINGS",

  "DRESSES","JUMPSUITS","ROMPERS","SUITS","TRACKSUITS","SETS",

  "UNDERWEAR","UNDERPANTS","BOXERS","BRIEFS","TRUNKS","LINGERIE","BRA","SOCKS","HOSIERY","SWIMWEAR",

  "BAGS","TOTE_BAGS","SHOULDER_BAGS","CROSSBODY","BACKPACKS","DUFFLE_BAGS","LUGGAGE",
  "WALLETS","CARDHOLDERS",

  "HATS","CAPS","BEANIES","SCARVES","GLOVES","BELTS","TIES","KEYCHAINS",
  "SUNGLASSES","OPTICAL_FRAMES",

  "WATCHES","JEWELRY","RINGS","BRACELETS","NECKLACES","EARRINGS",

  "FRAGRANCES","SKINCARE","HAIR","MAKEUP",

  "PHONE_CASES","AIRPODS_CASES","TECH_ACCESSORIES",

  "KIDS","PETS","HOME","DECOR","OTHER",
]);

const FOOTWEAR_TYPES = new Set([
  "SNEAKERS","SHOES","BOOTS","CHELSEA_BOOTS","HIKING_BOOTS","LOAFERS","DERBIES","OXFORDS",
  "HEELS","FLATS","MULES","CLOGS","ESPADRILLES","SANDALS","SLIDES",
]);

const CATEGORY_ALIASES = {
  // tops
  TSHIRT: "TSHIRTS",
  T_SHIRT: "TSHIRTS",
  "T-SHIRT": "TSHIRTS",
  TEE: "TSHIRTS",
  TEES: "TSHIRTS",
  "T-SHIRTS": "TSHIRTS",

  LONG_SLEEVE: "LONGSLEEVES",
  LONG_SLEEVES: "LONGSLEEVES",
  LONGSLEEVE: "LONGSLEEVES",
  "LONG-SLEEVE": "LONGSLEEVES",
  LONG_SLEE: "LONGSLEEVES",
  LONG_SLEEE: "LONGSLEEVES",
  LONG_SLEEVED: "LONGSLEEVES",

  HOODIE: "HOODIES",
  HOODIES: "HOODIES",
  SWEATSHIRT: "SWEATSHIRTS",
  SWEATSHIRTS: "SWEATSHIRTS",
  CREWNECK: "SWEATSHIRTS",

  // bottoms
  PANT: "PANTS",
  PANTS: "PANTS",
  TROUSERS: "PANTS",
  JOGGER: "JOGGERS",
  JOGGERS: "JOGGERS",
  SWEATPANTS: "SWEATPANTS",
  JEAN: "JEANS",
  JEANS: "JEANS",
  DENIM: "JEANS",

  // footwear
  SNEAKER: "SNEAKERS",
  SNEAKERS: "SNEAKERS",
  SHOE: "SHOES",
  SHOES: "SHOES",
  BOOT: "BOOTS",
  BOOTS: "BOOTS",
  SANDAL: "SANDALS",
  SANDALS: "SANDALS",

  // bags / small leather
  BAG: "BAGS",
  BAGS: "BAGS",
  BACKPACK: "BACKPACKS",
  BACKPACKS: "BACKPACKS",
  WALLET: "WALLETS",
  WALLETS: "WALLETS",
  CARDHOLDER: "CARDHOLDERS",
  CARDHOLDERS: "CARDHOLDERS",

  // accessories
  SUNGLASS: "SUNGLASSES",
  SUNGLASSES: "SUNGLASSES",
  GLASS: "SUNGLASSES",
  BELT: "BELTS",
  BELTS: "BELTS",
  HAT: "HATS",
  HATS: "HATS",
  CAP: "CAPS",
  CAPS: "CAPS",
  BEANIE: "BEANIES",
  BEANIES: "BEANIES",

  // dresses/skirts
  DRESS: "DRESSES",
  DRESSES: "DRESSES",
  SKIRT: "SKIRTS",
  SKIRTS: "SKIRTS",

  // fragrance
  PERFUME: "FRAGRANCES",
  PERFUMES: "FRAGRANCES",
  FRAGRANCE: "FRAGRANCES",
  FRAGRANCES: "FRAGRANCES",

  // knit / sweaters
  SWEATER: "SWEATERS",
  SWEATERS: "SWEATERS",
  PULLOVER: "SWEATERS",
  PULLOVERS: "SWEATERS",
  JUMPER: "SWEATERS",
  JUMPERS: "SWEATERS",
  TURTLENECK: "SWEATERS",
  TURTLENECKS: "SWEATERS",
  MOCKNECK: "SWEATERS",
  MOCKNECKS: "SWEATERS",
  KNIT: "KNITWEAR",
  KNITS: "KNITWEAR",
  KNITTED: "KNITWEAR",
  KNITWEAR: "KNITWEAR",
  CARDIGAN: "CARDIGANS",
  CARDIGANS: "CARDIGANS",

  // scarves
  SCARF: "SCARVES",
  SCARFS: "SCARVES",
  SCARVES: "SCARVES",
  SHAWL: "SCARVES",
  SHAWLS: "SCARVES",
};

function canonicalizeCategory(raw) {
  let s = String(raw || "").trim().toUpperCase();
  if (!s) return "";
  s = s.replace(/\s+/g, "_").replace(/[^A-Z0-9_/-]/g, "");
  s = s.replace(/-/g, "_");
  s = CATEGORY_ALIASES[s] || s;
  return s;
}

// Title/page-text based detector (cheap)
function detectProductTypeFromTitle(titleRaw) {
  const t = normalizeForMatch(titleRaw);

  const rules = [
    // Accessories first
    { type: "SCARVES", re: /\bscarf(s)?\b|\bshawl(s)?\b|\bfoulard\b|\bsciarpa\b|\b围巾\b/ },

    // Knit / sweaters
    { type: "CARDIGANS", re: /\bcardigan(s)?\b/ },
    { type: "KNITWEAR", re: /\bknit\s*wear\b|\bknitted\b|\bmaglia\b|\btricot\b/ },
    { type: "SWEATERS", re: /\bsweater(s)?\b|\bjumper(s)?\b|\bpullover(s)?\b|\bmaglione\b|\bpull\b/ },

    // Fragrance
    { type: "FRAGRANCES", re: /\bperfume\b|\bparfum\b|\bfragrance\b|\bcologne\b|\beau de\b|\bprofumo\b/ },

    // Tops
    { type: "HOODIES", re: /\bhoodie(s)?\b|\bhooded\b|\bfelpa con cappuccio\b|\b卫衣\b/ },
    { type: "SWEATSHIRTS", re: /\bsweatshirt(s)?\b|\bcrewneck\b|\bgirocollo\b|\bfelpa\b/ },

    // LONGSLEEVE
    { type: "LONGSLEEVES", re: /\blong[-\s]*slee+v?e\b|\bl\/s\b|\bls\s*tee\b|\blong\s*sleeve\b|\b长袖\b/ },

    { type: "TSHIRTS", re: /\bt\s*-\s*shirt\b|\bt\s*shirt\b|\btshirt\b|\btee\b|\bmaglietta\b|\b短袖\b/ },
    { type: "SHIRTS", re: /\bshirt(s)?\b|\bbutton\s*up\b|\bcamicia\b/ },
    { type: "POLOS", re: /\bpolo(s)?\b/ },

    // Bottoms
    { type: "JEANS", re: /\bjeans\b|\bdenim\b|\bjean\b|\b牛仔\b/ },
    { type: "SHORTS", re: /\bshort(s)?\b|\bbermuda\b/ },
    { type: "PANTS", re: /\btrousers?\b|\bpants\b|\bpantaloni\b|\b裤\b/ },
    { type: "SWEATPANTS", re: /\bsweatpants\b|\bpantaloni tuta\b/ },
    { type: "JOGGERS", re: /\bjoggers?\b|\bpantaloni jogger\b/ },

    // Outerwear
    { type: "JACKETS", re: /\bjacket(s)?\b|\bgiacca\b|\b外套\b/ },
    { type: "PUFFERS", re: /\bpuffer\b|\bdown\s*jacket\b|\bpiumino\b/ },
    { type: "COATS", re: /\bcoat(s)?\b|\bcappotto\b/ },

    // Footwear
    { type: "SLIDES", re: /\bslides?\b|\bciabatt(e|a)\b/ },
    { type: "SANDALS", re: /\bsandals?\b|\bflip\s*flops?\b/ },
    { type: "SNEAKERS", re: /\bsneakers?\b|\btrainers?\b|\bscarpe da ginnastica\b|\b运动鞋\b/ },
    { type: "BOOTS", re: /\bboots?\b|\bstivali\b/ },
    { type: "SHOES", re: /\bshoes?\b|\bscarpe\b|\b皮鞋\b/ },

    // Bags / small leather / headwear
    { type: "BAGS", re: /\bbag(s)?\b|\bborsa\b|\b包\b/ },
    { type: "WALLETS", re: /\bwallet(s)?\b|\bportafoglio\b/ },
    { type: "BELTS", re: /\bbelt(s)?\b|\bcintura\b/ },
    { type: "HATS", re: /\bhat(s)?\b|\bcappello\b/ },
    { type: "CAPS", re: /\bcap(s)?\b|\bbaseball\s*cap\b/ },
    { type: "BEANIES", re: /\bbeanie(s)?\b|\bberretto\b/ },
    { type: "SUNGLASSES", re: /\bsunglass(es)?\b|\bshades\b|\bocchiali da sole\b/ },
    { type: "WATCHES", re: /\bwatch(es)?\b|\borologio\b/ },
  ];

  for (const r of rules) if (r.re.test(t)) return r.type;
  return "OTHER";
}

// =====================================================
// Cache (disk) — key -> {category, confidence, ...}
// =====================================================
function loadCache() {
  const abs = absPathFromRoot(CORRECTOR_CACHE_FILE);
  if (!fs.existsSync(abs)) return { entries: {}, meta: { createdAt: new Date().toISOString() } };
  try {
    const j = JSON.parse(fs.readFileSync(abs, "utf-8"));
    if (j && typeof j === "object" && j.entries && typeof j.entries === "object") return j;
  } catch {}
  return { entries: {}, meta: { createdAt: new Date().toISOString() } };
}

function saveCache(state) {
  const abs = absPathFromRoot(CORRECTOR_CACHE_FILE);
  const dir = path.dirname(abs);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const out = { ...state, meta: { ...(state.meta || {}), updatedAt: new Date().toISOString(), version: VERSION } };
  fs.writeFileSync(abs, JSON.stringify(out, null, 2), "utf-8");
}

let cache = loadCache();
let cacheDirty = 0;

function getCache(k) {
  const e = cache.entries?.[k];
  return e && typeof e === "object" ? e : null;
}
function setCache(k, v) {
  cache.entries = cache.entries || {};
  cache.entries[k] = v;
  cacheDirty++;
  if (cacheDirty >= CORRECTOR_CACHE_FLUSH_EVERY) {
    try {
      saveCache(cache);
      cacheDirty = 0;
      console.log("💾 cache saved.");
    } catch (e) {
      console.log("⚠️ cache save failed:", String(e?.message || e));
    }
  }
}

// =====================================================
// Yupoo image helpers (best-effort key)
// =====================================================
function toHttpsUrl(u) {
  let s = String(u || "").trim();
  if (!s) return "";
  if (s.startsWith("//")) s = `https:${s}`;
  if (s.startsWith("/photo.yupoo.com/")) s = `https://${s.slice(1)}`;
  return s;
}

function fixPhotoDoubleHost(u) {
  let s = String(u || "").trim();
  if (!s) return "";
  s = s.replace(/^https?:\/\/photo\.yupoo\.com\/+photo\.yupoo\.com\//i, "https://photo.yupoo.com/");
  s = s.replace(/^https?:\/\/photo\.yupoo\.com\/{2,}/i, "https://photo.yupoo.com/");
  return s;
}

// size-aware: big -> medium -> small
function toYupooPhotoUrlSized(u, size) {
  let s = fixPhotoDoubleHost(toHttpsUrl(u));
  if (!s) return "";
  return s.replace(
    /\/(big|medium|small|thumb|square)\.(jpg|jpeg|png|webp)(\?.*)?$/i,
    (_m, _sz, ext, qs) => `/${size}.${ext}${qs || ""}`
  );
}

function yupooImageKey(url) {
  try {
    const u = new URL(fixPhotoDoubleHost(toHttpsUrl(url)));
    const host = (u.hostname || "").toLowerCase();
    if (!host.includes("photo.yupoo.com")) return "";
    const parts = u.pathname.split("/").filter(Boolean);
    if (parts.length >= 2) return `${parts[0]}/${parts[1]}`;
    return "";
  } catch {
    return "";
  }
}

function dedupePreserveOrder(list) {
  const out = [];
  const seen = new Set();
  for (const x of Array.isArray(list) ? list : []) {
    const u = String(x || "").trim();
    if (!u) continue;
    const k = yupooImageKey(u) || u;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(u);
  }
  return out;
}

// =====================================================
// Image fetch as data URI (Playwright request with cookies)
// - Fallback: original -> big -> medium -> small
// - Se "too large": NON fail (si prova medium/small)
// =====================================================
async function fetchImageAsDataUri(context, url, detailMode = "low", referer = "") {
  const u0 = fixPhotoDoubleHost(toHttpsUrl(url));
  if (!u0) throw new Error("empty image url");

  const candidates = dedupePreserveOrder([
    u0,
    toYupooPhotoUrlSized(u0, "big"),
    toYupooPhotoUrlSized(u0, "medium"),
    toYupooPhotoUrlSized(u0, "small"),
  ]);

  const headers = {
    "user-agent": REAL_UA,
    accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
    "accept-language": ACCEPT_LANG,
    ...(referer ? { referer } : {}),
  };

  let lastErr = null;

  for (const u of candidates) {
    try {
      const res = await context.request.get(u, { timeout: 25000, maxRedirects: 6, headers });
      const status = res.status();
      const ct = String(res.headers()["content-type"] || "").split(";")[0].trim().toLowerCase();

      if (res.ok() && ct.startsWith("image/")) {
        const buf = await res.body();

        // ✅ se troppo grande, prova la candidate successiva (medium/small)
        if (buf.length > CORRECTOR_AI_MAX_BYTES) {
          lastErr = new Error(`image too large bytes=${buf.length} url=${u}`);
          continue;
        }

        return { dataUri: `data:${ct};base64,${buf.toString("base64")}`, usedUrl: u, detailMode };
      }

      const preview = (await res.text().catch(() => "")).slice(0, 140).replace(/\s+/g, " ");
      lastErr = new Error(`non-image/blocked ${status} ct=${ct} preview=${preview}`);
    } catch (e) {
      lastErr = e;
    }
  }

  throw lastErr || new Error("fetchImageAsDataUri failed");
}

// =====================================================
// Album page fallback: og:image + embedded photo.yupoo urls
// =====================================================
async function fetchAlbumFallbackImages(context, albumUrl) {
  const album = toHttpsUrl(albumUrl);
  if (!album) return [];

  const headers = {
    "user-agent": REAL_UA,
    accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "accept-language": ACCEPT_LANG,
  };

  try {
    const res = await context.request.get(album, { timeout: 25000, maxRedirects: 6, headers });
    if (!res.ok()) return [];
    const html = await res.text();

    const out = [];

    const og = html.match(/property=["']og:image["'][^>]*content=["']([^"']+)["']/i);
    if (og?.[1]) out.push(og[1]);

    const re =
      /https?:\/\/photo\.yupoo\.com\/[^\s"'\\]+?\.(?:jpg|jpeg|png|webp)(?:\?[^\s"'\\]+)?/gi;
    const found = html.match(re) || [];
    out.push(...found);

    return dedupePreserveOrder(out.map((x) => fixPhotoDoubleHost(toHttpsUrl(x))));
  } catch {
    return [];
  }
}

// =====================================================
// NEW: Page-hint da pagina album (colonna Q)
// =====================================================
function stripTags(s) {
  return String(s || "")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function pickMeta(html, nameOrProp) {
  const re = new RegExp(
    `<meta[^>]+(?:name|property)=["']${nameOrProp}["'][^>]+content=["']([^"']+)["']`,
    "i"
  );
  const m = html.match(re);
  return m?.[1] ? stripTags(m[1]) : "";
}

function pickTitle(html) {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m?.[1] ? stripTags(m[1]) : "";
}

function pickBreadcrumbTexts(html) {
  const out = [];
  const re = /<a[^>]+href=["'][^"']*\/categories\/[^"']+["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html))) {
    const txt = stripTags(m[1]);
    if (txt && txt.length <= 60) out.push(txt);
  }
  return dedupePreserveOrder(out);
}

function pickJsonCategoryNames(html) {
  const out = [];
  const res = [
    /"categoryName"\s*:\s*"([^"]{1,80})"/g,
    /"cateName"\s*:\s*"([^"]{1,80})"/g,
    /"category"\s*:\s*"([^"]{1,80})"/g,
  ];
  for (const re of res) {
    let m;
    while ((m = re.exec(html))) {
      const txt = stripTags(m[1]);
      if (txt && txt.length <= 80) out.push(txt);
    }
  }
  return dedupePreserveOrder(out);
}

function makePageCacheKey(albumUrl) {
  // mettiamo anche origin per evitare collisioni strane
  try {
    const u = new URL(toHttpsUrl(albumUrl));
    return `page::${u.origin}${u.pathname}`.toLowerCase();
  } catch {
    return `page::${String(albumUrl || "").trim().toLowerCase()}`;
  }
}

async function detectCategoryFromAlbumPage(context, albumUrl) {
  const album = toHttpsUrl(albumUrl);
  if (!album) return { category: "OTHER", confidence: 0, reason: "NO_ALBUM_URL" };

  const pageKey = makePageCacheKey(album);
  const cached = getCache(pageKey);
  if (cached && cached.category && typeof cached.confidence === "number") {
    return { category: cached.category, confidence: cached.confidence, reason: "PAGE_CACHED" };
  }

  const headers = {
    "user-agent": REAL_UA,
    accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "accept-language": ACCEPT_LANG,
  };

  try {
    const res = await context.request.get(album, { timeout: 25000, maxRedirects: 6, headers });
    if (!res.ok()) return { category: "OTHER", confidence: 0, reason: `PAGE_HTTP_${res.status()}` };

    const html = await res.text();

    const title = pickTitle(html);
    const ogTitle = pickMeta(html, "og:title");
    const keywords = pickMeta(html, "keywords");
    const desc = pickMeta(html, "description");
    const crumbs = pickBreadcrumbTexts(html);
    const jsonCats = pickJsonCategoryNames(html);

    const parts = [ogTitle, title, keywords, desc, ...crumbs, ...jsonCats].filter(Boolean);
    const text = parts.join(" | ").slice(0, 900);

    if (!text) return { category: "OTHER", confidence: 0, reason: "PAGE_EMPTY" };

    // conf euristica: breadcrumb/json > keywords/meta > title
    let conf = 0.62;
    if (crumbs.length) conf = 0.82;
    else if (jsonCats.length) conf = 0.78;
    else if (keywords || ogTitle) conf = 0.70;

    const cat = detectProductTypeFromTitle(text);
    if (cat && cat !== "OTHER" && ALLOWED_TYPES.has(cat)) {
      const result = { category: cat, confidence: conf };
      setCache(pageKey, result); // ✅ cache positiva page-hint
      return { ...result, reason: "PAGE_HINT" };
    }

    // cache “neutro” (no-match) per evitare refetch continuo
    setCache(pageKey, { category: "OTHER", confidence: 0.0 });
    return { category: "OTHER", confidence: 0, reason: "PAGE_HINT_NO_MATCH" };
  } catch (e) {
    return { category: "OTHER", confidence: 0, reason: "PAGE_ERR", err: String(e?.message || e) };
  }
}

// =====================================================
// Challenge priming
// =====================================================
async function primePhotoSession(context) {
  const p = await context.newPage();
  try {
    await p.goto("https://photo.yupoo.com/", { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT });
    await p.waitForTimeout(1200);
    const txt = await p.evaluate(() => (document.body?.innerText || "").slice(0, 240)).catch(() => "");
    const blocked =
      String(txt || "").toLowerCase().includes("restricted") || String(txt || "").toLowerCase().includes("access");
    return !blocked;
  } catch {
    return false;
  } finally {
    try {
      await p.close();
    } catch {}
  }
}

async function solveChallengeHeadful(browser, storageAbs) {
  console.log("🛑 photo.yupoo.com sembra bloccato. Apro headful per risolvere la challenge...");
  const ctx = await browser.newContext({
    storageState: fs.existsSync(storageAbs) ? storageAbs : undefined,
    userAgent: REAL_UA,
    locale: "it-IT",
    extraHTTPHeaders: { "accept-language": ACCEPT_LANG },
  });
  const p = await ctx.newPage();
  await p.goto("https://photo.yupoo.com/", { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT }).catch(() => {});
  console.log("➡️  Risolvi la challenge nella finestra e poi premi INVIO nel terminale.");
  await waitEnter("✅ Premi INVIO quando hai risolto... ");
  await ctx.storageState({ path: storageAbs });
  try {
    await ctx.close();
  } catch {}
}

// =====================================================
// AI detect category from image
// =====================================================
function safeJsonExtractObj(s) {
  const txt = String(s || "").trim();
  if (!txt) return null;
  try {
    return JSON.parse(txt);
  } catch {}
  const a = txt.indexOf("{");
  const b = txt.lastIndexOf("}");
  if (a >= 0 && b > a) {
    try {
      return JSON.parse(txt.slice(a, b + 1));
    } catch {}
  }
  return null;
}

function makeCacheKey(imageUrl, referer = "") {
  const imgKey = yupooImageKey(imageUrl) || fixPhotoDoubleHost(toHttpsUrl(imageUrl)) || imageUrl;
  let refKey = "";
  try {
    refKey = referer ? new URL(referer).origin : "";
  } catch {}
  return `cat::${imgKey}::ref::${refKey}`;
}

async function aiDetectCategory(context, imageUrl, brandHint, titleHint, referer = "", pass = 1) {
  if (!openai) return { category: "OTHER", confidence: 0, fetchOk: false, reason: "AI_OFF" };

  const key = makeCacheKey(imageUrl, referer);

  // ✅ Usa cache solo se NON è un vecchio negativo (category OTHER + conf 0 + err)
  const cached = getCache(key);
  if (cached && cached.category && typeof cached.confidence === "number") {
    const isOldNegative = cached.category === "OTHER" && Number(cached.confidence) === 0 && !!cached.err;
    if (!isOldNegative) return { ...cached, fetchOk: true, reason: "CACHED" };
  }

  const allowed = Array.from(ALLOWED_TYPES).join(", ");
  const detail = pass === 1 ? CORRECTOR_IMAGE_DETAIL : CORRECTOR_SECOND_PASS_DETAIL;

  const prompt = `
Return ONLY valid JSON: {"category":"", "confidence":0}

- category MUST be one of: ${allowed}
- confidence MUST be 0..1
- If unsure -> category="OTHER" and confidence<=0.40

BRAND_HINT: ${String(brandHint || "").slice(0, 80)}
TITLE_HINT: ${String(titleHint || "").slice(0, 220)}
`.trim();

  let lastErr = null;

  for (let attempt = 1; attempt <= Math.max(1, CORRECTOR_RETRIES); attempt++) {
    try {
      const { dataUri, usedUrl } = await fetchImageAsDataUri(context, imageUrl, detail, referer);

      const resp = await openai.responses.create({
        model: CORRECTOR_MODEL,
        input: [
          {
            role: "user",
            content: [
              { type: "input_text", text: prompt },
              { type: "input_image", image_url: dataUri, detail },
            ],
          },
        ],
        max_output_tokens: CORRECTOR_MAX_OUTPUT_TOKENS,
      });

      const obj = safeJsonExtractObj(resp.output_text || "") || {};
      let cat = canonicalizeCategory(obj.category || "");
      let conf = Number(obj.confidence);

      if (!cat) cat = "OTHER";
      if (!ALLOWED_TYPES.has(cat)) cat = "OTHER";
      if (!Number.isFinite(conf)) conf = 0;

      const result = { category: cat, confidence: Math.max(0, Math.min(1, conf)) };

      // ✅ cache SOLO su successo reale (fetch OK + risposta AI OK)
      setCache(key, result);

      return { ...result, fetchOk: true, reason: "OK", usedUrl };
    } catch (e) {
      lastErr = e;
      const msg = String(e?.message || e);

      // ✅ se è un problema di fetch/blocco/too-large: NON cacheare negativo
      if (
        msg.includes("non-image/blocked") ||
        msg.includes("fetchImageAsDataUri") ||
        msg.includes("image too large")
      ) {
        return { category: "OTHER", confidence: 0, fetchOk: false, reason: "FETCH_FAIL", err: msg };
      }

      // retry su 429
      if (msg.includes("429")) await sleep(2500 * attempt);
      else await sleep(700 * attempt);
    }
  }

  // ✅ errore AI vero: non cacheare negativo
  return { category: "OTHER", confidence: 0, fetchOk: false, reason: "AI_ERR", err: String(lastErr?.message || lastErr) };
}

// =====================================================
// Google Sheets
// =====================================================
function getSheetsClient() {
  const credentials = JSON.parse(fs.readFileSync(absCredPath, "utf-8"));
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  return google.sheets({ version: "v4", auth });
}

async function readRowsA2Q(sheets) {
  const range = `${sheetA1Tab(SHEET_TAB)}!A2:Q`;
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range });
  return res.data.values || [];
}

async function batchUpdate(sheets, updates) {
  if (!updates.length) return;
  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: SHEET_ID,
    requestBody: { valueInputOption: "RAW", data: updates },
  });
}

// =====================================================
// Title formatting
// =====================================================
function splitTitleIndexSuffix(title) {
  const t = String(title || "").trim();
  if (!t) return { base: "", suffix: "" };
  const m = t.match(/^(.*?)(\s*\(\d+\))\s*$/);
  if (m) return { base: String(m[1] || "").trim(), suffix: String(m[2] || "").trim() };
  return { base: t, suffix: "" };
}

function buildNewTitle(brand, category, oldTitle) {
  const b = String(brand || "").trim();
  const c = String(category || "").trim();
  const base = (b ? b.toUpperCase() : "").trim();
  const main = base && c ? `${base} ${c}` : base || c || "";
  if (!main) return String(oldTitle || "").trim();

  if (!CORRECTOR_KEEP_TITLE_INDEX) return main;

  const { suffix } = splitTitleIndexSuffix(oldTitle);
  return suffix ? `${main} ${suffix}`.trim() : main;
}

// =====================================================
// Worker pool
// =====================================================
function createQueue(items) {
  let idx = 0;
  return {
    next() {
      if (idx >= items.length) return null;
      return { i: idx, item: items[idx++] };
    },
  };
}

async function main() {
  const sheets = getSheetsClient();
  const rows = await readRowsA2Q(sheets);

  // columns mapping A..Q (1..17)
  // A id, B slug, C title, D brand, E category, F seller,
  // G img1..N img8, O extra_images, P status, Q yupoo_url
  const targets = [];
  for (let i = 0; i < rows.length; i++) {
    const rowNum = i + 2;
    const row = padToLen(rows[i], 17);

    const title = String(row[2] || "").trim();
    const brand = String(row[3] || "").trim();
    const category = String(row[4] || "").trim();
    const seller = String(row[5] || "").trim().toLowerCase();

    const img1 = String(row[6] || "").trim();

    if (CORRECTOR_ONLY_SELLER && seller !== CORRECTOR_ONLY_SELLER) continue;
    if (CORRECTOR_ONLY_OTHER && String(category).trim().toUpperCase() !== "OTHER") continue;
    if (!img1) continue;

    targets.push({ rowNum, row, title, brand, category, seller });
    if (CORRECTOR_LIMIT && targets.length >= CORRECTOR_LIMIT) break;
  }

  console.log(`🎯 Target (category=OTHER + img1): ${targets.length}`);
  if (!targets.length) return;

  // Playwright context (headless by default)
  const storageAbs = absPathFromRoot(YUPOO_STORAGE_STATE);
  const browser = await chromium.launch({ headless: !CORRECTOR_HEADFUL });
  let context = null;

  try {
    context = await browser.newContext({
      storageState: fs.existsSync(storageAbs) ? storageAbs : undefined,
      userAgent: REAL_UA,
      locale: "it-IT",
      extraHTTPHeaders: { "accept-language": ACCEPT_LANG },
    });
    context.setDefaultNavigationTimeout(NAV_TIMEOUT);

    console.log("🔐 Priming photo.yupoo.com session...");
    const ok = await primePhotoSession(context);
    if (!ok) {
      if (!CORRECTOR_HEADFUL) {
        console.log(
          "🛑 photo.yupoo.com è bloccato. Rilancia con CORRECTOR_HEADFUL=1, risolvi la challenge, poi rilancia senza."
        );
        return;
      }
      await solveChallengeHeadful(browser, storageAbs);
      try {
        await context.close();
      } catch {}
      context = await browser.newContext({
        storageState: fs.existsSync(storageAbs) ? storageAbs : undefined,
        userAgent: REAL_UA,
        locale: "it-IT",
        extraHTTPHeaders: { "accept-language": ACCEPT_LANG },
      });
      context.setDefaultNavigationTimeout(NAV_TIMEOUT);
    }

    const q = createQueue(targets);
    const pendingUpdates = [];
    let changedCount = 0;
    let noChangeCount = 0;
    let failCount = 0;

    async function flushNow(force = false) {
      if (!pendingUpdates.length) return;
      if (!force && pendingUpdates.length < CORRECTOR_FLUSH_EVERY) return;

      if (CORRECTOR_DRY_RUN) {
        console.log(`🧪 DRY_RUN: flush skipped (${pendingUpdates.length} updates buffered)`);
        pendingUpdates.splice(0, pendingUpdates.length);
        return;
      }

      const slice = pendingUpdates.splice(0, pendingUpdates.length);
      await batchUpdate(sheets, slice);
      console.log(`✅ FLUSH -> wrote ${slice.length} updates`);
    }

    async function worker(wid) {
      while (true) {
        const nx = q.next();
        if (!nx) break;

        const { rowNum, row, title, brand } = nx.item;
        const currentCat = String(row[4] || "").trim().toUpperCase();

        // candidate images: img1..img8 + extra_images
        const imgs = [];
        for (let k = 6; k <= 13; k++) {
          const u = String(row[k] || "").trim();
          if (u) imgs.push(u);
        }
        const extra = String(row[14] || "").trim();
        if (extra) {
          for (const part of extra.split(",").map((x) => x.trim()).filter(Boolean)) imgs.push(part);
        }

        let candidates = dedupePreserveOrder(imgs);

        const referer = String(row[16] || "").trim(); // yupoo_url (col Q)

        try {
          // 1) Title hint first (no tokens)
          if (CORRECTOR_USE_TITLE_HINT_FIRST) {
            const hint = detectProductTypeFromTitle(title);
            if (hint && hint !== "OTHER" && ALLOWED_TYPES.has(hint)) {
              const newTitle = buildNewTitle(brand, hint, title);
              pendingUpdates.push({
                range: `${sheetA1Tab(SHEET_TAB)}!C${rowNum}:E${rowNum}`,
                values: [[newTitle, row[3] || "", hint]], // C,D,E
              });
              changedCount++;
              console.log(
                `✅ row ${rowNum} | ${brand || "-"} | ${currentCat} -> ${hint} (title-hint) | "${title}" -> "${newTitle}"`
              );
              await flushNow(false);
              continue;
            }
          }

          // 2) ✅ NEW: Page-hint dalla pagina Yupoo (col Q) prima dell'AI
          if (CORRECTOR_USE_PAGE_HINT_FIRST && referer) {
            const ph = await detectCategoryFromAlbumPage(context, referer);
            if (ph.category !== "OTHER" && ph.confidence >= CORRECTOR_PAGE_HINT_MIN_CONF) {
              const newTitle = buildNewTitle(brand, ph.category, title);
              pendingUpdates.push({
                range: `${sheetA1Tab(SHEET_TAB)}!C${rowNum}:E${rowNum}`,
                values: [[newTitle, row[3] || "", ph.category]],
              });
              changedCount++;
              console.log(
                `✅ row ${rowNum} | ${brand || "-"} | OTHER -> ${ph.category} (page-hint conf=${ph.confidence.toFixed(
                  2
                )}) | "${title}" -> "${newTitle}"`
              );
              await flushNow(false);
              continue;
            }
          }

          if (!openai) {
            noChangeCount++;
            console.log(`↩️ row ${rowNum} no-change | AI OFF | "${title}"`);
            continue;
          }

          // 3) AI multi-image fallback (pass1 low -> pass2 auto)
          let best = { category: "OTHER", confidence: 0, used: "", reason: "" };
          let addedAlbumFallback = false;

          for (let pass = 1; pass <= 2; pass++) {
            if (pass === 2 && best.category !== "OTHER") break;

            let okAttempts = 0;

            for (const img of candidates) {
              const r = await aiDetectCategory(context, img, brand, title, referer, pass);

              if (!r.fetchOk) {
                best.reason = best.reason || r.reason || "FETCH_FAIL";
                continue; // non conta come tentativo utile
              }

              okAttempts++;

              const aiCat = r.category || "OTHER";
              const conf = Number(r.confidence) || 0;

              if (aiCat !== "OTHER" && conf >= CORRECTOR_MIN_CONFIDENCE) {
                best = { category: aiCat, confidence: conf, used: r.usedUrl || img, reason: r.reason || "OK" };
                break;
              }

              if (conf > best.confidence) {
                best = { category: aiCat, confidence: conf, used: r.usedUrl || img, reason: r.reason || "OK" };
              }

              if (okAttempts >= CORRECTOR_MAX_IMAGES_TO_TRY) break;
            }

            // se non siamo riusciti a processare nulla (tutti fetch fail),
            // prova fallback da pagina album (referer) e ripeti lo stesso pass
            if (!addedAlbumFallback && referer && best.category === "OTHER" && best.confidence === 0) {
              const fb = await fetchAlbumFallbackImages(context, referer);
              if (fb.length) {
                candidates = dedupePreserveOrder([...fb, ...candidates]);
                addedAlbumFallback = true;
                pass--; // ripeti stesso pass con nuove immagini
                continue;
              }
            }
          }

          const aiCat = best.category;
          const conf = best.confidence;

          if (aiCat && aiCat !== "OTHER" && ALLOWED_TYPES.has(aiCat) && conf >= CORRECTOR_MIN_CONFIDENCE) {
            const newTitle = buildNewTitle(brand, aiCat, title);
            pendingUpdates.push({
              range: `${sheetA1Tab(SHEET_TAB)}!C${rowNum}:E${rowNum}`,
              values: [[newTitle, row[3] || "", aiCat]],
            });
            changedCount++;
            console.log(
              `✅ row ${rowNum} | ${brand || "-"} | OTHER -> ${aiCat} (conf=${conf.toFixed(2)}) | "${title}" -> "${newTitle}"`
            );
            await flushNow(false);
          } else {
            noChangeCount++;
            console.log(
              `↩️ row ${rowNum} no-change | ai=${aiCat || "OTHER"} conf=${(conf || 0).toFixed(
                2
              )} reason=${best.reason || "LOW_CONF"} | "${title}"`
            );
          }
        } catch (e) {
          failCount++;
          console.log(`❌ row ${rowNum} fail: ${String(e?.message || e).split("\n")[0]}`);
        }
      }
    }

    const workers = [];
    for (let i = 0; i < CORRECTOR_CONCURRENCY; i++) workers.push(worker(i));
    await Promise.all(workers);

    await flushNow(true);

    try {
      saveCache(cache);
    } catch {}
    console.log("\n================ SUMMARY ================");
    console.log("changed :", changedCount);
    console.log("noChange:", noChangeCount);
    console.log("fail    :", failCount);
    console.log("=========================================");
  } finally {
    try {
      if (context) await context.close();
    } catch {}
    try {
      await browser.close();
    } catch {}
  }
}

main();