"use strict";

/**
 * scrape_yupoo_to_sheet.mjs (UPGRADED)
 *
 * ✅ Kept from your version:
 * - category pagination via NEXT arrow (block pagination)
 * - robust photo.yupoo.com normalization (fix doublehost)
 * - cover smart pick (internal header cover match -> fallback)
 * - write/update by id column A
 * - AI detect brand+category from IMG1 (img1 written in Sheet col img1)
 * - Expanded fashion taxonomy + AI category aliases normalization
 * - Robust image fetch for AI (request.get -> optional page.goto -> optional screenshot fallback)
 * - AI retries + debug logs
 * - token-saver: detect category from title first; AI category only when detectedType === OTHER (unless forced)
 * - footwear: optional AI shoe model name -> injected into TITLE (col C)
 * - Per-job TITLE MODE: AUTO / ALBUM / FORCE
 * - Per-job AI override: ai=auto|0|1
 * - Per-job shoeName override: shoeName=auto|0|1
 *
 * ✅ NEW reliability/perf:
 * 1) Checkpoint + resume (SCRAPER_CHECKPOINT_FILE, SCRAPER_RESUME=1)
 * 2) Flush to Google Sheet while working (SCRAPER_FLUSH_EVERY)
 * 3) Skip existing BEFORE opening album (SCRAPER_SKIP_EXISTING=1)
 * 4) Persistent AI cache on disk (SCRAPER_AI_CACHE_FILE)
 * 5) True album concurrency (SCRAPER_CONCURRENCY) with single-writer sheet lock
 * 6) Optional heavy AI fallbacks (SCRAPER_AI_ALLOW_PAGE_GOTO_FALLBACK / SCREENSHOT)
 * 7) Hard cap bytes for AI images (SCRAPER_AI_MAX_BYTES)
 * 8) Adaptive backoff on failures / restricted (SCRAPER_BACKOFF_*)
 *
 * ✅ NEW hardening (this patch):
 * 9) Fix queued-append duplicates: avoid UPDATE on row -1
 * 10) After successful append flush, backfill real rowNumber in byKey
 * 11) Graceful shutdown on SIGINT/SIGTERM + crash (flush + checkpoint + ai_cache)
 * 12) Extra network-down handling (internet disconnected etc.)
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
// DOTENV (robusto: sempre dal root progetto)
// =====================================================
dotenv.config({ path: path.join(PROJECT_ROOT, ".env.local") });

// =====================================================
// ENV / CONFIG
// =====================================================
const VERSION =
  "2026-02-11 | flush+checkpoint+resume + skip-existing-preopen + disk-ai-cache + album-concurrency + single-writer + optional heavy AI fallbacks + hardcap bytes + adaptive backoff + graceful shutdown + queued-append fix";

const SHEET_ID = (process.env.SHEET_ID || "").trim();
const SHEET_TAB = (process.env.SHEET_TAB || "items").trim();

const SERVICE_ACCOUNT_JSON = (process.env.GOOGLE_SERVICE_ACCOUNT_JSON || "./service-account.json").trim();

const NAV_TIMEOUT = Number(String(process.env.NAV_TIMEOUT || "90000").trim());
const BETWEEN_ALBUMS_SLEEP = Number(String(process.env.BETWEEN_ALBUMS_SLEEP || "0").trim()); // now default 0
const DEBUG_COVER = String(process.env.DEBUG_COVER || "").trim() === "1";

// Concurrency
const SCRAPER_CONCURRENCY = Math.max(1, Number(String(process.env.SCRAPER_CONCURRENCY || "2").trim()) || 2);

// Skip existing BEFORE opening album
const SCRAPER_SKIP_EXISTING = String(process.env.SCRAPER_SKIP_EXISTING || "0").trim() === "1";

// Flush/checkpoint
const SCRAPER_FLUSH_EVERY = Math.max(1, Number(String(process.env.SCRAPER_FLUSH_EVERY || "25").trim()) || 25);
const SCRAPER_CHECKPOINT_FILE = (process.env.SCRAPER_CHECKPOINT_FILE || "./scraper/checkpoint.json").trim();
const SCRAPER_RESUME = String(process.env.SCRAPER_RESUME || "1").trim() === "1";

// Disk AI cache
const SCRAPER_AI_CACHE_FILE = (process.env.SCRAPER_AI_CACHE_FILE || "./scraper/ai_cache.json").trim();
const SCRAPER_AI_CACHE_FLUSH_EVERY = Math.max(
  5,
  Number(String(process.env.SCRAPER_AI_CACHE_FLUSH_EVERY || "40").trim()) || 40
);

// Optional heavy fallbacks for AI image fetch
const SCRAPER_AI_ALLOW_PAGE_GOTO_FALLBACK =
  String(process.env.SCRAPER_AI_ALLOW_PAGE_GOTO_FALLBACK || "0").trim() === "1";
const SCRAPER_AI_ALLOW_SCREENSHOT_FALLBACK =
  String(process.env.SCRAPER_AI_ALLOW_SCREENSHOT_FALLBACK || "0").trim() === "1";

// Hard cap bytes for AI image fetch
const SCRAPER_AI_MAX_BYTES = Math.max(
  200000,
  Number(String(process.env.SCRAPER_AI_MAX_BYTES || "2500000").trim()) || 2500000
);

// Backoff
const SCRAPER_BACKOFF_BASE_MS = Math.max(0, Number(String(process.env.SCRAPER_BACKOFF_BASE_MS || "0").trim()) || 0);
const SCRAPER_BACKOFF_MAX_MS = Math.max(
  2000,
  Number(String(process.env.SCRAPER_BACKOFF_MAX_MS || "60000").trim()) || 60000
);

// UA “reale”
const REAL_UA =
  (process.env.USER_AGENT || "").trim() ||
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";
const ACCEPT_LANG = (process.env.ACCEPT_LANGUAGE || "it-IT,it;q=0.9,en;q=0.8").trim();

// AI detect (img1)
const SCRAPER_DETECT_AI_RAW = String(process.env.SCRAPER_DETECT_AI || "0").trim();
const SCRAPER_DETECT_AI = SCRAPER_DETECT_AI_RAW === "1";

const SCRAPER_DETECT_MODEL = (process.env.SCRAPER_DETECT_MODEL || "gpt-4o-mini").trim();
const SCRAPER_DETECT_IMAGE_DETAIL = (process.env.SCRAPER_DETECT_IMAGE_DETAIL || "auto").trim();
const SCRAPER_DETECT_MAX_OUTPUT_TOKENS = Number(
  String(process.env.SCRAPER_DETECT_MAX_OUTPUT_TOKENS || "180").trim()
);

const SCRAPER_DETECT_RETRIES = Number(String(process.env.SCRAPER_DETECT_RETRIES || "2").trim());
const SCRAPER_DETECT_DEBUG = String(process.env.SCRAPER_DETECT_DEBUG || "0").trim() === "1";

const SCRAPER_OPENAI_API_KEY = String(
  process.env.SCRAPER_OPENAI_API_KEY || process.env.OPENAI_API_KEY || ""
).trim();

const SCRAPER_DETECT_EFFECTIVE = SCRAPER_DETECT_AI && !!SCRAPER_OPENAI_API_KEY;
const openai = SCRAPER_DETECT_EFFECTIVE ? new OpenAI({ apiKey: SCRAPER_OPENAI_API_KEY }) : null;

// footwear model title injection (default ON)
const SCRAPER_DETECT_SHOE_NAME =
  String(process.env.SCRAPER_DETECT_SHOE_NAME || "1").trim() === "1";

if (!SHEET_ID) {
  console.error("❌ ERRORE: SHEET_ID mancante nel file .env.local (root progetto)");
  process.exit(1);
}

// ✅ Path credenziali relativo al ROOT progetto (non dipende dal cwd)
const absCredPath = path.isAbsolute(SERVICE_ACCOUNT_JSON)
  ? SERVICE_ACCOUNT_JSON
  : path.join(PROJECT_ROOT, SERVICE_ACCOUNT_JSON.replace(/^\.\//, ""));

if (!fs.existsSync(absCredPath)) {
  console.error("❌ ERRORE: File credenziali non trovato:", absCredPath);
  process.exit(1);
}

function absPathFromRoot(p) {
  const raw = String(p || "").trim();
  if (!raw) return "";
  return path.isAbsolute(raw) ? raw : path.join(PROJECT_ROOT, raw.replace(/^\.\//, ""));
}

function sheetA1Tab(tab) {
  const safe = String(tab || "").replace(/'/g, "''");
  return `'${safe}'`;
}

function logAiDebug(...args) {
  if (SCRAPER_DETECT_DEBUG) console.log("🧠 AI-DEBUG:", ...args);
}

console.log("====================================");
console.log("✅ Yupoo -> Google Sheet Scraper");
console.log("VERSION:", VERSION);
console.log("ROOT:", PROJECT_ROOT);
console.log("ENV:", path.join(PROJECT_ROOT, ".env.local"));
console.log("SHEET_ID:", SHEET_ID);
console.log("TAB:", SHEET_TAB);
console.log("NAV_TIMEOUT(ms):", NAV_TIMEOUT);
console.log("UA:", REAL_UA);
console.log("🔐 Cred JSON:", absCredPath);
console.log("⚡ CONCURRENCY:", SCRAPER_CONCURRENCY);
console.log("⏩ SKIP_EXISTING(pre-open):", SCRAPER_SKIP_EXISTING ? "ON" : "OFF");
console.log("🧾 FLUSH_EVERY:", SCRAPER_FLUSH_EVERY);
console.log("💾 CHECKPOINT:", absPathFromRoot(SCRAPER_CHECKPOINT_FILE), "| resume:", SCRAPER_RESUME ? "ON" : "OFF");
console.log("💾 AI_CACHE:", absPathFromRoot(SCRAPER_AI_CACHE_FILE));
console.log("🤖 AI DETECT (global):", SCRAPER_DETECT_EFFECTIVE ? `ON (${SCRAPER_DETECT_MODEL})` : "OFF");
console.log("🤖 AI detail:", SCRAPER_DETECT_IMAGE_DETAIL);
console.log("🤖 AI retries:", SCRAPER_DETECT_RETRIES);
console.log("👟 AI shoe name (global):", SCRAPER_DETECT_EFFECTIVE && SCRAPER_DETECT_SHOE_NAME ? "ON" : "OFF");
console.log("🧠 AI heavy fallbacks:", {
  pageGoto: SCRAPER_AI_ALLOW_PAGE_GOTO_FALLBACK,
  screenshot: SCRAPER_AI_ALLOW_SCREENSHOT_FALLBACK,
  maxBytes: SCRAPER_AI_MAX_BYTES,
});
if (SCRAPER_DETECT_AI && !SCRAPER_OPENAI_API_KEY) {
  console.log("⚠️ AI DETECT è ON ma manca SCRAPER_OPENAI_API_KEY / OPENAI_API_KEY");
}
console.log("====================================");

// =====================================================
// UTILS
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

function slugify(input, maxLen = 90) {
  const out = String(input ?? "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return out.slice(0, maxLen);
}

function extractAlbumId(url) {
  const m = String(url).match(/\/albums\/(\d+)/);
  return m ? m[1] : "";
}

function isCategoryUrl(url) {
  return /\/categories\/\d+/.test(String(url || ""));
}
function isAlbumUrl(url) {
  return /\/albums\/\d+/.test(String(url || ""));
}

/**
 * Normalize album url:
 * - force uid=1
 * - keep isSubCate/referrercate if present
 */
function normalizeAlbumUrl(url) {
  try {
    const u = new URL(url);
    const m = u.pathname.match(/\/albums\/(\d+)/);
    if (!m) return url;

    const albumId = m[1];
    const out = new URL(`${u.origin}/albums/${albumId}`);

    const keep = ["isSubCate", "referrercate"];
    for (const k of keep) {
      const v = u.searchParams.get(k);
      if (v !== null) out.searchParams.set(k, v);
    }

    out.searchParams.set("uid", "1");
    return out.toString();
  } catch {
    return url;
  }
}

async function safeGoto(page, url, { retries = 3, timeout = NAV_TIMEOUT, allowRestricted = false } = {}) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const resp = await page.goto(url, { waitUntil: "domcontentloaded", timeout }).catch(() => null);
      const status = resp?.status?.() ?? 0;

      if ((status === 567 || status === 403) && !allowRestricted)
        throw new Error(`Restricted Access (${status || "blocked"})`);
      if (status >= 400 && status !== 567 && !allowRestricted) throw new Error(`HTTP ${status}`);

      const blocked = await page
        .evaluate(() => {
          const t = (document.body?.innerText || "").toLowerCase();
          return (
            t.includes("restricted access") ||
            t.includes("access restricted") ||
            t.includes("forbidden") ||
            t.includes("denied")
          );
        })
        .catch(() => false);

      if (blocked && !allowRestricted) throw new Error("Restricted Access (html)");
      return true;
    } catch (err) {
      const msg = String(err?.message || err);
      console.log(`⚠️ goto fail (${attempt}/${retries}): ${url}`);
      console.log(`   -> ${msg.split("\n")[0]}`);

      // ✅ extra: rete giù / DNS / reset -> aspetta di più
      const low = msg.toLowerCase();
      const isNetDown =
        low.includes("err_internet_disconnected") ||
        low.includes("enotfound") ||
        low.includes("econnreset") ||
        low.includes("timed out") ||
        low.includes("net::err");
      if (isNetDown) {
        await sleep(Math.min(10000, 2500 * attempt));
      }

      if (attempt === retries) throw err;
      await sleep(1400 * attempt);
    }
  }
  return false;
}

async function fastScroll(page) {
  try {
    await page.evaluate(async () => {
      const delay = (ms) => new Promise((r) => setTimeout(r, ms));
      const steps = 6;
      for (let i = 0; i < steps; i++) {
        window.scrollTo(0, (document.body.scrollHeight / steps) * (i + 1));
        await delay(220);
      }
      await delay(200);
      window.scrollTo(0, 0);
    });
  } catch {}
  await page.waitForTimeout(250);
}

function normalizeForMatch(text) {
  let t = String(text || "").toLowerCase();
  t = t.normalize("NFKD");
  t = t.replace(/[‐-‒–—−]/g, "-");
  t = t.replace(/[^\p{L}\p{N}\s-]+/gu, " ");
  t = t.replace(/\s+/g, " ").trim();
  return t;
}

// Hash leggero (stabile) per stringhe -> base36
function hash36(input) {
  const s = String(input || "");
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h) ^ s.charCodeAt(i);
  return (h >>> 0).toString(36);
}

function sellerKey(seller, anyUrl) {
  const s = slugify(seller || "", 32);
  if (s) return s;

  try {
    const host = new URL(anyUrl).hostname.split(".")[0] || "seller";
    return slugify(host, 32) || "seller";
  } catch {
    return "seller";
  }
}

function buildStableId(sellerName, source_url) {
  const sid = sellerKey(sellerName, source_url);
  const aid = extractAlbumId(source_url);
  const tail = aid ? aid : hash36(source_url).slice(0, 10);
  return `${sid}-${tail}`;
}

function buildUniqueSlug(title, sellerName, source_url) {
  const sid = sellerKey(sellerName, source_url);
  const base = slugify(title || "item", 60) || "item";
  const aid = extractAlbumId(source_url);
  const tail = aid ? aid : hash36(source_url).slice(0, 8);
  return slugify(`${base}-${sid}-${tail}`, 95);
}

// =====================================================
// SIMPLE ASYNC MUTEX
// =====================================================
function createMutex() {
  let p = Promise.resolve();
  return {
    async runExclusive(fn) {
      const prev = p;
      let release;
      p = new Promise((r) => (release = r));
      await prev;
      try {
        return await fn();
      } finally {
        release();
      }
    },
  };
}

// =====================================================
// ADAPTIVE BACKOFF / THROTTLE
// =====================================================
function createBackoff() {
  let streak = 0;
  let lastWait = 0;

  return {
    onOk() {
      streak = Math.max(0, streak - 1);
      lastWait = 0;
    },
    async onFail(kind = "fail") {
      // kind: restricted | net | fail
      streak = Math.min(10, streak + (kind === "restricted" ? 2 : 1));
      const base = SCRAPER_BACKOFF_BASE_MS;
      const exp = Math.min(SCRAPER_BACKOFF_MAX_MS, Math.round((base || 300) * Math.pow(2, streak - 1)));
      // add jitter
      const jitter = Math.round(exp * (0.15 + Math.random() * 0.25));
      const wait = Math.min(SCRAPER_BACKOFF_MAX_MS, exp + jitter);
      lastWait = wait;
      console.log(`⏳ Backoff(${kind}) streak=${streak} -> sleep ${(wait / 1000).toFixed(1)}s`);
      await sleep(wait);
    },
    getLastWait() {
      return lastWait;
    },
  };
}

// =====================================================
// YUPOO PHOTO NORMALIZATION (doublehost fix)
// =====================================================
function fixPhotoDoubleHost(u) {
  let s = String(u || "").trim();
  if (!s) return "";

  s = s.replace(
    /^https?:\/\/photo\.yupoo\.com\/+photo\.yupoo\.com\//i,
    "https://photo.yupoo.com/"
  );
  s = s.replace(/^https?:\/\/photo\.yupoo\.com\/{2,}/i, "https://photo.yupoo.com/");
  return s;
}

function isYupooPhotoUrl(u) {
  return typeof u === "string" && u.includes("photo.yupoo.com");
}

function toHttpsUrl(u) {
  let s = String(u || "").trim();
  if (!s) return "";
  if (s.startsWith("//")) s = `https:${s}`;
  if (s.startsWith("/photo.yupoo.com/")) s = `https://${s.slice(1)}`;
  s = fixPhotoDoubleHost(s);
  return s;
}

function toBigYupooPhotoUrl(u) {
  const s0 = String(u || "").trim();
  if (!s0) return "";

  let fixed = toHttpsUrl(s0);
  if (!isYupooPhotoUrl(fixed)) return fixed;

  fixed = fixPhotoDoubleHost(fixed);

  return fixed.replace(
    /\/(medium|small|thumb|square)\.(jpg|jpeg|png|webp)(\?.*)?$/i,
    (_m, _sz, ext, qs) => `/big.${ext}${qs || ""}`
  );
}

function yupooImageKey(url) {
  try {
    const u = new URL(toHttpsUrl(url));
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
  const order = [];
  const chosen = new Map(); // key -> url

  const isSizeVariant = (u) =>
    /\/(big|medium|small|thumb|square)\.(jpg|jpeg|png|webp)(\?.*)?$/i.test(String(u || ""));

  for (const x of Array.isArray(list) ? list : []) {
    const u = String(x || "").trim();
    if (!u) continue;

    const key = yupooImageKey(u) || u;

    if (!chosen.has(key)) {
      chosen.set(key, u);
      order.push(key);
      continue;
    }

    const prev = chosen.get(key);

    // ✅ Preferisci il "file vero" (es: /7679aa03.jpg) al variant /big.jpg
    const prevIsVar = isSizeVariant(prev);
    const nextIsVar = isSizeVariant(u);

    if (prevIsVar && !nextIsVar) {
      chosen.set(key, u);
      continue;
    }

    // Se entrambi sono variant, tieni il BIG (migliore qualità)
    if (prevIsVar && nextIsVar) {
      const prevIsBig = /\/big\./i.test(prev);
      const nextIsBig = /\/big\./i.test(u);
      if (nextIsBig && !prevIsBig) chosen.set(key, u);
    }
  }

  for (const k of order) {
    const v = String(chosen.get(k) || "").trim();
    if (v) out.push(v);
  }

  return out;
}

// =====================================================
// CHECKPOINT (resume robust) - stores DONE KEYS only after successful flush
// =====================================================
function loadCheckpoint() {
  const abs = absPathFromRoot(SCRAPER_CHECKPOINT_FILE);
  if (!SCRAPER_RESUME) return { done: {} };

  if (!fs.existsSync(abs)) return { done: {} };
  try {
    const j = JSON.parse(fs.readFileSync(abs, "utf-8"));
    if (j && typeof j === "object" && j.done && typeof j.done === "object") return j;
  } catch {}
  return { done: {} };
}

function saveCheckpoint(state) {
  const abs = absPathFromRoot(SCRAPER_CHECKPOINT_FILE);
  const dir = path.dirname(abs);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const out = {
    ...state,
    updatedAt: new Date().toISOString(),
    version: VERSION,
  };
  fs.writeFileSync(abs, JSON.stringify(out, null, 2), "utf-8");
}

function makeDoneKey(seller, albumUrl) {
  return `${String(seller || "").trim().toLowerCase()}||${normalizeAlbumUrl(String(albumUrl || "").trim())}`;
}

// =====================================================
// DISK AI CACHE (persist across runs)
// =====================================================
function loadAiDiskCache() {
  const abs = absPathFromRoot(SCRAPER_AI_CACHE_FILE);
  if (!fs.existsSync(abs)) return { entries: {}, meta: { createdAt: new Date().toISOString() } };
  try {
    const j = JSON.parse(fs.readFileSync(abs, "utf-8"));
    if (j && typeof j === "object" && j.entries && typeof j.entries === "object") return j;
  } catch {}
  return { entries: {}, meta: { createdAt: new Date().toISOString() } };
}

function saveAiDiskCache(state) {
  const abs = absPathFromRoot(SCRAPER_AI_CACHE_FILE);
  const dir = path.dirname(abs);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const out = {
    ...state,
    meta: { ...(state.meta || {}), updatedAt: new Date().toISOString(), version: VERSION },
  };
  fs.writeFileSync(abs, JSON.stringify(out, null, 2), "utf-8");
}

// =====================================================
// PER-JOB MODES (titleMode / ai / shoeName)
// =====================================================
function normTriState(v) {
  const s = String(v ?? "").trim().toLowerCase();
  if (!s) return "auto";
  if (s === "1" || s === "true" || s === "yes" || s === "on") return "1";
  if (s === "0" || s === "false" || s === "no" || s === "off") return "0";
  return "auto";
}

function isAiEnabledForJob(jobAi) {
  const m = normTriState(jobAi);
  if (m === "0") return false;
  if (m === "1") return !!openai; // deve esserci key
  return SCRAPER_DETECT_EFFECTIVE && !!openai;
}

function isShoeNameEnabledForJob(jobShoeName, aiEnabled) {
  const m = normTriState(jobShoeName);
  if (m === "0") return false;
  if (m === "1") return aiEnabled && !!openai;
  return aiEnabled && SCRAPER_DETECT_SHOE_NAME && !!openai;
}

function normalizeTitleMode(mode, titleProvided = "") {
  const s = String(mode || "").trim().toUpperCase();
  if (titleProvided && String(titleProvided).trim()) return "FORCE";
  if (s === "ALBUM" || s === "AUTO" || s === "FORCE") return s;
  return "AUTO";
}

// =====================================================
// AI in-memory cache (seeded from disk)
// =====================================================
const _aiCache = new Map();
let aiDisk = loadAiDiskCache();
let aiDiskDirtyCount = 0;

for (const [k, v] of Object.entries(aiDisk.entries || {})) {
  _aiCache.set(k, v);
}

function setAiCache(k, v) {
  _aiCache.set(k, v);
  aiDisk.entries = aiDisk.entries || {};
  aiDisk.entries[k] = v;
  aiDiskDirtyCount++;
  if (aiDiskDirtyCount >= SCRAPER_AI_CACHE_FLUSH_EVERY) {
    try {
      saveAiDiskCache(aiDisk);
      aiDiskDirtyCount = 0;
      console.log("💾 AI cache saved.");
    } catch (e) {
      console.log("⚠️ AI cache save failed:", String(e?.message || e));
    }
  }
}

// =====================================================
// AI helpers
// =====================================================
function toAiCoverUrl(u) {
  // prefer medium per costo
  const s = toBigYupooPhotoUrl(u);
  return s.replace(/\/big\.(jpg|jpeg|png|webp)/i, "/medium.$1");
}

function safeJsonExtract(s) {
  const txt = String(s || "").trim();
  if (!txt) return null;

  try {
    return JSON.parse(txt);
  } catch {}

  const start = txt.indexOf("{");
  const end = txt.lastIndexOf("}");
  if (start >= 0 && end > start) {
    const sub = txt.slice(start, end + 1);
    try {
      return JSON.parse(sub);
    } catch {}
  }
  return null;
}

function safeJsonExtractObj(s) {
  const obj = safeJsonExtract(s);
  return obj && typeof obj === "object" ? obj : null;
}

/**
 * ✅ Robust image fetch (improved + capped):
 * 1) context.request.get (fast) + headers realistici + referer
 * 2) OPTIONAL page.goto(url) + resp.body()
 * 3) OPTIONAL screenshot jpeg fallback
 */
async function fetchImageAsDataUri(context, url, opts = {}) {
  const raw = String(url || "").trim();
  if (!raw) return "";

  const referer = String(opts.referer || "").trim();

  const candidates = dedupePreserveOrder(
    [
      fixPhotoDoubleHost(toAiCoverUrl(raw)),
      fixPhotoDoubleHost(toBigYupooPhotoUrl(raw)),
      fixPhotoDoubleHost(toHttpsUrl(raw)),
    ].filter(Boolean)
  );

  let lastErr = null;

  const headers = {
    "user-agent": REAL_UA,
    accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
    "accept-language": ACCEPT_LANG,
    ...(referer ? { referer } : {}),
  };

  // (1) request.get
  for (const u of candidates) {
    for (let attempt = 1; attempt <= Math.max(1, SCRAPER_DETECT_RETRIES); attempt++) {
      try {
        const res = await context.request.get(u, {
          timeout: 25000,
          maxRedirects: 6,
          headers,
        });

        const status = res.status();
        const ct = String(res.headers()["content-type"] || "")
          .split(";")[0]
          .trim()
          .toLowerCase();
        const ok = res.ok();

        if (ok && ct.startsWith("image/")) {
          const buf = await res.body();

          if (buf.length > SCRAPER_AI_MAX_BYTES) {
            logAiDebug("AI image too large, skip", { url: u, bytes: buf.length, cap: SCRAPER_AI_MAX_BYTES });
            lastErr = new Error("AI image too large");
            continue;
          }

          const head = buf.slice(0, 160).toString("utf8").toLowerCase();
          if (head.includes("<!doctype") || head.includes("<html")) {
            const preview = head.replace(/\s+/g, " ").slice(0, 120);
            logAiDebug("request.get fake-image/html", { status, ct, url: u, preview });
            continue;
          }

          return `data:${ct || "image/jpeg"};base64,${buf.toString("base64")}`;
        }

        const preview = (await res.text().catch(() => "")).slice(0, 120).replace(/\s+/g, " ");
        logAiDebug("request.get non-image/blocked", { status, ct, url: u, preview });
        lastErr = new Error(`request.get non-image/blocked: ${status} ${ct}`);
      } catch (e) {
        lastErr = e;
        logAiDebug(`request.get failed (attempt ${attempt})`, { url: u, err: String(e?.message || e) });
        await sleep(350 * attempt);
      }
    }
  }

  // (2) OPTIONAL page.goto + body
  if (!SCRAPER_AI_ALLOW_PAGE_GOTO_FALLBACK) throw lastErr || new Error("fetchImageAsDataUri failed (request.get only)");

  for (const u of candidates) {
    for (let attempt = 1; attempt <= Math.max(1, SCRAPER_DETECT_RETRIES); attempt++) {
      const p = await context.newPage();
      try {
        await p
          .setExtraHTTPHeaders({
            accept: headers.accept,
            "accept-language": headers["accept-language"],
            ...(referer ? { referer } : {}),
          })
          .catch(() => {});

        const resp = await p
          .goto(u, {
            waitUntil: "domcontentloaded",
            timeout: 60000,
            ...(referer ? { referer } : {}),
          })
          .catch(() => null);

        await p.waitForTimeout(350);

        if (resp) {
          const status = resp.status();
          const ct = String(resp.headers()["content-type"] || "")
            .split(";")[0]
            .trim()
            .toLowerCase();

          if (status < 400 && ct.startsWith("image/")) {
            const buf = await resp.body();
            if (buf && Buffer.from(buf).length > SCRAPER_AI_MAX_BYTES) {
              logAiDebug("AI image too large (page.goto), skip", { url: u });
            } else {
              return `data:${ct || "image/jpeg"};base64,${Buffer.from(buf).toString("base64")}`;
            }
          }

          const txt = await resp.text().catch(() => "");
          logAiDebug("page.goto non-image/blocked", {
            status,
            ct,
            url: u,
            preview: txt.slice(0, 120).replace(/\s+/g, " "),
          });
          lastErr = new Error(`page.goto non-image/blocked: ${status} ${ct}`);
        } else {
          lastErr = new Error("page.goto no response");
          logAiDebug("page.goto no response", { url: u });
        }

        // (3) OPTIONAL screenshot fallback
        if (SCRAPER_AI_ALLOW_SCREENSHOT_FALLBACK) {
          try {
            const shot = await p.screenshot({ type: "jpeg", quality: 75, fullPage: true });
            if (shot.length <= SCRAPER_AI_MAX_BYTES) {
              return `data:image/jpeg;base64,${Buffer.from(shot).toString("base64")}`;
            }
          } catch (e2) {
            lastErr = e2;
            logAiDebug("screenshot failed", { url: u, err: String(e2?.message || e2) });
          }
        }
      } catch (e) {
        lastErr = e;
        logAiDebug(`page.goto failed (attempt ${attempt})`, { url: u, err: String(e?.message || e) });
      } finally {
        try {
          await p.close();
        } catch {}
      }

      await sleep(450 * attempt);
    }
  }

  throw lastErr || new Error("fetchImageAsDataUri failed");
}

// =====================================================
// AUTH: storageState + PRIME photo.yupoo.com
// =====================================================
async function tryExtractFirstAlbumUrl(page) {
  return page
    .evaluate(() => {
      const a =
        document.querySelector('a.album__main[href*="/albums/"]') ||
        document.querySelector('a[href*="/albums/"]');
      const href = a?.getAttribute("href") || "";
      if (!href) return "";
      try {
        return new URL(href, location.href).toString();
      } catch {
        return "";
      }
    })
    .catch(() => "");
}

async function tryExtractFirstPhotoUrl(page) {
  return page
    .evaluate(() => {
      const og = document.querySelector('meta[property="og:image"]')?.getAttribute("content") || "";
      if (og && og.includes("photo.yupoo.com")) return og;

      const img = Array.from(document.querySelectorAll("img")).find((i) => {
        const s =
          i.getAttribute("data-src") ||
          i.getAttribute("data-original") ||
          i.getAttribute("data-lazy") ||
          i.getAttribute("src") ||
          "";
        return s.includes("photo.yupoo.com");
      });

      const raw =
        img?.getAttribute("data-src") ||
        img?.getAttribute("data-original") ||
        img?.getAttribute("data-lazy") ||
        img?.getAttribute("src") ||
        "";

      if (!raw) return "";
      try {
        return new URL(raw, location.href).toString();
      } catch {
        return "";
      }
    })
    .catch(() => "");
}

async function ensureAuthStorage(browser, storagePath, primeUrl) {
  const sp = absPathFromRoot(storagePath);
  if (sp && fs.existsSync(sp)) return sp;

  console.log("\n🔐 AUTH/SESSIONE richiesta (storageState non trovato).");
  console.log("   Apro un browser visibile: risolvi eventuale blocco/captcha e poi premi INVIO.");
  console.log("   IMPORTANTISSIMO: dobbiamo settare cookie anche su photo.yupoo.com.");

  const ctx = await browser.newContext({
    userAgent: REAL_UA,
    locale: "it-IT",
    extraHTTPHeaders: { "accept-language": ACCEPT_LANG },
  });

  const page = await ctx.newPage();
  await safeGoto(page, primeUrl, { retries: 1, timeout: NAV_TIMEOUT, allowRestricted: true });
  await page.waitForTimeout(800);

  try {
    const isCat = isCategoryUrl(primeUrl);
    const isAlb = isAlbumUrl(primeUrl);

    if (isCat) {
      const alb = await tryExtractFirstAlbumUrl(page);
      if (alb) {
        await safeGoto(page, alb, { retries: 1, timeout: NAV_TIMEOUT, allowRestricted: true });
        await page.waitForTimeout(700);
      }
    }

    if (isAlb || isCat) {
      const photo = await tryExtractFirstPhotoUrl(page);
      if (photo) {
        const p2 = await ctx.newPage();
        await safeGoto(p2, photo, { retries: 1, timeout: 45000, allowRestricted: true });
        await p2.waitForTimeout(1200);
      }
    }
  } catch {}

  console.log("\n➡️  Se vedi una pagina di blocco/challenge, risolvila nella finestra del browser.");
  await waitEnter("✅ Quando vedi che la pagina funziona, premi INVIO per salvare la sessione... ");

  if (sp) {
    const dir = path.dirname(sp);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }

  await ctx.storageState({ path: sp });
  await ctx.close();

  console.log("✅ Sessione salvata in:", sp);
  return sp;
}

async function rescueIfRestricted(context, storageAbs, primeUrl) {
  console.log("\n🛟 BLOCCO RILEVATO (567/Restricted).");
  console.log("   Apro una pagina per far passare la challenge e aggiornare i cookie.");

  const p = await context.newPage();
  await safeGoto(p, primeUrl, { retries: 1, timeout: NAV_TIMEOUT, allowRestricted: true });
  await p.waitForTimeout(800);

  try {
    const photo = await tryExtractFirstPhotoUrl(p);
    if (photo) {
      const p2 = await context.newPage();
      await safeGoto(p2, photo, { retries: 1, timeout: 45000, allowRestricted: true });
      await p2.waitForTimeout(900);
    }
  } catch {}

  console.log("\n➡️  Risolvi la challenge nella finestra del browser.");
  await waitEnter("✅ Premi INVIO quando hai risolto, salvo storageState e continuo... ");

  await context.storageState({ path: storageAbs });
  try {
    await p.close();
  } catch {}
}

// =====================================================
// Yupoo external redirect decoder
// =====================================================
function decodeYupooExternalUrl(href) {
  try {
    const u = new URL(href);
    if (!u.hostname.includes("yupoo.com")) return href;

    if (u.pathname.includes("/external")) {
      const encoded = u.searchParams.get("url");
      if (!encoded) return href;

      let decoded = encoded;
      for (let i = 0; i < 3; i++) {
        try {
          const d = decodeURIComponent(decoded);
          if (d === decoded) break;
          decoded = d;
        } catch {
          break;
        }
      }

      if (decoded.startsWith("https%3A")) {
        try {
          decoded = decodeURIComponent(decoded);
        } catch {}
      }

      if (/^https?:\/\//i.test(decoded)) return decoded;
    }

    return href;
  } catch {
    return href;
  }
}

// =====================================================
// Weidian/Taobao canonicalizer + Source link picker
// =====================================================
function extractWeidianItemId(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    if (!host.includes("weidian.com")) return "";
    const id = u.searchParams.get("itemID") || u.searchParams.get("itemId") || "";
    return String(id || "").trim();
  } catch {
    return "";
  }
}

function canonicalizeWeidianItemUrl(url) {
  const id = extractWeidianItemId(url);
  if (!id) return url;
  return `https://weidian.com/item.html?itemID=${id}`;
}

function extractTaobaoItemId(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    if (!host.includes("taobao.com")) return "";
    const id = u.searchParams.get("id") || u.searchParams.get("itemId") || "";
    return String(id || "").trim();
  } catch {
    return "";
  }
}

function isTaobaoItemUrl(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    if (!host.includes("taobao.com")) return false;
    if (!/\/item\.htm$/i.test(u.pathname)) return false;
    return !!extractTaobaoItemId(url);
  } catch {
    return false;
  }
}

function canonicalizeTaobaoItemUrl(url) {
  const id = extractTaobaoItemId(url);
  if (!id) return url;
  return `https://item.taobao.com/item.htm?id=${id}`;
}

function isWeidianItemUrl(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    if (!host.includes("weidian.com")) return false;
    if (!/\/item\.html$/i.test(u.pathname)) return false;
    const id = u.searchParams.get("itemID") || u.searchParams.get("itemId") || "";
    return !!String(id || "").trim();
  } catch {
    return false;
  }
}

function isShortRedirectUrl(url) {
  try {
    const u = new URL(url);
    const h = u.hostname.toLowerCase();
    return h === "k.youshop10.com" || h.endsWith(".youshop10.com") || h === "m.tb.cn";
  } catch {
    return false;
  }
}

async function resolveFinalUrl(context, url) {
  if (!url) return "";
  let final = url;

  try {
    const res = await context.request.get(url, { maxRedirects: 10, timeout: 20000 });
    const u = res.url();
    if (u) final = u;
  } catch {}

  try {
    if (isShortRedirectUrl(final)) {
      const p = await context.newPage();
      await safeGoto(p, final, { retries: 1, timeout: 30000, allowRestricted: true });
      await p.waitForTimeout(900);
      final = p.url() || final;
      await p.close();
    }
  } catch {}

  return final;
}

async function pickPreferredSourceUrl(context, rawLinks) {
  const links = dedupePreserveOrder(
    (rawLinks || []).map((x) => String(x || "").trim()).filter(Boolean)
  );

  const decoded = links.map((u) => decodeYupooExternalUrl(u)).map((u) => String(u || "").trim());

  for (const u of decoded) {
    if (isWeidianItemUrl(u)) return canonicalizeWeidianItemUrl(u);
    if (u.includes("v.weidian.com/item.html")) return canonicalizeWeidianItemUrl(u);
  }

  for (const u of decoded) {
    if (isTaobaoItemUrl(u)) return canonicalizeTaobaoItemUrl(u);
  }

  for (const u0 of decoded) {
    if (!isShortRedirectUrl(u0)) continue;
    const resolved = await resolveFinalUrl(context, u0);
    const u = decodeYupooExternalUrl(resolved || u0);
    if (isWeidianItemUrl(u)) return canonicalizeWeidianItemUrl(u);
    if (isTaobaoItemUrl(u)) return canonicalizeTaobaoItemUrl(u);
  }

  return "";
}

// =====================================================
// cover helpers
// =====================================================
function pickCoverFromCategory(coverFromCategory) {
  return toHttpsUrl(coverFromCategory);
}

async function getAlbumHeaderCoverRaw(page) {
  return page
    .evaluate(() => {
      const attrs = ["data-src", "data-original", "data-lazy", "src"];
      const pick = (img) => {
        if (!img) return "";
        for (const k of attrs) {
          const v = (img.getAttribute(k) || "").trim();
          if (!v) continue;
          if (v.startsWith("data:")) continue;
          if (v === "about:blank") continue;
          return v;
        }
        return "";
      };

      const img =
        document.querySelector(".showalbumheader__gallerycover img.autocover") ||
        document.querySelector(".showalbumheader__gallerycover img") ||
        null;

      return pick(img);
    })
    .catch(() => "");
}

function pickBestInternalCoverBig(imagesBig, headerCoverRaw) {
  const headerCover = toHttpsUrl(headerCoverRaw);
  const key = yupooImageKey(headerCover);

  let matched = false;
  let picked = "";

  if (key) {
    picked = imagesBig.find((u) => yupooImageKey(u) === key) || "";
    matched = !!picked;
  }
  if (!picked && headerCover) picked = toBigYupooPhotoUrl(headerCover);

  return { picked, key, matched, headerCover };
}

// =====================================================
// PRODUCT TYPE / CATEGORY (Expanded Fashion Taxonomy)
// =====================================================
const CATEGORY_ALIASES = {
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

  HOODIE: "HOODIES",
  HOODIES: "HOODIES",
  SWEATSHIRT: "SWEATSHIRTS",
  SWEATSHIRTS: "SWEATSHIRTS",
  CREWNECK: "SWEATSHIRTS",

  PANT: "PANTS",
  PANTS: "PANTS",
  TROUSERS: "PANTS",
  JOGGER: "JOGGERS",
  JOGGERS: "JOGGERS",
  SWEATPANTS: "SWEATPANTS",

  JEAN: "JEANS",
  JEANS: "JEANS",
  DENIM: "JEANS",

  SNEAKER: "SNEAKERS",
  SNEAKERS: "SNEAKERS",
  SHOE: "SHOES",
  SHOES: "SHOES",
  BOOT: "BOOTS",
  BOOTS: "BOOTS",
  SANDAL: "SANDALS",
  SANDALS: "SANDALS",

  BAG: "BAGS",
  BAGS: "BAGS",
  BACKPACK: "BACKPACKS",
  BACKPACKS: "BACKPACKS",
  WALLET: "WALLETS",
  WALLETS: "WALLETS",
  CARDHOLDER: "CARDHOLDERS",
  CARDHOLDERS: "CARDHOLDERS",

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

  DRESS: "DRESSES",
  DRESSES: "DRESSES",
  SKIRT: "SKIRTS",
  SKIRTS: "SKIRTS",

  PERFUME: "FRAGRANCES",
  PERFUMES: "FRAGRANCES",
  FRAGRANCE: "FRAGRANCES",
  FRAGRANCES: "FRAGRANCES",
};

function canonicalizeCategory(raw) {
  let s = String(raw || "").trim().toUpperCase();
  if (!s) return "";
  s = s.replace(/\s+/g, "_").replace(/[^A-Z0-9_/-]/g, "");
  s = s.replace(/-/g, "_");
  s = CATEGORY_ALIASES[s] || s;
  return s;
}

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

function normalizeBrandForCompare(b) {
  return String(b || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[^a-z0-9 ]+/g, "");
}

function removeRedundantBrandPrefix(shoeName, brandHint) {
  const name = String(shoeName || "").trim();
  if (!name) return "";

  const b = String(brandHint || "").trim();
  if (!b) return name;

  const nb = normalizeBrandForCompare(b);
  const nn = normalizeBrandForCompare(name);

  if (!nb || !nn) return name;

  if (nn.startsWith(nb + " ")) return name;
  if (nn.includes(nb + " ")) return name;

  return name;
}

function titleHasBrand(title, brandHint) {
  const t = normalizeBrandForCompare(title);
  const b = normalizeBrandForCompare(brandHint);
  if (!t || !b) return false;
  return t.includes(b);
}

function maybePrefixBrand(title, brandHint) {
  const t = String(title || "").trim();
  const b = String(brandHint || "").trim();
  if (!t) return t;
  if (!b) return t;
  if (titleHasBrand(t, b)) return t;
  return `${b.toUpperCase()} ${t}`.trim();
}

async function aiDetectFootwearNameFromCover(context, coverUrl, brandHint, titleRaw, bodyText, refererUrl = "", opts = {}) {
  const aiEnabled = !!opts.aiEnabled;
  const shoeEnabled = !!opts.shoeNameEnabled;

  if (!aiEnabled || !openai) return "";
  if (!shoeEnabled) return "";

  const cover = String(coverUrl || "").trim();
  if (!cover) return "";

  const cacheKey = `shoeName::${yupooImageKey(cover) || cover}`;
  if (_aiCache.has(cacheKey)) return _aiCache.get(cacheKey) || "";

  const prompt = `
Return ONLY valid JSON: {"name":"", "confidence":0}

GOAL:
- Detect the shoe model / collaboration from the IMAGE when possible.
- Keep it concise (max ~60 chars). No sizes, no price.

RULES:
- If NOT sure, return {"name":"", "confidence":0}
- confidence MUST be a number 0..1
- Avoid repeating the brand if it's the same as BRAND_HINT.

BRAND_HINT: ${String(brandHint || "").slice(0, 80)}
TITLE_HINT: ${String(titleRaw || "").slice(0, 180)}
BODY_HINT: ${String(bodyText || "").slice(0, 240)}
`.trim();

  try {
    const dataUri = await fetchImageAsDataUri(context, cover, { referer: refererUrl });

    const resp = await openai.responses.create({
      model: SCRAPER_DETECT_MODEL,
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: prompt },
            { type: "input_image", image_url: dataUri, detail: SCRAPER_DETECT_IMAGE_DETAIL },
          ],
        },
      ],
      max_output_tokens: Math.min(140, SCRAPER_DETECT_MAX_OUTPUT_TOKENS),
    });

    const outText = resp.output_text || "";
    const obj = safeJsonExtractObj(outText) || {};

    const name = String(obj.name || "").trim();
    const conf = Number(obj.confidence);

    const ok = name && Number.isFinite(conf) && conf >= 0.6;

    const finalName = ok ? name : "";
    setAiCache(cacheKey, finalName);
    return finalName;
  } catch (e) {
    setAiCache(cacheKey, "");
    logAiDebug("shoeName detect failed", String(e?.message || e));
    return "";
  }
}

function detectProductTypeFromTitle(titleRaw) {
  const t = normalizeForMatch(titleRaw);

  const rules = [
    { type: "FRAGRANCES", re: /\bperfume\b|\bparfum\b|\bfragrance\b|\bcologne\b|\beau de\b|\bprofumo\b/ },

    { type: "HOODIES", re: /\bhoodie(s)?\b|\bhooded\b|\bfelpa con cappuccio\b|\bfelpa hoodie\b|\b卫衣\b/ },
    { type: "SWEATSHIRTS", re: /\bsweatshirt(s)?\b|\bcrewneck\b|\bgirocollo\b|\bfelpa\b/ },
    { type: "SWEATPANTS", re: /\bsweatpants\b|\bpantaloni tuta\b|\bjogger pants\b/ },
    { type: "JOGGERS", re: /\bjoggers?\b|\bpantaloni jogger\b/ },

    { type: "TSHIRTS", re: /\bt\s*-\s*shirt\b|\bt\s*shirt\b|\btshirt\b|\btee\b|\bmaglietta\b|\btee\s*shirt\b|\b短袖\b/ },
    { type: "LONGSLEEVES", re: /\blong\s*sleeve\b|\b长袖\b/ },
    { type: "SHIRTS", re: /\bshirt(s)?\b|\bbutton\s*up\b|\bcamicia\b/ },
    { type: "POLOS", re: /\bpolo(s)?\b/ },

    { type: "JEANS", re: /\bjeans\b|\bdenim\b|\bjean\b|\b牛仔\b/ },
    { type: "SHORTS", re: /\bshort(s)?\b|\bbermuda\b/ },
    { type: "PANTS", re: /\btrousers?\b|\bpants\b|\bpantaloni\b|\b裤\b/ },

    { type: "JACKETS", re: /\bjacket(s)?\b|\bgiacca\b|\b外套\b/ },
    { type: "PUFFERS", re: /\bpuffer\b|\bdown\s*jacket\b|\bpiumino\b/ },
    { type: "COATS", re: /\bcoat(s)?\b|\bcappotto\b/ },

    { type: "SLIDES", re: /\bslides?\b|\bciabatt(e|a)\b/ },
    { type: "SANDALS", re: /\bsandals?\b|\bflip\s*flops?\b/ },
    { type: "SNEAKERS", re: /\bsneakers?\b|\btrainers?\b|\bscarpe da ginnastica\b|\b运动鞋\b/ },
    { type: "BOOTS", re: /\bboots?\b|\bstivali\b/ },
    { type: "SHOES", re: /\bshoes?\b|\bscarpe\b|\b皮鞋\b/ },

    { type: "BAGS", re: /\bbag(s)?\b|\bborsa\b|\b包\b/ },
    { type: "WALLETS", re: /\bwallet(s)?\b|\bportafoglio\b/ },
    { type: "BELTS", re: /\bbelt(s)?\b|\bcintura\b/ },

    { type: "HATS", re: /\bhat(s)?\b|\bcappello\b/ },
    { type: "CAPS", re: /\bcap(s)?\b|\bbaseball\s*cap\b/ },
    { type: "BEANIES", re: /\bbeanie(s)?\b|\bberretto\b/ },

    { type: "SUNGLASSES", re: /\bsunglass(es)?\b|\bshades\b|\bocchiali da sole\b/ },
    { type: "WATCHES", re: /\bwatch(es)?\b|\borologio\b/ },
  ];

  for (const r of rules) {
    if (r.re.test(t)) return r.type;
  }
  return "OTHER";
}

function buildDisplayName(titleRaw, brandOverride = "", forcedType = "") {
  const brand = String(brandOverride || "").trim();
  const forced = canonicalizeCategory(forcedType);

  const detected = detectProductTypeFromTitle(titleRaw);
  const finalType = forced && ALLOWED_TYPES.has(forced) ? forced : detected;

  const tr = String(titleRaw || "").trim();
  const noUsefulText = tr.length < 3;

  if (brand && finalType && finalType !== "OTHER") return `${brand.toUpperCase()} ${finalType}`;
  if (brand && (finalType === "OTHER" || noUsefulText)) return brand.toUpperCase();
  if (brand) return brand.toUpperCase();
  return tr || "Item";
}

// =====================================================
// UNIQUE NAME (colonna C) per seller
// =====================================================
function splitBaseAndIndex(name) {
  const n = String(name || "").trim();
  if (!n) return { base: "", idx: 0 };

  let m = n.match(/^(.*)\s+\((\d+)\)$/);
  if (m) {
    const base = String(m[1] || "").trim();
    const idx = Number(m[2] || "1");
    return { base: base || n, idx: Number.isFinite(idx) ? idx : 1 };
  }

  m = n.match(/^(.*?)(?:\s+(\d+))$/);
  if (m) {
    const base = String(m[1] || "").trim();
    const idx = Number(m[2] || "1");
    return { base: base || n, idx: Number.isFinite(idx) ? idx : 1 };
  }

  return { base: n, idx: 1 };
}

function makeUniqueNameForSeller(baseName, seller, countersMap) {
  const base = String(baseName || "").trim();
  if (!base) return base;

  const s = String(seller || "").trim().toLowerCase();
  const key = s ? `${base}||${s}` : base;

  const currentMax = countersMap.get(key) || 0;
  const next = currentMax + 1;

  countersMap.set(key, next);
  return next === 1 ? base : `${base} (${next})`;
}

function makeUniqueSlug(slugBase, fallbackId, existingSlugs) {
  let s = String(slugBase || "").trim();
  if (!s) s = fallbackId ? `album-${fallbackId}` : `album-${Date.now()}`;

  if (!existingSlugs.has(s)) return s;

  if (fallbackId) {
    const withId = `${s}-${fallbackId}`;
    if (!existingSlugs.has(withId)) return withId;
  }

  let n = 2;
  while (existingSlugs.has(`${s}-${n}`)) n++;
  return `${s}-${n}`;
}

// =====================================================
// Price
// =====================================================
function parseCnyFromText(text) {
  const t = String(text ?? "");
  if (!t.trim()) return null;

  const patterns = [
    /(?:¥|￥)\s*~?\s*(\d+(?:\.\d+)?)/g,
    /(?:CNY|RMB)\s*~?\s*(\d+(?:\.\d+)?)/gi,
    /(\d+(?:\.\d+)?)\s*元/g,
    /\b(\d+(?:\.\d+)?)\s*Y\b/gi,
  ];

  let candidates = [];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(t)) !== null) {
      const n = Number(m[1]);
      if (Number.isFinite(n)) candidates.push(n);
      if (candidates.length >= 10) break;
    }
    if (candidates.length) break;
  }

  candidates = candidates.filter((n) => n > 0 && n < 10000);
  return candidates.length ? candidates[0] : null;
}

// =====================================================
// GOOGLE SHEETS
// =====================================================
function getSheetsClient() {
  const credentials = JSON.parse(fs.readFileSync(absCredPath, "utf-8"));
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  return google.sheets({ version: "v4", auth });
}

function padToLen(arr, len) {
  const out = Array.isArray(arr) ? [...arr] : [];
  while (out.length < len) out.push("");
  return out.slice(0, len);
}

async function getIdRowCount(sheets) {
  const range = `${sheetA1Tab(SHEET_TAB)}!A2:A`;
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range });
  const values = res.data.values || [];
  return values.length;
}

async function loadExistingIndex(sheets) {
  const count = await getIdRowCount(sheets);
  if (count <= 0) {
    return { existingSlugs: new Set(), nameCounters: new Map(), byKey: new Map(), nextAppendRow: 2 };
  }

  const lastRow = count + 1;
  const range = `${sheetA1Tab(SHEET_TAB)}!A2:T${lastRow}`;
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range });
  const values = res.data.values || [];

  const existingSlugs = new Set();
  const nameCounters = new Map();
  const byKey = new Map();

  for (let i = 0; i < values.length; i++) {
    const rowNumber = 2 + i;
    const row = padToLen(values[i], 20);

    const slug = String(row[1] || "").trim();
    if (slug) existingSlugs.add(slug);

    const title = String(row[2] || "").trim();
    const seller = String(row[5] || "").trim().toLowerCase();
    if (title) {
      const { base, idx } = splitBaseAndIndex(title);
      const k = seller ? `${base}||${seller}` : base;
      const prev = nameCounters.get(k) || 0;
      nameCounters.set(k, Math.max(prev, idx));
    }

    const yupooUrl = String(row[16] || "").trim();
    const key = yupooUrl ? `${seller}||${normalizeAlbumUrl(yupooUrl)}` : "";
    if (key) byKey.set(key, { rowNumber, rowValues: row });
  }

  return { existingSlugs, nameCounters, byKey, nextAppendRow: count + 2 };
}

async function writeRowsInBatches_ByExplicitRow(sheets, rows, startRow, batchSize = 50) {
  if (!rows.length) return startRow;

  const batches = Math.ceil(rows.length / batchSize);
  console.log(`\n🧾 WRITE su Sheet in ${batches} batch (size=${batchSize}) a partire da riga ${startRow}...`);

  let cur = startRow;

  for (let i = 0; i < batches; i++) {
    const slice = rows.slice(i * batchSize, (i + 1) * batchSize);
    const endRow = cur + slice.length - 1;
    const range = `${sheetA1Tab(SHEET_TAB)}!A${cur}:T${endRow}`;

    let attempt = 0;
    while (true) {
      try {
        await sheets.spreadsheets.values.update({
          spreadsheetId: SHEET_ID,
          range,
          valueInputOption: "RAW",
          requestBody: { values: slice },
        });
        console.log(`✅ WRITE Batch ${i + 1}/${batches} (${slice.length} righe) -> ${range}`);
        break;
      } catch (err) {
        attempt++;
        const msg = String(err?.message || err);
        if (msg.includes("Quota exceeded") && attempt <= 6) {
          const wait = 15000 * attempt;
          console.log(`⏳ Quota exceeded... retry tra ${wait / 1000}s (tentativo ${attempt}/6)`);
          await sleep(wait);
          continue;
        }
        throw err;
      }
    }

    cur = endRow + 1;
    await sleep(200);
  }

  return cur;
}

async function batchUpdateRows(sheets, updates, batchSize = 50) {
  if (!updates.length) return;

  const batches = Math.ceil(updates.length / batchSize);
  console.log(`\n🧾 UPDATE su Sheet in ${batches} batch (size=${batchSize})...`);

  for (let i = 0; i < batches; i++) {
    const slice = updates.slice(i * batchSize, (i + 1) * batchSize);

    let attempt = 0;
    while (true) {
      try {
        await sheets.spreadsheets.values.batchUpdate({
          spreadsheetId: SHEET_ID,
          requestBody: { valueInputOption: "RAW", data: slice },
        });
        console.log(`✅ UPDATE Batch ${i + 1}/${batches} (${slice.length} righe)`);
        break;
      } catch (err) {
        attempt++;
        const msg = String(err?.message || err);
        if (msg.includes("Quota exceeded") && attempt <= 6) {
          const wait = 15000 * attempt;
          console.log(`⏳ Quota exceeded... retry tra ${wait / 1000}s (tentativo ${attempt}/6)`);
          await sleep(wait);
          continue;
        }
        throw err;
      }
    }
    await sleep(200);
  }
}

// =====================================================
// DETECT TOTAL PAGES (supports Page10of10)
// =====================================================
async function detectCategoryTotalPages(page) {
  return page.evaluate(() => {
    const nums = [];
    const addNum = (n) => {
      const v = parseInt(String(n || ""), 10);
      if (Number.isFinite(v) && v > 0) nums.push(v);
    };

    const root =
      document.querySelector("nav.pagination_main") ||
      document.querySelector(".pagination_main") ||
      document.querySelector(".pagination__buttons") ||
      document.querySelector(".none_select.pagination__buttons") ||
      document.body;

    root.querySelectorAll("a").forEach((a) => {
      const t = (a.textContent || "").trim();
      if (t) addNum(t);

      const href = (a.getAttribute("href") || "").trim();
      const m = href.match(/(?:\?|&)page\s*=\s*(\d+)/i);
      if (m) addNum(m[1]);
    });

    const bodyText = (document.body?.innerText || document.body?.textContent || "").trim();
    const oneSpace = bodyText.replace(/\s+/g, " ").trim();
    const noSpace = bodyText.replace(/\s+/g, "").trim();

    const patterns = [
      /共\s*(\d+)\s*页/i,
      /page\s*\d+\s*of\s*(\d+)/i,
      /page\s*\d+\s*\/\s*(\d+)/i,
      /of\s*(\d+)\s*pages?/i,
    ];
    const patternsNoSpace = [
      /page\d+of(\d+)/i,
      /page\d+\/(\d+)/i,
      /of(\d+)pages?/i,
      /共(\d+)页/i,
    ];

    for (const re of patterns) {
      const m = oneSpace.match(re);
      if (m && m[1]) addNum(m[1]);
    }
    for (const re of patternsNoSpace) {
      const m = noSpace.match(re);
      if (m && m[1]) addNum(m[1]);
    }

    const jump = document.querySelector(".pagination__jumpwrap")?.textContent || "";
    const jump1 = jump.replace(/\s+/g, " ").trim();
    const jump0 = jump.replace(/\s+/g, "").trim();

    for (const re of patterns) {
      const m = jump1.match(re);
      if (m && m[1]) addNum(m[1]);
    }
    for (const re of patternsNoSpace) {
      const m = jump0.match(re);
      if (m && m[1]) addNum(m[1]);
    }

    const max = nums.length ? Math.max(...nums.filter((x) => Number.isFinite(x))) : 1;
    return max > 0 ? max : 1;
  });
}

// =====================================================
// NEXT PAGE (arrow) for block pagination
// =====================================================
async function getNextPageNumberFromDom(page) {
  return page.evaluate(() => {
    const pickNextAnchor = () => {
      const roots = [
        document.querySelector(".pagination__buttons"),
        document.querySelector(".none_select.pagination__buttons"),
        document.querySelector("nav.pagination_main"),
        document.querySelector(".pagination_main"),
        document.body,
      ].filter(Boolean);

      const all = [];
      for (const r of roots) all.push(...Array.from(r.querySelectorAll("a")));

      const isDisabled = (a) => {
        const cls = (a.getAttribute("class") || "").toLowerCase();
        const title = (a.getAttribute("title") || "").toLowerCase();
        const ariaDisabled = (a.getAttribute("aria-disabled") || "").toLowerCase();
        return (
          cls.includes("disabled") ||
          cls.includes("pagination__disabled") ||
          title.includes("disabled") ||
          ariaDisabled === "true"
        );
      };

      const looksLikeNext = (a) => {
        const title = (a.getAttribute("title") || "").toLowerCase();
        if (title.includes("后一页") || title.includes("next")) return true;
        if (a.querySelector("i.icon_next, .icon_next")) return true;
        const cls = (a.getAttribute("class") || "").toLowerCase();
        if (cls.includes("icon_next")) return true;
        return false;
      };

      for (const a of all) {
        if (!looksLikeNext(a)) continue;
        if (isDisabled(a)) continue;
        const href = (a.getAttribute("href") || "").trim();
        if (!href) continue;
        return href;
      }
      return "";
    };

    const href = pickNextAnchor();
    if (!href) return 0;

    const m = href.match(/(?:\?|&)page\s*=\s*(\d+)/i);
    if (m && m[1]) {
      const n = parseInt(m[1], 10);
      return Number.isFinite(n) ? n : 0;
    }
    return 0;
  });
}

// =====================================================
// SCRAPE: CATEGORY (auto pages via NEXT)
// =====================================================
async function scrapeCategory(context, categoryUrl, maxPagesCap = 0, storageAbsForRescue = "", primeUrlForRescue = "") {
  const page = await context.newPage();
  const albumUrls = new Set();
  const coverByAlbum = new Map();

  let pagesDetected = 1;
  let pagesVisited = 0;
  let stoppedEarly = false;

  function normalizeCap(n) {
    const v = Number(n || 0);
    return Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
  }

  async function collectAlbumCardsFast() {
    const found = await page.evaluate(() => {
      const anchors = Array.from(
        document.querySelectorAll('a.album__main[href*="/albums/"], a[href*="/albums/"]')
      );

      const pickFromAttrs = (el) => {
        if (!el) return "";
        const attrs = ["src", "data-src", "data-original", "data-lazy", "data-lazy-src"];
        for (const k of attrs) {
          const v = (el.getAttribute(k) || "").trim();
          if (!v) continue;
          if (v.startsWith("data:")) continue;
          if (v === "about:blank") continue;
          return v;
        }
        return "";
      };

      const pickImgUrlFromAnchor = (a) => {
        const img =
          a.querySelector("img.autocover") ||
          a.querySelector('img[class*="autocover"]') ||
          a.querySelector("img.album__img") ||
          a.querySelector("img");
        let raw = pickFromAttrs(img);

        if (!raw) {
          const bgEl = a.querySelector('[style*="background-image"]');
          const style = (bgEl?.getAttribute("style") || "").trim();
          const m = style.match(/background-image\s*:\s*url\(["']?([^"')]+)["']?\)/i);
          if (m && m[1]) raw = m[1].trim();
        }

        return raw;
      };

      const out = [];
      for (const a of anchors) {
        const href = (a.getAttribute("href") || "").trim();
        if (!href.includes("/albums/")) continue;

        const rawImg = pickImgUrlFromAnchor(a);

        let hrefAbs = "";
        let imgAbs = "";
        try { hrefAbs = new URL(href, location.href).toString(); } catch {}
        if (rawImg) {
          try { imgAbs = new URL(rawImg, location.href).toString(); } catch {}
        }

        if (hrefAbs) out.push({ hrefAbs, imgAbs });
      }

      return out;
    });

    const before = albumUrls.size;

    for (const it of found) {
      const hrefAbs = String(it?.hrefAbs || "").trim();
      if (!hrefAbs) continue;

      const normAlbum = normalizeAlbumUrl(hrefAbs);
      albumUrls.add(normAlbum);

      const imgAbs = String(it?.imgAbs || "").trim();
      if (imgAbs && !coverByAlbum.has(normAlbum)) coverByAlbum.set(normAlbum, toHttpsUrl(imgAbs));
    }

    const after = albumUrls.size;
    return { foundCount: found.length, newCount: after - before };
  }

  async function collectWithRetryIfEmpty() {
    let c = await collectAlbumCardsFast();
    if (c.foundCount > 0) return c;

    await page.waitForTimeout(550);
    await fastScroll(page);
    c = await collectAlbumCardsFast();
    return c;
  }

  try {
    const cap = normalizeCap(maxPagesCap);

    const u1 = new URL(categoryUrl);
    u1.searchParams.set("page", "1");

    console.log(`\n📄 Pagina categoria 1: ${u1.toString()}`);
    try {
      await safeGoto(page, u1.toString(), { retries: 2, timeout: NAV_TIMEOUT });
    } catch (e) {
      const msg = String(e?.message || e);
      if (msg.toLowerCase().includes("restricted") && storageAbsForRescue) {
        await rescueIfRestricted(context, storageAbsForRescue, primeUrlForRescue || categoryUrl);
        await safeGoto(page, u1.toString(), { retries: 1, timeout: NAV_TIMEOUT });
      } else throw e;
    }

    await page.waitForSelector('a[href*="/albums/"]', { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(300);

    pagesDetected = await detectCategoryTotalPages(page);
    console.log(`📚 Pagine totali (best-effort detector): ${pagesDetected}${cap ? ` | cap maxPages=${cap}` : ""}`);

    pagesVisited = 1;
    let current = 1;

    const c1 = await collectWithRetryIfEmpty();
    console.log(`📦 Album trovati finora: ${albumUrls.size} (page1 found=${c1.foundCount}, new=${c1.newCount})`);

    let safety = 0;
    while (true) {
      if (cap && current >= cap) break;

      const detHere = await detectCategoryTotalPages(page).catch(() => 1);
      pagesDetected = Math.max(pagesDetected, detHere, current);

      const nextPage = await getNextPageNumberFromDom(page).catch(() => 0);
      if (!nextPage || nextPage <= current) break;

      const u = new URL(categoryUrl);
      u.searchParams.set("page", String(nextPage));

      console.log(`\n📄 Pagina categoria ${nextPage}: ${u.toString()}`);

      try {
        await safeGoto(page, u.toString(), { retries: 2, timeout: NAV_TIMEOUT });
      } catch (e) {
        const msg = String(e?.message || e);
        if (msg.toLowerCase().includes("restricted") && storageAbsForRescue) {
          await rescueIfRestricted(context, storageAbsForRescue, primeUrlForRescue || categoryUrl);
          await safeGoto(page, u.toString(), { retries: 1, timeout: NAV_TIMEOUT });
        } else throw e;
      }

      await page.waitForSelector('a[href*="/albums/"]', { timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(220);

      current = nextPage;
      pagesVisited = current;

      const c = await collectWithRetryIfEmpty();
      console.log(`📦 Album trovati finora: ${albumUrls.size} (found=${c.foundCount}, new=${c.newCount})`);

      if (c.foundCount === 0) {
        stoppedEarly = true;
        console.log(`🛑 STOP: nessun album trovato a page=${current} (anche dopo retry+scroll).`);
        break;
      }

      safety++;
      if (safety > 300) {
        stoppedEarly = true;
        console.log("🛑 STOP: safety limit (300 pagine) raggiunto.");
        break;
      }
    }

    const detEnd = await detectCategoryTotalPages(page).catch(() => 1);
    pagesDetected = Math.max(pagesDetected, detEnd, pagesVisited);

    console.log(`\n📌 CATEGORY DONE | pagesVisited=${pagesVisited} | pagesDetected(best)=${pagesDetected}${stoppedEarly ? " | STOP-EARLY" : ""}`);
  } finally {
    await page.close();
  }

  return {
    albumUrls: Array.from(albumUrls),
    coverByAlbum,
    pagesDetected,
    pagesVisited,
    stoppedEarly,
  };
}

// =====================================================
// SCRAPE: ALBUM (REUSABLE PAGE)
// =====================================================
async function getAlbumTitle(page) {
  await page
    .waitForFunction(
      () => {
        const el = document.querySelector(".showalbumheader__gallerytitle");
        if (!el) return false;
        const t = (el.getAttribute("data-name") || el.textContent || "").trim();
        return t.length > 0;
      },
      { timeout: 12000 }
    )
    .catch(() => {});

  const title = await page.evaluate(() => {
    const el = document.querySelector(".showalbumheader__gallerytitle");
    if (el) {
      const t = (el.getAttribute("data-name") || el.textContent || "").trim();
      if (t) return t;
    }
    const og = document.querySelector('meta[property="og:title"]');
    if (og && og.getAttribute("content")) return og.getAttribute("content").trim();
    const h1 = document.querySelector("h1");
    if (h1 && h1.textContent) return h1.textContent.trim();
    return "";
  });

  return String(title || "").replace(/\s+/g, " ").trim();
}

function reorderImagesForImg1(images, img1Pick) {
  const list = Array.isArray(images) ? [...images] : [];
  const pick = Number(img1Pick || 0);

  if (!list.length) return list;
  if (!Number.isFinite(pick) || pick <= 0) return list;

  const idx = pick - 1;
  if (idx < 0 || idx >= list.length) return list;

  const chosen = list[idx];
  const rest = list.filter((_, i) => i !== idx);
  return [chosen, ...rest];
}

function reorderImagesCoverFirst(images, coverUrl) {
  const list = Array.isArray(images) ? [...images] : [];
  const cover = String(coverUrl || "").trim();

  if (!cover) return list;
  if (!list.length) return list;

  let idx = list.indexOf(cover);
  if (idx < 0) {
    const key = yupooImageKey(cover);
    if (key) idx = list.findIndex((u) => yupooImageKey(u) === key);
  }

  if (idx < 0) return list;

  const chosen = list[idx];
  const rest = list.filter((_, i) => i !== idx);
  return [chosen, ...rest];
}

function buildOrderedImages(images, img1Pick, coverUrl) {
  if (Number(img1Pick || 0) > 0) return reorderImagesForImg1(images, img1Pick);
  return reorderImagesCoverFirst(images, coverUrl);
}

// ✅ AI detect brand+category da img1 (per-job aware)
async function aiDetectBrandCategoryFromCover(context, coverUrl, titleRaw, bodyText, refererUrl = "", opts = {}) {
  const aiEnabled = !!opts.aiEnabled;
  if (!aiEnabled || !openai) return { brand: "", category: "OTHER" };

  const cover = String(coverUrl || "").trim();
  if (!cover) return { brand: "", category: "OTHER" };

  const cacheKey = `bc::${yupooImageKey(cover) || cover}`;
  if (_aiCache.has(cacheKey)) return _aiCache.get(cacheKey);

  const allowed = Array.from(ALLOWED_TYPES).join(", ");

  const prompt = `
Return ONLY valid JSON: {"brand":"", "category":""}

CATEGORY RULES:
- category MUST be exactly one of: ${allowed}
- category MUST NEVER be empty. If unsure -> "OTHER".
- Use the IMAGE as primary signal. Title/body are secondary hints.

BRAND RULES:
- brand: uppercase brand if clearly visible (logo/text), else "".

TITLE: ${String(titleRaw || "").slice(0, 280)}
BODY: ${String(bodyText || "").slice(0, 500)}
`.trim();

  let lastErr = null;

  for (let attempt = 1; attempt <= Math.max(1, SCRAPER_DETECT_RETRIES); attempt++) {
    try {
      const dataUri = await fetchImageAsDataUri(context, cover, { referer: refererUrl });

      const resp = await openai.responses.create({
        model: SCRAPER_DETECT_MODEL,
        input: [
          {
            role: "user",
            content: [
              { type: "input_text", text: prompt },
              { type: "input_image", image_url: dataUri, detail: SCRAPER_DETECT_IMAGE_DETAIL },
            ],
          },
        ],
        max_output_tokens: SCRAPER_DETECT_MAX_OUTPUT_TOKENS,
      });

      const outText = resp.output_text || "";
      const obj = safeJsonExtract(outText) || {};

      let brand = String(obj.brand || "").trim().toUpperCase();
      let category = canonicalizeCategory(obj.category || "");

      if (!category) category = "OTHER";
      if (!ALLOWED_TYPES.has(category)) category = "OTHER";

      const result = { brand, category };
      setAiCache(cacheKey, result);
      return result;
    } catch (e) {
      lastErr = e;
      logAiDebug(`aiDetect attempt ${attempt} failed`, String(e?.message || e));
      await sleep(500 * attempt);
    }
  }

  logAiDebug("aiDetect final fail", String(lastErr?.message || lastErr));
  const result = { brand: "", category: "OTHER" };
  setAiCache(cacheKey, result);
  return result;
}

async function scrapeAlbumOnPage(
  page,
  context,
  albumUrl,
  categoryOverride,
  seller,
  brand,
  img1Pick,
  coverUrlFromCategory,
  storageAbsForRescue = "",
  primeUrlForRescue = "",
  jobOptions = {}
) {
  // per-job overrides
  const titleForced = String(jobOptions.title || "").trim();
  const titleMode = normalizeTitleMode(jobOptions.titleMode, titleForced);

  const aiEnabled = isAiEnabledForJob(jobOptions.ai);
  const shoeNameEnabled = isShoeNameEnabledForJob(jobOptions.shoeName, aiEnabled);

  async function extractAlbumPhotosRaw() {
    return page.evaluate(() => {
      const attrs = ["data-src", "data-origin-src", "data-original", "data-lazy", "data-lazy-src", "src"];

      const normalize = (raw) => {
        const r = (raw || "").toString().trim();
        if (!r) return "";
        if (r === "about:blank") return "";
        if (r.startsWith("data:")) return "";

        if (r.startsWith("//")) return `https:${r}`;
        if (r.startsWith("/photo.yupoo.com/")) return `https://${r.slice(1)}`;
        if (r.startsWith("/")) return `https://photo.yupoo.com${r}`;

        try { return new URL(r, location.href).toString(); } catch { return ""; }
      };

      const out = [];
      const seen = new Set();
      const add = (raw) => {
        const u = normalize(raw);
        if (!u) return;
        if (!u.includes("photo.yupoo.com")) return;
        if (seen.has(u)) return;
        seen.add(u);
        out.push(u);
      };

      const ogImg = document.querySelector('meta[property="og:image"]')?.getAttribute("content") || "";
      add(ogImg);

      const imgs = Array.from(document.querySelectorAll("img"));
      for (const img of imgs) {
        for (const k of attrs) add(img.getAttribute(k) || "");
        const p = (img.getAttribute("data-path") || "").trim();
        if (p) add(p);
      }

      return out;
    });
  }

  const normAlbumUrl = normalizeAlbumUrl(albumUrl);

  try {
    try {
      await safeGoto(page, normAlbumUrl, { retries: 2, timeout: NAV_TIMEOUT });
    } catch (e) {
      const msg = String(e?.message || e);
      if (msg.toLowerCase().includes("restricted") && storageAbsForRescue) {
        await rescueIfRestricted(context, storageAbsForRescue, primeUrlForRescue || normAlbumUrl);
        await safeGoto(page, normAlbumUrl, { retries: 1, timeout: NAV_TIMEOUT });
      } else throw e;
    }

    await page.waitForTimeout(250);

    const headerCoverRaw = await getAlbumHeaderCoverRaw(page);

    let imagesRaw = await extractAlbumPhotosRaw();
    if (headerCoverRaw) {
      const hc = toHttpsUrl(headerCoverRaw);
      if (hc && hc.includes("photo.yupoo.com")) imagesRaw = [hc, ...imagesRaw];
    }

    imagesRaw = dedupePreserveOrder(imagesRaw.map(toHttpsUrl).map(fixPhotoDoubleHost));
    let imagesBig = dedupePreserveOrder(imagesRaw.map(toBigYupooPhotoUrl).map(fixPhotoDoubleHost));

    if (imagesBig.length < 6) {
      await fastScroll(page);
      let imagesRaw2 = await extractAlbumPhotosRaw();
      if (headerCoverRaw) {
        const hc = toHttpsUrl(headerCoverRaw);
        if (hc && hc.includes("photo.yupoo.com")) imagesRaw2 = [hc, ...imagesRaw2];
      }
      imagesRaw2 = dedupePreserveOrder(imagesRaw2.map(toHttpsUrl).map(fixPhotoDoubleHost));
      imagesBig = dedupePreserveOrder(imagesRaw2.map(toBigYupooPhotoUrl).map(fixPhotoDoubleHost));
    }

    const bodyText = await page.evaluate(() => document.body.innerText || "");
    const titleRaw = await getAlbumTitle(page);

    // cover smart
    const internal = pickBestInternalCoverBig(imagesBig, headerCoverRaw);
    const coverSmart =
      internal.picked ||
      pickCoverFromCategory(coverUrlFromCategory) ||
      (imagesBig[0] || "");

    if (DEBUG_COVER && Number(img1Pick || 0) <= 0) {
      console.log(
        `🖼️ COVER DEBUG | album=${extractAlbumId(normAlbumUrl)} | header=${internal.headerCover || "-"} | key=${internal.key || "-"} | matched=${internal.matched ? "YES" : "NO"} | picked=${coverSmart || "-"}`
      );
    }

    // ✅ assicuro che coverSmart sia IN imagesBig
    if (coverSmart) {
      const cKey = yupooImageKey(coverSmart);
      const hasCover = imagesBig.some((u) => {
        if (u === coverSmart) return true;
        if (cKey && yupooImageKey(u) === cKey) return true;
        return false;
      });

      if (!hasCover) {
        imagesBig = [coverSmart, ...imagesBig];
        imagesBig = dedupePreserveOrder(imagesBig);
      }
    }

    // ✅ ordine finale + img1Final
    const orderedImages = dedupePreserveOrder(buildOrderedImages(imagesBig, img1Pick, coverSmart));
    const img1Final = orderedImages[0] || "";

    // ✅ AUTO logic
    const brandRaw = String(brand || "").trim();
    const catRaw = String(categoryOverride || "").trim();

    const wantsAutoBrand = !brandRaw || brandRaw.toUpperCase() === "AUTO";
    const wantsAutoCat = !catRaw || catRaw.toUpperCase() === "AUTO";

    // ✅ 1) Prima detection gratis da titolo
    const detectedType = detectProductTypeFromTitle(titleRaw);

    // ✅ 2) AI SOLO se serve davvero:
    // - brand è AUTO
    // - categoria è AUTO e detectedType === OTHER
    const shouldAiBrand = wantsAutoBrand;
    const shouldAiCat = wantsAutoCat && detectedType === "OTHER";

    let aiBrand = "";
    let aiCat = "";

    if (aiEnabled && (shouldAiBrand || shouldAiCat)) {
      try {
        const ai = await aiDetectBrandCategoryFromCover(
          context,
          img1Final,
          titleRaw,
          bodyText,
          normAlbumUrl,
          { aiEnabled }
        );
        aiBrand = ai.brand || "";
        aiCat = ai.category || "";
        logAiDebug("AI result", { album: extractAlbumId(normAlbumUrl), img1: img1Final, aiBrand, aiCat, detectedType });
      } catch (e) {
        logAiDebug("AI detect crashed", String(e?.message || e));
      }
    } else {
      logAiDebug("AI skipped", { album: extractAlbumId(normAlbumUrl), detectedType, wantsAutoBrand, wantsAutoCat, aiEnabled });
    }

    // 🔒 finalCategory
    let finalCategory;
    if (!wantsAutoCat && catRaw) {
      const forced = canonicalizeCategory(catRaw);
      finalCategory = ALLOWED_TYPES.has(forced) ? forced : "OTHER";
    } else {
      const autoCat = (shouldAiCat ? canonicalizeCategory(aiCat) : "") || detectedType || "OTHER";
      finalCategory = ALLOWED_TYPES.has(autoCat) ? autoCat : "OTHER";
    }

    // ✅ finalBrand
    const finalBrand =
      !wantsAutoBrand && brandRaw
        ? brandRaw
        : (shouldAiBrand ? (aiBrand || "") : "");

    // ✅ TITLE
    let titleBase = "";

    if (titleMode === "FORCE") {
      const brandHint = (String(finalBrand || "").trim() || String(brandRaw || "").trim()).trim();
      titleBase = maybePrefixBrand(titleForced, brandHint);
      if (!titleBase) titleBase = buildDisplayName(titleRaw, finalBrand, finalCategory);
    } else if (titleMode === "ALBUM") {
      titleBase = String(titleRaw || "").trim();
      if (!titleBase) titleBase = buildDisplayName(titleRaw, finalBrand, finalCategory);
    } else {
      if (FOOTWEAR_TYPES.has(finalCategory)) {
        const brandHint = (String(finalBrand || "").trim() || String(brandRaw || "").trim()).trim();

        const shoeNameRaw = await aiDetectFootwearNameFromCover(
          context,
          img1Final,
          brandHint,
          titleRaw,
          bodyText,
          normAlbumUrl,
          { aiEnabled, shoeNameEnabled }
        );

        const shoeName = removeRedundantBrandPrefix(shoeNameRaw, brandHint);

        if (shoeName) {
          const maybePrefixed = shoeName;
          const hasBrandAlready =
            normalizeBrandForCompare(maybePrefixed).includes(normalizeBrandForCompare(brandHint));
          titleBase = (hasBrandAlready || !brandHint)
            ? maybePrefixed.trim()
            : `${brandHint.toUpperCase()} ${maybePrefixed}`.trim();
        } else {
          titleBase = buildDisplayName(titleRaw, finalBrand, finalCategory);
        }
      } else {
        titleBase = buildDisplayName(titleRaw, finalBrand, finalCategory);
      }
    }

    // ✅ SOURCE LINK
    const rawLinks = await page
      .evaluate(() => {
        return Array.from(document.querySelectorAll("a[href]"))
          .map((a) => a.getAttribute("href"))
          .filter(Boolean)
          .map((h) => {
            try { return new URL(h, location.href).toString(); } catch { return null; }
          })
          .filter(Boolean);
      })
      .catch(() => []);

    const externalSourceUrl = await pickPreferredSourceUrl(context, rawLinks);

    let cleanedSource = String(externalSourceUrl || "").trim();
    cleanedSource = decodeYupooExternalUrl(cleanedSource);

    if (cleanedSource && isShortRedirectUrl(cleanedSource)) {
      const resolved = await resolveFinalUrl(context, cleanedSource);
      cleanedSource = resolved || cleanedSource;
    }

    cleanedSource = canonicalizeWeidianItemUrl(cleanedSource);

    let priceCny = parseCnyFromText(titleRaw);
    if (!priceCny) priceCny = parseCnyFromText(bodyText);

    const sellerName = seller || "";
    const source_url = normAlbumUrl;

    const id = buildStableId(sellerName, source_url);
    const slug = buildUniqueSlug(titleBase || titleRaw || "item", sellerName, source_url);

    const img1to8 = orderedImages.slice(0, 8);
    const extra = orderedImages.slice(8);

    const brandCell = String(finalBrand || "").trim();
    const tags = "";

    const row = [
      id, slug, titleBase, brandCell, finalCategory || "OTHER", sellerName,
      img1to8[0] || "", img1to8[1] || "", img1to8[2] || "", img1to8[3] || "",
      img1to8[4] || "", img1to8[5] || "", img1to8[6] || "", img1to8[7] || "",
      extra.length ? extra.join(", ") : "",
      "ok",
      normAlbumUrl,
      cleanedSource || "",
      priceCny ? String(priceCny) : "",
      tags,
    ];

    return row;
  } finally {
    // IMPORTANT: do not close page here (pool reuse)
  }
}

// =====================================================
// JOBS FILE PARSER + CLI PARSER
// =====================================================
function parseJobLine(line) {
  const raw = String(line || "").trim();
  if (!raw) return null;
  if (raw.startsWith("#")) return null;

  const parts = raw.split("|").map((p) => p.trim()).filter(Boolean);
  if (!parts.length) return null;

  const url = parts[0];
  const job = {
    url,
    brand: "",
    seller: "",
    maxPages: 0,
    category: "",
    img1: 0,

    title: "",
    titleMode: "",
    ai: "auto",
    shoeName: "auto",
  };

  for (const p of parts.slice(1)) {
    const [kRaw, ...rest] = p.split("=");
    const k = String(kRaw || "").trim().toLowerCase();
    const v = rest.join("=").trim();

    if (!k) continue;

    if (k === "brand") job.brand = v;
    else if (k === "seller") job.seller = v;
    else if (k === "maxpages") job.maxPages = Number(v || "0") || 0;
    else if (k === "category") job.category = v;
    else if (k === "img1") job.img1 = Number(v || "0") || 0;
    else if (k === "title") job.title = v;
    else if (k === "titlemode") job.titleMode = v;
    else if (k === "ai") job.ai = v;
    else if (k === "shoename") job.shoeName = v;
  }

  job.ai = normTriState(job.ai);
  job.shoeName = normTriState(job.shoeName);
  job.titleMode = normalizeTitleMode(job.titleMode, job.title);

  return job;
}

function loadJobsFromFile(filePath) {
  const abs = path.isAbsolute(filePath) ? filePath : path.join(PROJECT_ROOT, filePath.replace(/^\.\//, ""));
  if (!fs.existsSync(abs)) {
    console.error("❌ Jobs file non trovato:", abs);
    process.exit(1);
  }

  const txt = fs.readFileSync(abs, "utf-8");
  const lines = txt.split(/\r?\n/);

  const jobs = [];
  for (const line of lines) {
    const job = parseJobLine(line);
    if (job) jobs.push(job);
  }
  return jobs;
}

function parseArgs(argv) {
  const args = {
    url: "",
    maxPages: 0,
    category: "",
    seller: "",
    brand: "",
    img1: 0,
    headful: false,
    file: "",
    auth: false,
    storage: "",

    title: "",
    titleMode: "",
    ai: "auto",
    shoeName: "auto",
  };

  const list = [...argv];
  args.url = list[2] && !String(list[2]).startsWith("--") ? list[2] : "";

  for (let i = 2; i < list.length; i++) {
    const a = list[i];
    if (a === "--file") args.file = String(list[++i] || "");
    else if (a === "--maxPages") args.maxPages = Number(list[++i] || "0") || 0;
    else if (a === "--category") args.category = String(list[++i] || "");
    else if (a === "--seller") args.seller = String(list[++i] || "");
    else if (a === "--brand") args.brand = String(list[++i] || "");
    else if (a === "--img1") args.img1 = Number(list[++i] || "0") || 0;
    else if (a === "--headful") args.headful = true;
    else if (a === "--auth") args.auth = true;
    else if (a === "--storage") args.storage = String(list[++i] || "");

    else if (a === "--title") args.title = String(list[++i] || "");
    else if (a === "--titleMode") args.titleMode = String(list[++i] || "");
    else if (a === "--ai") args.ai = String(list[++i] || "auto");
    else if (a === "--shoeName") args.shoeName = String(list[++i] || "auto");
  }

  args.ai = normTriState(args.ai);
  args.shoeName = normTriState(args.shoeName);
  args.titleMode = normalizeTitleMode(args.titleMode, args.title);

  return args;
}

// =====================================================
// MAIN
// =====================================================
async function main() {
  const args = parseArgs(process.argv);
  const jobs = args.file ? loadJobsFromFile(args.file) : null;

  if (!jobs && !args.url && !args.auth) {
    console.log("\n❌ Uso:");
    console.log(`node ./scraper/scrape_yupoo_to_sheet.mjs "<url>" --brand "X" --seller "Y"`);
    console.log(`node ./scraper/scrape_yupoo_to_sheet.mjs --file ./scraper/yupoo_jobs.txt`);
    console.log(`node ./scraper/scrape_yupoo_to_sheet.mjs --auth --storage ./scraper/yupoo_state.json`);
    console.log("\nNEW:");
    console.log(`  --title "VOMERO" --titleMode FORCE|ALBUM|AUTO --ai auto|0|1 --shoeName auto|0|1`);
    process.exit(0);
  }

  const storagePath =
    args.storage ||
    process.env.YUPOO_STORAGE_STATE ||
    "./scraper/yupoo_state.json";

  const storageAbs = absPathFromRoot(storagePath);
  const jobPrimeUrl = (jobs?.[0]?.url || args.url || "https://www.yupoo.com/").trim();
  const headless = !args.headful;

  const checkpoint = loadCheckpoint();
  checkpoint.done = checkpoint.done || {};

  const sheets = getSheetsClient();
  const { existingSlugs, nameCounters, byKey, nextAppendRow: nextAppendRowInit } = await loadExistingIndex(sheets);
  let nextAppendRow = nextAppendRowInit;

  const browser = await chromium.launch({ headless });
  let context = null;

  const global = {
    jobs: 0,
    albumsExtracted: 0,
    albumsOk: 0,
    albumsFail: 0,
    sheetAppend: 0,
    sheetUpdate: 0,
    skippedExisting: 0,
    skippedCheckpoint: 0,
  };

  // Single-writer buffers + locks
  const sheetLock = createMutex();
  const indexLock = createMutex();
  const backoff = createBackoff();

  // ✅ pending buffers now include key
  let pendingAppends = []; // { key, row, doneKey }
  let pendingUpdates = []; // { key, range, values, doneKey }

  // ✅ to update queued-append rows without rowNumber
  const pendingByKey = new Map(); // key -> { kind:"append"|"update", itemRef }

  let flushScheduled = false;

  async function flushToSheet(force = false) {
    // serialize flush calls
    return sheetLock.runExclusive(async () => {
      if (!force) {
        const total = pendingAppends.length + pendingUpdates.length;
        if (total < SCRAPER_FLUSH_EVERY) return;
      }

      if (!pendingAppends.length && !pendingUpdates.length) return;

      const upd = pendingUpdates.splice(0, pendingUpdates.length);
      const app = pendingAppends.splice(0, pendingAppends.length);

      const doneKeys = [];
      for (const u of upd) if (u?.doneKey) doneKeys.push(u.doneKey);
      for (const a of app) if (a?.doneKey) doneKeys.push(a.doneKey);

      try {
        if (upd.length) {
          await batchUpdateRows(sheets, upd.map((x) => ({ range: x.range, values: x.values })), 50);
        }

        if (app.length) {
          const startRow = nextAppendRow;
          const rows = app.map((x) => x.row);

          nextAppendRow = await writeRowsInBatches_ByExplicitRow(sheets, rows, startRow, 50);

          // ✅ now that rowNumbers are known, backfill in byKey
          await indexLock.runExclusive(async () => {
            for (let i = 0; i < app.length; i++) {
              const it = app[i];
              const rowNumber = startRow + i;
              if (!it?.key) continue;
              byKey.set(it.key, { rowNumber, rowValues: padToLen(it.row, 20) });
            }
          });
        }

        // commit checkpoint only after successful sheet write
        if (doneKeys.length) {
          for (const k of doneKeys) checkpoint.done[k] = 1;
          saveCheckpoint(checkpoint);
        }

        // ✅ clear pendingByKey for processed items (prevents growth + stale refs)
        for (const it of upd) if (it?.key) pendingByKey.delete(it.key);
        for (const it of app) if (it?.key) pendingByKey.delete(it.key);

        console.log(`✅ FLUSH OK | updates=${upd.length} appends=${app.length} | nextAppendRow=${nextAppendRow}`);
        backoff.onOk();
      } catch (e) {
        // put back buffers (best effort) to retry later
        for (const x of upd) pendingUpdates.push(x);
        for (const x of app) pendingAppends.push(x);

        const msg = String(e?.message || e);
        console.log("❌ FLUSH FAILED:", msg.split("\n")[0]);
        await backoff.onFail(msg.toLowerCase().includes("quota") ? "net" : "fail");
      }
    });
  }

  async function maybeScheduleFlush() {
    const total = pendingAppends.length + pendingUpdates.length;
    if (total < SCRAPER_FLUSH_EVERY) return;

    if (flushScheduled) return;
    flushScheduled = true;

    try {
      await flushToSheet(false);
    } finally {
      flushScheduled = false;
    }
  }

  // ✅ Graceful shutdown (CTRL+C, kill, crash)
  let shuttingDown = false;
  async function gracefulExit(reason) {
    if (shuttingDown) return;
    shuttingDown = true;

    console.log(`\n🛑 STOP (${reason}) -> flush + save checkpoint/cache...`);
    try { await flushToSheet(true); } catch {}
    try { saveCheckpoint(checkpoint); } catch {}
    try { saveAiDiskCache(aiDisk); } catch {}
    console.log("✅ Stato salvato. Esco.");
    process.exit(0);
  }

  process.on("SIGINT", () => { void gracefulExit("SIGINT"); });
  process.on("SIGTERM", () => { void gracefulExit("SIGTERM"); });
  process.on("uncaughtException", (e) => {
    console.error("❌ uncaughtException:", e);
    void gracefulExit("uncaughtException");
  });
  process.on("unhandledRejection", (e) => {
    console.error("❌ unhandledRejection:", e);
    void gracefulExit("unhandledRejection");
  });

  try {
    if (!fs.existsSync(storageAbs) || args.auth) {
      await ensureAuthStorage(browser, storageAbs, jobPrimeUrl);
    }

    context = await browser.newContext({
      storageState: fs.existsSync(storageAbs) ? storageAbs : undefined,
      userAgent: REAL_UA,
      locale: "it-IT",
      extraHTTPHeaders: { "accept-language": ACCEPT_LANG },
    });

    context.setDefaultNavigationTimeout(NAV_TIMEOUT);

    // 🚫 blocco risorse pesanti: MA consenti immagini se sono NAVIGATION
    context.route("**/*", (route) => {
      try {
        const req = route.request();
        const t = req.resourceType();

        if (t === "image" && req.isNavigationRequest()) return route.continue();

        if (t === "font" || t === "media" || t === "image") return route.abort();
        return route.continue();
      } catch {
        return route.continue();
      }
    });

    if (args.auth && !jobs && !args.url) {
      console.log("\n✅ Auth salvata. Ora puoi lanciare lo scraper con --storage.");
      return;
    }

    const jobList = jobs
      ? jobs
      : [
          {
            url: args.url,
            brand: args.brand,
            seller: args.seller,
            maxPages: Number(args.maxPages || 0) || 0,
            category: args.category,
            img1: Number(args.img1 || 0) || 0,

            title: args.title,
            titleMode: args.titleMode,
            ai: args.ai,
            shoeName: args.shoeName,
          },
        ];

    console.log(`\n🧩 Jobs caricati: ${jobList.length}`);
    if (args.file) console.log(`📄 File jobs: ${args.file}`);
    console.log("🔐 storageState:", storageAbs);

    // MAIN JOB LOOP (jobs sequential, albums concurrent)
    for (let j = 0; j < jobList.length; j++) {
      global.jobs += 1;

      const job = jobList[j];
      const url = String(job.url || "").trim();

      const mode = isCategoryUrl(url) ? "CATEGORY" : isAlbumUrl(url) ? "ALBUM" : "UNKNOWN";
      if (mode === "UNKNOWN") {
        console.log(`\n⚠️ Job ${j + 1}/${jobList.length} URL non valido, skip: ${url}`);
        continue;
      }

      const brand = String(job.brand || "").trim();
      const seller = String(job.seller || "").trim();
      const maxPages = Number(job.maxPages || 0) || 0;
      const categoryOverride = String(job.category || "").trim();
      const img1Pick = Number(job.img1 || 0) || 0;

      const jobOpts = {
        title: String(job.title || "").trim(),
        titleMode: normalizeTitleMode(job.titleMode, job.title),
        ai: normTriState(job.ai),
        shoeName: normTriState(job.shoeName),
      };

      const effAi = isAiEnabledForJob(jobOpts.ai);
      const effShoe = isShoeNameEnabledForJob(jobOpts.shoeName, effAi);

      if (!seller) {
        console.log("❌ ERRORE: seller mancante. Passa --seller o seller= nel jobs file.");
        continue;
      }

      console.log("\n------------------------------------");
      console.log(`🚀 Job ${j + 1}/${jobList.length}`);
      console.log("🔎 Modalità:", mode);
      console.log("🔗 URL:", url);
      console.log("👤 Seller:", seller);
      console.log("🏷️ Brand:", brand || "(AUTO/empty)");
      console.log("📌 Category override:", categoryOverride || "(AUTO/empty)");
      console.log("📄 maxPages:", maxPages ? `${maxPages} (CAP)` : "AUTO (tutte)");
      console.log("🖼️ img1:", img1Pick > 0 ? `MANUAL #${img1Pick}` : "AUTO (cover smart)");
      console.log("🧾 titleMode:", jobOpts.titleMode);
      console.log("🧾 title:", jobOpts.title ? `"${jobOpts.title}"` : "(none)");
      console.log("🤖 ai(job):", jobOpts.ai, "=>", effAi ? "ON" : "OFF");
      console.log("👟 shoeName(job):", jobOpts.shoeName, "=>", effShoe ? "ON" : "OFF");
      console.log("------------------------------------");

      let albumUrls = [];
      let coverByAlbum = new Map();

      if (mode === "CATEGORY") {
        const res = await scrapeCategory(context, url, maxPages, storageAbs, url);
        albumUrls = res.albumUrls;
        coverByAlbum = res.coverByAlbum;

        albumUrls = Array.from(new Set(albumUrls.map(normalizeAlbumUrl)));
        console.log(`\n🧾 Totale prodotti estratti: ${albumUrls.length}`);
        console.log(`🖼️  Cover categoria mappate (best effort): ${coverByAlbum.size}`);
      } else {
        albumUrls = [normalizeAlbumUrl(url)];
        console.log(`\n🧾 Totale prodotti estratti: 1`);
      }

      global.albumsExtracted += albumUrls.length;

      // -------- album concurrency pool --------
      const pages = [];
      for (let k = 0; k < SCRAPER_CONCURRENCY; k++) {
        const p = await context.newPage();
        pages.push(p);
      }

      let nextIndex = 0;

      async function worker(workerId) {
        const page = pages[workerId];
        while (true) {
          const idx = nextIndex++;
          if (idx >= albumUrls.length) break;

          const normUrl = normalizeAlbumUrl(albumUrls[idx]);
          const doneKey = makeDoneKey(seller, normUrl);

          // resume checkpoint skip
          if (SCRAPER_RESUME && checkpoint.done && checkpoint.done[doneKey]) {
            global.skippedCheckpoint += 1;
            continue;
          }

          // pre-open skip existing
          const sellerLower = String(seller).trim().toLowerCase();
          const key = `${sellerLower}||${normUrl}`;
          if (SCRAPER_SKIP_EXISTING && byKey.has(key)) {
            global.skippedExisting += 1;
            continue;
          }

          const coverUrl = coverByAlbum.get(normUrl) || "";

          let row;
          try {
            row = await scrapeAlbumOnPage(
              page,
              context,
              normUrl,
              categoryOverride,
              seller,
              brand,
              img1Pick,
              coverUrl,
              storageAbs,
              url,
              jobOpts
            );
            global.albumsOk += 1;
            backoff.onOk();
          } catch (err) {
            global.albumsFail += 1;
            const msg = String(err?.message || err);
            console.log(`❌ FAIL album: ${normUrl}`);
            console.log(`   -> ${msg.split("\n")[0]}`);
            if (msg.toLowerCase().includes("restricted")) await backoff.onFail("restricted");
            else await backoff.onFail("fail");
            continue;
          }

          // Decide update/append + enforce unique slug/title safely (critical section)
          await indexLock.runExclusive(async () => {
            const yupooUrl = String(row[16] || "").trim();
            const dk = makeDoneKey(seller, yupooUrl || normUrl);

            const existing = byKey.get(key);

            if (existing && existing.rowNumber >= 2) {
              // ✅ UPDATE reale su sheet
              const prev = padToLen(existing.rowValues, 20);
              const idPrev = String(prev[0] || "").trim();
              const slugPrev = String(prev[1] || "").trim();

              const next = padToLen(row, 20);
              if (idPrev) next[0] = idPrev;
              if (slugPrev) next[1] = slugPrev;

              const range = `${sheetA1Tab(SHEET_TAB)}!A${existing.rowNumber}:T${existing.rowNumber}`;
              const updItem = { key, range, values: [next], doneKey: dk };

              pendingUpdates.push(updItem);
              pendingByKey.set(key, { kind: "update", itemRef: updItem });

              byKey.set(key, { rowNumber: existing.rowNumber, rowValues: next });
              global.sheetUpdate += 1;

              console.log(`🔁 UPDATE riga ${existing.rowNumber}: ${next[1]} | "${next[2]}"`);
            } else if (existing && existing.rowNumber < 2) {
              // ✅ ESISTE ma non ancora scritto: è un APPEND in coda → aggiorno la riga in coda
              const entry = pendingByKey.get(key);

              if (entry?.kind === "append" && entry.itemRef?.row) {
                const prevQueued = padToLen(entry.itemRef.row, 20);
                const next = padToLen(row, 20);

                // keep stable id/slug e titolo già “unique”
                next[0] = prevQueued[0];
                next[1] = prevQueued[1];
                if (String(prevQueued[2] || "").trim()) next[2] = prevQueued[2];

                entry.itemRef.row = next;
                byKey.set(key, { rowNumber: -1, rowValues: next });

                console.log(`🧷 UPDATE(queued append): ${next[1]} | "${next[2]}" | CAT="${next[4]}" | BRAND="${next[3]}"`);
              } else {
                console.log(`⚠️ Duplicate album in same run but queued entry not found. Skip: ${key}`);
              }
            } else {
              // ✅ APPEND nuovo
              const next = padToLen(row, 20);

              const rawSlug = String(next[1] || "").trim();
              const rawId = String(next[0] || "").trim();
              const uniqueSlug = makeUniqueSlug(rawSlug, rawId, existingSlugs);
              next[1] = uniqueSlug;
              existingSlugs.add(uniqueSlug);

              next[2] = makeUniqueNameForSeller(next[2], seller, nameCounters);

              const appItem = { key, row: next, doneKey: dk };
              pendingAppends.push(appItem);
              pendingByKey.set(key, { kind: "append", itemRef: appItem });

              byKey.set(key, { rowNumber: -1, rowValues: next });

              global.sheetAppend += 1;
              console.log(`✅ APPEND(queued): ${next[1]} | "${next[2]}" | CAT="${next[4]}" | BRAND="${next[3]}"`);
            }
          });

          await maybeScheduleFlush();
          if (BETWEEN_ALBUMS_SLEEP > 0) await sleep(BETWEEN_ALBUMS_SLEEP);
        }
      }

      // run workers
      const workers = [];
      for (let w = 0; w < pages.length; w++) workers.push(worker(w));
      await Promise.all(workers);

      // close pages
      for (const p of pages) {
        try { await p.close(); } catch {}
      }

      // Force flush at end of job
      await flushToSheet(true);

      console.log("\n================ JOB DONE ================");
      console.log(`Seller: ${seller}`);
      console.log(`URL   : ${url}`);
      console.log(`Album totali: ${albumUrls.length}`);
      console.log("=========================================\n");
    }

    // final flush
    await flushToSheet(true);

    // final save AI cache
    try {
      saveAiDiskCache(aiDisk);
    } catch {}

    console.log("\n✅ FINITO!");
    console.log("\n================ GLOBAL SUMMARY ================");
    console.log(`Jobs totali             : ${global.jobs}`);
    console.log(`Album estratti          : ${global.albumsExtracted}`);
    console.log(`Album processati        : ok=${global.albumsOk} | fail=${global.albumsFail}`);
    console.log(`Sheet                   : append=${global.sheetAppend} | update=${global.sheetUpdate}`);
    console.log(`Skip existing(pre-open) : ${global.skippedExisting}`);
    console.log(`Skip checkpoint(resume) : ${global.skippedCheckpoint}`);
    console.log("===============================================");
  } catch (err) {
    console.error("❌ ERRORE FATALE:", err);
  } finally {
    try { if (context) await context.close(); } catch {}
    try { await browser.close(); } catch {}
  }
}

main();
