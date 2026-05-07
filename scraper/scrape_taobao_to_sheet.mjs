"use strict";

/**
 * Taobao -> Google Sheet Scraper (login required via storageState)
 * Supports:
 *  - Shop listing via MTOP: mtop.taobao.shop.simple.item.fetch
 *  - Single item URL (item.taobao.com/item.htm?id=...)
 *
 * Writes rows to A:T (same format as your Yupoo/1688)
 *
 * SHEET COLUMNS (A..T):
 * A  id
 * B  slug
 * C  title
 * D  brand
 * E  category
 * F  seller
 * G..N img1..img8
 * O  img_extra
 * P  status
 * Q  yupoo_url          (for taobao: store/shop url optional)
 * R  source_url         (IMPORTANT: taobao item url goes here!)
 * S  source_price_cny
 * T  tags
 */

import fs from "fs";
import path from "path";
import crypto from "node:crypto";
import dotenv from "dotenv";
import readline from "node:readline";
import { chromium } from "playwright";
import { google } from "googleapis";
import { fileURLToPath } from "url";

// =====================
// ESM __dirname + root
// =====================
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, "..");

// =====================
// DOTENV
// =====================
dotenv.config({ path: path.join(PROJECT_ROOT, ".env.local") });

// =====================
// ENV / CONFIG
// =====================
const VERSION =
  "2026-03-12 | taobao: gallery debug fix | thumbnails/main/gallery fallback | no image blocking | slug fix | single-item checkpoint fix";

const SHEET_ID = (process.env.SHEET_ID || "").trim();
const SHEET_TAB = (process.env.SHEET_TAB || "items").trim();

const NAV_TIMEOUT = Number(process.env.NAV_TIMEOUT || "90000");

// session
const TAO_STORAGE_STATE = (process.env.TAO_STORAGE_STATE || "./scraper/taobao_state.json").trim();

// limits
const TAO_RPM = Math.max(1, Number(process.env.TAO_RPM || "12"));
const TAO_MIN_DELAY_MS = Math.max(200, Number(process.env.TAO_MIN_DELAY_MS || "900"));
const TAO_CONCURRENCY = Math.max(1, Number(process.env.TAO_CONCURRENCY || "1")); // kept for future use
const TAO_OPEN_ITEM_PAGE = String(process.env.TAO_OPEN_ITEM_PAGE || "1").trim() === "1";
const TAO_MAX_PAGES = Math.max(0, Number(process.env.TAO_MAX_PAGES || "0")); // 0 = all
const TAO_PAGE_SIZE = Math.max(10, Math.min(50, Number(process.env.TAO_PAGE_SIZE || "30"))); // kept for future use
const TAO_MAX_IMAGES = Math.max(8, Number(process.env.TAO_MAX_IMAGES || "36"));

// image filters
const TAO_MIN_IMG_DIM = Math.max(120, Number(process.env.TAO_MIN_IMG_DIM || "260"));
const TAO_MAX_ASPECT = Math.max(1.5, Number(process.env.TAO_MAX_ASPECT || "2.6"));

// sheet batching
const FLUSH_EVERY = Math.max(1, Number(process.env.SCRAPER_FLUSH_EVERY || "25"));

// checkpoint
const CHECKPOINT_FILE = (process.env.TAO_CHECKPOINT_FILE || "./scraper/taobao_checkpoint.json").trim();
const RESUME = String(process.env.TAO_RESUME || "1").trim() === "1";
const SKIP_EXISTING = String(process.env.TAO_SKIP_EXISTING || "1").trim() === "1";

if (!SHEET_ID) {
  console.error("❌ ERRORE: SHEET_ID mancante in .env.local");
  process.exit(1);
}

// =====================
// UTILS
// =====================
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

function absPathFromRoot(p) {
  const raw = String(p || "").trim();
  if (!raw) return "";
  return path.isAbsolute(raw) ? raw : path.join(PROJECT_ROOT, raw.replace(/^\.\//, ""));
}

function sheetA1Tab(tab) {
  const safe = String(tab || "").replace(/'/g, "''");
  return `'${safe}'`;
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

function hash36(input) {
  const s = String(input || "");
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h) ^ s.charCodeAt(i);
  return (h >>> 0).toString(36);
}

function padToLen(arr, len) {
  const out = Array.isArray(arr) ? [...arr] : [];
  while (out.length < len) out.push("");
  return out.slice(0, len);
}

function md5hex(s) {
  return crypto.createHash("md5").update(String(s), "utf8").digest("hex");
}

function isTaobaoItemUrl(url) {
  try {
    const u = new URL(String(url || ""));
    const host = u.hostname.toLowerCase();
    if (!host.includes("taobao.com")) return false;
    if (!/\/item\.htm$/i.test(u.pathname)) return false;
    return !!extractTaobaoItemId(url);
  } catch {
    return false;
  }
}

function extractTaobaoItemId(url) {
  try {
    const u = new URL(String(url || ""));
    const host = u.hostname.toLowerCase();
    if (!host.includes("taobao.com")) return "";
    const id = u.searchParams.get("id") || u.searchParams.get("itemId") || "";
    return String(id || "").trim();
  } catch {
    return "";
  }
}

function canonicalizeTaobaoItemUrl(url) {
  const id = extractTaobaoItemId(url);
  if (!id) return String(url || "");
  return `https://item.taobao.com/item.htm?id=${id}`;
}

function normalizeAlicdnUrl(u) {
  let s = String(u || "").trim();
  if (!s) return "";

  if (s.startsWith("//")) s = `https:${s}`;

  // strip only hash/query, but KEEP taobao suffix variants like .jpg_q50.jpg_.webp
  s = s.split("#")[0];
  s = s.split("?")[0];

  // strip "~" suffix only
  s = s.replace(/~.*$/i, "");

  return s;
}

function uniqueKeepOrder(list) {
  const seen = new Set();
  const out = [];
  for (const x of Array.isArray(list) ? list : []) {
    const v = String(x || "").trim();
    if (!v) continue;
    const k = v.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(v);
  }
  return out;
}

function parseCnyFromText(text) {
  const t = String(text ?? "");
  if (!t.trim()) return null;

  const patterns = [
    /(?:¥|￥)\s*~?\s*(\d+(?:\.\d+)?)/g,
    /(\d+(?:\.\d+)?)\s*元/g,
  ];

  const candidates = [];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(t)) !== null) {
      const n = Number(m[1]);
      if (Number.isFinite(n)) candidates.push(n);
      if (candidates.length >= 8) break;
    }
    if (candidates.length) break;
  }

  const ok = candidates.filter((n) => n > 0 && n < 200000);
  return ok.length ? ok[0] : null;
}

// =====================
// IMAGE FILTERS
// =====================
function parseDimsFromUrl(u) {
  const s = String(u || "");

  const m1 = s.match(/-tps-(\d{2,5})-(\d{2,5})\.(jpg|jpeg|png|webp)$/i);
  if (m1) return { w: Number(m1[1]), h: Number(m1[2]) };

  const m2 = s.match(/-(\d{2,5})-(\d{2,5})\.(jpg|jpeg|png|webp)$/i);
  if (m2) return { w: Number(m2[1]), h: Number(m2[2]) };

  return null;
}

function looksLikeAlicdnImage(u) {
  const s = String(u || "").toLowerCase();
  if (!s) return false;
  if (!(s.startsWith("http://") || s.startsWith("https://") || s.startsWith("//"))) return false;
  if (!/\.(jpg|jpeg|png|webp|svg)$/i.test(s.split("?")[0].split("#")[0])) return false;

  return (
    s.includes("alicdn.com") ||
    s.includes("aliimg") ||
    s.includes("gw.alicdn.com") ||
    s.includes("img.alicdn.com") ||
    s.includes("gd.alicdn.com")
  );
}

function looksLikeProductImage(u) {
  const s = String(u || "");
  if (!looksLikeAlicdnImage(s)) return false;

  const low = s.toLowerCase();

  // obvious non-product assets
  if (low.includes("s.gif")) return false;
  if (low.includes("translate/v14/24px.svg")) return false;

  // obvious tps placeholders / ui
  if (low.includes("-tps-48-48")) return false;
  if (low.includes("-tps-78-24")) return false;
  if (low.includes("-tps-96-96")) return false;
  if (low.includes("-tps-114-114")) return false;
  if (low.includes("-tps-172-108")) return false;
  if (low.includes("-tps-236-298")) return false;
  if (low.includes("-tps-2655-282")) return false;
  if (low.includes("-tps-790-300.png")) return false;

  // extra-common placeholder assets
  if (low.includes("6000000001963-2-tps-790-300.png")) return false;
  if (low.includes("6000000004793-2-tps-172-108.png")) return false;

  // generic tps png from tb1* are often UI assets, not product
  if (low.includes("/tps/") && low.includes("tb1") && low.endsWith(".png")) return false;

  const d = parseDimsFromUrl(s);
  if (d) {
    const min = Math.min(d.w, d.h);
    const max = Math.max(d.w, d.h);
    const aspect = max / Math.max(1, min);

    if (min < TAO_MIN_IMG_DIM) return false;
    if (aspect > TAO_MAX_ASPECT) return false;
  }

  return true;
}

function scoreProductImage(u) {
  const s = String(u || "");
  const low = s.toLowerCase();
  let sc = 0;

  const d = parseDimsFromUrl(s);
  if (d) sc += Math.min(10, Math.floor(Math.min(d.w, d.h) / 200));

  if (low.includes("imgextra")) sc += 3;
  if (low.includes("o1cn")) sc += 3;
  if (low.endsWith(".jpg") || low.endsWith(".jpeg")) sc += 1;
  if (low.includes("gw.alicdn.com")) sc += 1;

  return sc;
}

function pickBestProductImages(urls, max = 36) {
  const normed = uniqueKeepOrder(
    (urls || [])
      .map((x) => normalizeAlicdnUrl(x))
      .filter(Boolean)
      .map((x) => (x.startsWith("//") ? `https:${x}` : x))
  );

  const filtered = normed.filter(looksLikeProductImage);

  const safeFallback =
    filtered.length > 0
      ? filtered
      : normed.filter((u) => {
          if (!looksLikeAlicdnImage(u)) return false;
          const d = parseDimsFromUrl(u);
          if (d && Math.min(d.w, d.h) < 160) return false;
          return true;
        });

  const ranked = [...safeFallback].sort((a, b) => scoreProductImage(b) - scoreProductImage(a));

  return uniqueKeepOrder(ranked).slice(0, max);
}

function extractProductImagesFromHtml(html) {
  const text = String(html || "");
  if (!text) return [];

  const patterns = [
    /"auctionImages"\s*:\s*(\[[^\]]+\])/i,
    /auctionImages\s*:\s*(\[[^\]]+\])/i,
    /"itemImages"\s*:\s*(\[[^\]]+\])/i,
    /itemImages\s*:\s*(\[[^\]]+\])/i,
  ];

  const tryJsonArray = (raw) => {
    if (!raw) return null;

    let s = raw.trim();
    s = s.replace(/\\u002F/gi, "/");
    s = s.replace(/\\\\\//g, "/");
    s = s.replace(/\\\//g, "/");

    if (s.includes("'") && !s.includes('"')) {
      s = s.replace(/'/g, '"');
    }

    try {
      const arr = JSON.parse(s);
      if (Array.isArray(arr)) return arr.map(String);
    } catch {}

    try {
      const unescaped = s.replace(/\\"/g, '"');
      const arr = JSON.parse(unescaped);
      if (Array.isArray(arr)) return arr.map(String);
    } catch {}

    return null;
  };

  for (const re of patterns) {
    const m = text.match(re);
    if (!m || !m[1]) continue;
    const arr = tryJsonArray(m[1]);
    if (arr && arr.length) return arr;
  }

  return [];
}

// =====================
// RATE LIMITER
// =====================
class RateLimiter {
  constructor({ rpm = 12, minDelayMs = 900 } = {}) {
    this.rpm = rpm;
    this.minDelayMs = minDelayMs;
    this.tokens = rpm;
    this.lastRefill = Date.now();
    this.lastReq = 0;
  }

  async wait() {
    const now = Date.now();
    if (now - this.lastRefill >= 60_000) {
      this.tokens = this.rpm;
      this.lastRefill = now;
    }

    while (this.tokens <= 0) {
      await sleep(1200);
      const n2 = Date.now();
      if (n2 - this.lastRefill >= 60_000) {
        this.tokens = this.rpm;
        this.lastRefill = n2;
      }
    }

    const gap = now - this.lastReq;
    if (gap < this.minDelayMs) await sleep(this.minDelayMs - gap);

    this.tokens -= 1;
    this.lastReq = Date.now();
  }
}

// =====================
// CHECKPOINT
// =====================
function loadCheckpoint() {
  const abs = absPathFromRoot(CHECKPOINT_FILE);
  if (!RESUME) return { done: {} };
  if (!fs.existsSync(abs)) return { done: {} };

  try {
    const j = JSON.parse(fs.readFileSync(abs, "utf-8"));
    if (j && j.done && typeof j.done === "object") return j;
  } catch {}

  return { done: {} };
}

function saveCheckpoint(state) {
  const abs = absPathFromRoot(CHECKPOINT_FILE);
  const dir = path.dirname(abs);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  fs.writeFileSync(
    abs,
    JSON.stringify({ ...state, updatedAt: new Date().toISOString(), version: VERSION }, null, 2),
    "utf-8"
  );
}

function makeDoneKey(seller, itemUrl) {
  return `${String(seller || "").trim().toLowerCase()}||${canonicalizeTaobaoItemUrl(itemUrl)}`;
}

// =====================
// GOOGLE SHEETS
// =====================
async function tryReadJsonFile(p) {
  try {
    const txt = fs.readFileSync(p, "utf8");
    return JSON.parse(txt);
  } catch {
    return null;
  }
}

async function readServiceAccount() {
  const raw =
    (process.env.GOOGLE_SERVICE_ACCOUNT_JSON || "").trim() ||
    (process.env.GOOGLE_SERVICE_ACCOUNT || "").trim() ||
    "";

  if (raw && (raw.startsWith("/") || raw.startsWith("."))) {
    const obj = await tryReadJsonFile(absPathFromRoot(raw));
    if (obj?.client_email && obj?.private_key) return obj;
  }

  if (raw && raw.startsWith("{")) {
    try {
      const obj = JSON.parse(raw);
      if (obj?.client_email && obj?.private_key) return obj;
    } catch {}
  }

  for (const p of ["service-account.json", "scraper/service-account.json"]) {
    const obj = await tryReadJsonFile(absPathFromRoot(p));
    if (obj?.client_email && obj?.private_key) return obj;
  }

  throw new Error("Missing Google credentials. Provide GOOGLE_SERVICE_ACCOUNT_JSON or service-account.json");
}

function normalizePrivateKey(key) {
  return String(key || "").replace(/\\n/g, "\n");
}

async function getSheetsClient() {
  const credentials = await readServiceAccount();
  credentials.private_key = normalizePrivateKey(credentials.private_key);

  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });

  return google.sheets({ version: "v4", auth });
}

async function getIdRowCount(sheets) {
  const range = `${sheetA1Tab(SHEET_TAB)}!A2:A`;
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range });
  return (res.data.values || []).length;
}

async function loadExistingIndex(sheets) {
  const count = await getIdRowCount(sheets);
  if (count <= 0) {
    return { existingSlugs: new Set(), byKey: new Map(), nextAppendRow: 2 };
  }

  const lastRow = count + 1;
  const range = `${sheetA1Tab(SHEET_TAB)}!A2:T${lastRow}`;
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range });
  const values = res.data.values || [];

  const existingSlugs = new Set();
  const byKey = new Map();

  for (let i = 0; i < values.length; i++) {
    const rowNumber = 2 + i;
    const row = padToLen(values[i], 20);

    const slug = String(row[1] || "").trim();
    if (slug) existingSlugs.add(slug);

    const seller = String(row[5] || "").trim().toLowerCase();

    const sourceUrl = String(row[17] || "").trim();
    const key = sourceUrl ? `${seller}||${canonicalizeTaobaoItemUrl(sourceUrl)}` : "";
    if (key) byKey.set(key, { rowNumber, rowValues: row });
  }

  return { existingSlugs, byKey, nextAppendRow: count + 2 };
}

async function writeRowsInBatches(sheets, rows, startRow, batchSize = 50) {
  if (!rows.length) return startRow;
  const batches = Math.ceil(rows.length / batchSize);

  let cur = startRow;
  for (let i = 0; i < batches; i++) {
    const slice = rows.slice(i * batchSize, (i + 1) * batchSize);
    const endRow = cur + slice.length - 1;
    const range = `${sheetA1Tab(SHEET_TAB)}!A${cur}:T${endRow}`;

    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range,
      valueInputOption: "RAW",
      requestBody: { values: slice },
    });

    console.log(`✅ WRITE batch ${i + 1}/${batches} -> ${range}`);
    cur = endRow + 1;
    await sleep(200);
  }

  return cur;
}

async function batchUpdateRows(sheets, updates, batchSize = 50) {
  if (!updates.length) return;
  const batches = Math.ceil(updates.length / batchSize);

  for (let i = 0; i < batches; i++) {
    const slice = updates.slice(i * batchSize, (i + 1) * batchSize);

    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: SHEET_ID,
      requestBody: { valueInputOption: "RAW", data: slice },
    });

    console.log(`✅ UPDATE batch ${i + 1}/${batches} (${slice.length})`);
    await sleep(200);
  }
}

// =====================
// SIMPLE MUTEX
// =====================
function createMutex() {
  let p = Promise.resolve();

  return {
    async runExclusive(fn) {
      const prev = p;
      let release;
      p = new Promise((r) => {
        release = r;
      });

      await prev;
      try {
        return await fn();
      } finally {
        release();
      }
    },
  };
}

// =====================
// SAFE GOTO
// =====================
async function safeGoto(page, url, { retries = 2, timeout = NAV_TIMEOUT } = {}) {
  let lastErr = null;

  for (let i = 1; i <= retries; i++) {
    try {
      const resp = await page.goto(url, { waitUntil: "domcontentloaded", timeout }).catch(() => null);
      const status = resp?.status?.() ?? 0;
      if (status >= 400) throw new Error(`HTTP ${status}`);
      return true;
    } catch (e) {
      lastErr = e;
      console.log(`⚠️ goto fail (${i}/${retries}): ${url}`);
      await sleep(1200 * i);
    }
  }

  throw lastErr || new Error("goto failed");
}

// =====================
// MTOP helpers
// =====================
const MTOP_APPKEY = "12574478";

async function getMtopTokenPart(context) {
  const cookies = await context.cookies("https://h5api.m.taobao.com/");
  const tk = cookies.find((c) => c.name === "_m_h5_tk")?.value || "";
  const tokenPart = tk.split("_")[0] || "";
  return tokenPart.trim();
}

function signMtop(tokenPart, t, appKey, data) {
  return md5hex(`${tokenPart}&${t}&${appKey}&${data}`);
}

async function mtopGet(context, limiter, { api, v = "1.0", dataObj, referer = "" }) {
  await limiter.wait();

  const tokenPart = await getMtopTokenPart(context);
  if (!tokenPart) return { ok: false, err: "Missing _m_h5_tk (not logged in?)", json: null };

  const t = String(Date.now());
  const data = JSON.stringify(dataObj || {});
  const sign = signMtop(tokenPart, t, MTOP_APPKEY, data);

  const url =
    `https://h5api.m.taobao.com/h5/${api}/${v}/?` +
    `jsv=2.6.2&appKey=${MTOP_APPKEY}&t=${encodeURIComponent(t)}` +
    `&sign=${encodeURIComponent(sign)}&api=${encodeURIComponent(api)}&v=${encodeURIComponent(v)}` +
    `&type=originaljson&dataType=json&timeout=10000&needLogin=true&LoginRequest=true` +
    `&data=${encodeURIComponent(data)}`;

  const headers = {
    accept: "application/json",
    "content-type": "application/x-www-form-urlencoded",
    ...(referer ? { referer, origin: new URL(referer).origin } : {}),
  };

  const res = await context.request.get(url, { headers }).catch(() => null);
  if (!res) return { ok: false, err: "No response", json: null };

  const status = res.status();
  const txt = await res.text().catch(() => "");
  let json = null;
  try {
    json = JSON.parse(txt);
  } catch {}

  if (status >= 400) return { ok: false, err: `HTTP ${status}`, json };
  return { ok: true, err: "", json };
}

// =====================
// ShopId / SellerId extraction (from shop homepage)
// =====================
async function extractShopIdsFromShopHome(page, shopUrl) {
  await safeGoto(page, shopUrl, { retries: 2, timeout: NAV_TIMEOUT });
  await page.waitForTimeout(800);

  const got = await page
    .evaluate(() => {
      const gc = window.g_config || {};
      const s = gc?.seller || {};
      const shopId = s.shopId || s.shop_id || "";
      const sellerId = s.sellerId || s.seller_id || "";
      const sellerNick = s.sellerNick || s.seller_nick || s.wangwang || "";

      return {
        shopId: String(shopId || "").trim(),
        sellerId: String(sellerId || "").trim(),
        sellerNick: String(sellerNick || "").trim(),
      };
    })
    .catch(() => ({ shopId: "", sellerId: "", sellerNick: "" }));

  if (got.shopId && got.sellerId) return got;

  const html = await page.content().catch(() => "");
  const mShop = html.match(/"shopId"\s*:\s*"(\d+)"/i);
  const mSeller = html.match(/"sellerId"\s*:\s*"(\d+)"/i);

  return {
    shopId: mShop?.[1] || "",
    sellerId: mSeller?.[1] || "",
    sellerNick: got.sellerNick || "",
  };
}

// =====================
// Item detail scrape (price + gallery + shop url + sellerNick)
// =====================
async function scrapeTaobaoItemDetail(page, limiter, itemUrl) {
  await limiter.wait();
  await safeGoto(page, itemUrl, { retries: 2, timeout: NAV_TIMEOUT });

  await page.waitForTimeout(2500);

  await page
    .waitForSelector("#picGalleryEle, img[src*='img.alicdn.com'], img[src*='gw.alicdn.com']", {
      timeout: 10000,
    })
    .catch(() => {});

  await page.evaluate(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    window.scrollTo(0, 300);
    await sleep(300);
    window.scrollTo(0, 900);
    await sleep(300);
    window.scrollTo(0, 0);
  });

  await page.waitForTimeout(1000);

  const info = await page
    .evaluate(() => {
      const ogt = document.querySelector('meta[property="og:title"]')?.getAttribute("content") || "";
      const ogi = document.querySelector('meta[property="og:image"]')?.getAttribute("content") || "";
      const title = (ogt || document.title || "").trim();

      const gc = window.g_config || {};
      const nick =
        (gc?.sellerNick || gc?.seller_nick || gc?.seller?.sellerNick || gc?.seller?.wangwang || "") + "";

      const pickAttr = (img) =>
        img.getAttribute("src") ||
        img.getAttribute("data-src") ||
        img.getAttribute("data-original") ||
        img.getAttribute("data-lazy") ||
        img.getAttribute("data-ks-lazyload") ||
        img.getAttribute("data-img") ||
        "";

      const abs = (href) => {
        try {
          return new URL(href, location.href).toString();
        } catch {
          return "";
        }
      };

      const anchors = Array.from(document.querySelectorAll("a[href]"))
        .map((a) => a.getAttribute("href") || "")
        .filter(Boolean);

      const candidates = anchors
        .map(abs)
        .filter(Boolean)
        .filter((u) => u.includes("taobao.com"))
        .filter((u) => !u.includes("/item.htm"));

      let shopUrl = "";
      for (const u of candidates) {
        const low = u.toLowerCase();
        if (low.includes("world.taobao.com")) {
          shopUrl = u;
          break;
        }
        if (low.includes("shop") && low.includes("taobao.com")) {
          shopUrl = u;
          break;
        }
        if (low.match(/\/\/shop\d+\.taobao\.com/i)) {
          shopUrl = u;
          break;
        }
      }

      const galleryImgsRaw = Array.from(document.querySelectorAll("#picGalleryEle img")).map((img, i) => ({
        i,
        url: pickAttr(img),
        cls: String(img.className || ""),
        parent: String(img.parentElement?.className || ""),
        grand: String(img.parentElement?.parentElement?.className || ""),
        w: img.naturalWidth || 0,
        h: img.naturalHeight || 0,
      }));

      const isThumb = (x) =>
        /thumbnail/i.test(x.cls) ||
        /thumbnail/i.test(x.parent) ||
        /thumbnail/i.test(x.grand);

      const isMain = (x) =>
        /mainpic/i.test(x.cls) ||
        /mainpic/i.test(x.parent) ||
        /mainpic/i.test(x.grand) ||
        /mainpicwrap/i.test(x.cls) ||
        /mainpicwrap/i.test(x.parent) ||
        /mainpicwrap/i.test(x.grand);

      const thumbnailImgs = galleryImgsRaw
        .filter((x) => x.url)
        .filter(isThumb)
        .map((x) => x.url);

      const mainImgs = galleryImgsRaw
        .filter((x) => x.url)
        .filter(isMain)
        .map((x) => x.url);

      const allGalleryImgs = galleryImgsRaw
        .filter((x) => x.url)
        .map((x) => x.url);

      return {
        title,
        ogImage: String(ogi || "").trim(),
        sellerNick: String(nick || "").trim(),
        shopUrl: String(shopUrl || "").trim(),
        thumbnailImages: thumbnailImgs,
        mainImages: mainImgs,
        allGalleryImages: allGalleryImgs,
      };
    })
    .catch(() => ({
      title: "",
      ogImage: "",
      sellerNick: "",
      shopUrl: "",
      thumbnailImages: [],
      mainImages: [],
      allGalleryImages: [],
    }));

  const priceText = await page
    .evaluate(() => {
      const pickNum = (s) => {
        const t = String(s || "").replace(/\s+/g, " ").trim();
        if (!t) return "";
        const m = t.match(/(?:¥|￥)\s*([0-9]+(?:\.[0-9]+)?)/);
        if (m && m[1]) return m[1];
        const m2 = t.match(/([0-9]+(?:\.[0-9]+)?)\s*元/);
        if (m2 && m2[1]) return m2[1];
        return "";
      };

      const selectors = [
        "#J_PromoPrice .tb-rmb-num",
        "#J_StrPrice .tb-rmb-num",
        ".tb-rmb-num",
        "[class*='Price'] [class*='num']",
        "[class*='price'] [class*='num']",
        "#J_PromoPrice",
        "#J_StrPrice",
      ];

      for (const sel of selectors) {
        const el = document.querySelector(sel);
        if (!el) continue;
        const n = pickNum(el.textContent || "");
        if (n) return n;
      }

      const nodes = Array.from(document.querySelectorAll("span,div"))
        .filter((el) => {
          const txt = (el.textContent || "").trim();
          if (!txt) return false;
          if (!(txt.includes("¥") || txt.includes("￥") || txt.includes("元"))) return false;
          const r = el.getBoundingClientRect();
          if (!r || r.width < 20 || r.height < 10) return false;
          return true;
        })
        .slice(0, 600);

      for (const el of nodes) {
        const n = pickNum(el.textContent || "");
        if (n) return n;
      }

      return "";
    })
    .catch(() => "");

  const priceCny = priceText ? Number(priceText) : null;

  const thumbs = uniqueKeepOrder(
    (info.thumbnailImages || [])
      .map(normalizeAlicdnUrl)
      .filter(Boolean)
      .filter(looksLikeProductImage)
  );

  const mains = uniqueKeepOrder(
    (info.mainImages || [])
      .map(normalizeAlicdnUrl)
      .filter(Boolean)
      .filter(looksLikeProductImage)
  );

  const galleryAll = uniqueKeepOrder(
    (info.allGalleryImages || [])
      .map(normalizeAlicdnUrl)
      .filter(Boolean)
      .filter(looksLikeProductImage)
  );

  let images = [];
  if (thumbs.length) {
    images = thumbs;
  } else if (galleryAll.length) {
    images = galleryAll;
  } else if (mains.length) {
    images = mains;
  }

  images = uniqueKeepOrder(images).slice(0, TAO_MAX_IMAGES);

  const og = normalizeAlicdnUrl(info.ogImage || "");
  const cover = images[0] || (looksLikeProductImage(og) ? og : "") || "";

  const final = uniqueKeepOrder([cover, ...images]).filter(Boolean).slice(0, TAO_MAX_IMAGES);

  console.log("DBG thumbnailImages:", info.thumbnailImages);
  console.log("DBG mainImages:", info.mainImages);
  console.log("DBG allGalleryImages:", info.allGalleryImages);
  console.log("DBG final picked:", final);

  return {
    title: info.title || "",
    priceCny: Number.isFinite(priceCny) ? priceCny : null,
    images: final,
    cover: cover || final[0] || "",
    shopUrl: info.shopUrl || "",
    sellerNick: info.sellerNick || "",
  };
}

// =====================
// BUILD ROW (A:T)
// =====================
function buildStableId(sellerName, sourceUrl) {
  const sid = slugify(sellerName || "seller", 32) || "seller";
  const itemId = extractTaobaoItemId(sourceUrl) || "";
  if (itemId) return `${sid}-tb${itemId}`;
  return `${sid}-${hash36(sourceUrl).slice(0, 10)}`;
}

function buildUniqueSlug(title, sellerName, sourceUrl) {
  const sid = slugify(sellerName || "seller", 20) || "seller";
  const base = slugify(title || "item", 60) || "item";
  const itemId = extractTaobaoItemId(sourceUrl) || hash36(sourceUrl).slice(0, 8);
  return slugify(`${base}-${sid}-${itemId}`, 95);
}

function makeUniqueSlug(slugBase, existingSlugs) {
  let s = String(slugBase || "").trim();
  if (!s) s = `item-${Date.now()}`;
  if (!existingSlugs.has(s)) return s;
  let n = 2;
  while (existingSlugs.has(`${s}-${n}`)) n++;
  return `${s}-${n}`;
}

// =====================
// JOBS PARSER
// =====================
function parseJobLine(line) {
  const raw = String(line || "").trim();
  if (!raw || raw.startsWith("#")) return null;

  const parts = raw.split("|").map((p) => p.trim()).filter(Boolean);
  if (!parts.length) return null;

  const job = {
    url: parts[0],
    seller: "",
    brand: "",
    category: "OTHER",
    maxPages: 0,
    shopId: "",
    sellerId: "",
    orderType: "popular",
    keyword: "",
    shop: "",
  };

  for (const p of parts.slice(1)) {
    const [kRaw, ...rest] = p.split("=");
    const k = String(kRaw || "").trim().toLowerCase();
    const v = rest.join("=").trim();

    if (k === "seller") job.seller = v;
    else if (k === "brand") job.brand = v;
    else if (k === "category") job.category = v || "OTHER";
    else if (k === "maxpages") job.maxPages = Number(v || "0") || 0;
    else if (k === "shopid") job.shopId = v;
    else if (k === "sellerid") job.sellerId = v;
    else if (k === "order" || k === "ordertype") job.orderType = v || "popular";
    else if (k === "keyword") job.keyword = v || "";
    else if (k === "shop") job.shop = v || "";
  }

  return job;
}

function loadJobsFromFile(filePath) {
  const abs = absPathFromRoot(filePath);
  if (!fs.existsSync(abs)) {
    console.error("❌ Jobs file non trovato:", abs);
    process.exit(1);
  }

  const txt = fs.readFileSync(abs, "utf-8");
  const lines = txt.split(/\r?\n/);
  const jobs = [];

  for (const line of lines) {
    const j = parseJobLine(line);
    if (j) jobs.push(j);
  }

  return jobs;
}

function parseArgs(argv) {
  const args = {
    file: "",
    auth: false,
    storage: "",
    prime: "",
    headful: false,

    // single-url mode
    url: "",
    seller: "",
    brand: "",
    category: "OTHER",
    shop: "",
    maxPages: 0,
    shopId: "",
    sellerId: "",
    orderType: "popular",
    keyword: "",
  };

  const list = [...argv];

  if (list[2] && !String(list[2]).startsWith("--")) {
    args.url = String(list[2]).trim();
  }

  for (let i = 2; i < list.length; i++) {
    const a = list[i];
    if (a === "--file") args.file = String(list[++i] || "");
    else if (a === "--auth") args.auth = true;
    else if (a === "--storage") args.storage = String(list[++i] || "");
    else if (a === "--prime") args.prime = String(list[++i] || "");
    else if (a === "--headful") args.headful = true;
    else if (a === "--url") args.url = String(list[++i] || "");
    else if (a === "--seller") args.seller = String(list[++i] || "");
    else if (a === "--brand") args.brand = String(list[++i] || "");
    else if (a === "--category") args.category = String(list[++i] || "OTHER");
    else if (a === "--shop") args.shop = String(list[++i] || "");
    else if (a === "--maxPages") args.maxPages = Number(list[++i] || "0") || 0;
    else if (a === "--shopId") args.shopId = String(list[++i] || "");
    else if (a === "--sellerId") args.sellerId = String(list[++i] || "");
    else if (a === "--order") args.orderType = String(list[++i] || "popular");
    else if (a === "--keyword") args.keyword = String(list[++i] || "");
  }

  return args;
}

// =====================
// AUTH (save storageState)
// =====================
async function ensureAuthStorage(browser, storageAbs, primeUrl) {
  if (storageAbs && fs.existsSync(storageAbs)) return storageAbs;

  console.log("\n🔐 LOGIN richiesto: apro browser visibile.");
  console.log("   1) fai login su Taobao");
  console.log("   2) torna sulla pagina shop/item");
  console.log("   3) premi INVIO qui per salvare la sessione\n");

  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await safeGoto(page, primeUrl, { retries: 2, timeout: NAV_TIMEOUT });
  await page.waitForTimeout(800);

  await waitEnter("✅ Quando sei loggato e la pagina funziona, premi INVIO... ");

  const dir = path.dirname(storageAbs);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  await ctx.storageState({ path: storageAbs });
  await ctx.close();

  console.log("✅ Sessione salvata in:", storageAbs);
  return storageAbs;
}

// =====================
// MAIN helpers
// =====================
function modeFromUrl(url) {
  const u = String(url || "").trim();
  if (!u) return "UNKNOWN";
  if (isTaobaoItemUrl(u)) return "ITEM";
  return "SHOP";
}

async function upsertRow({ byKey, existingSlugs, pendingAppends, pendingUpdates, seller, itemUrl, row, doneKey }) {
  const sellerLower = String(seller || "").trim().toLowerCase();
  const key = `${sellerLower}||${canonicalizeTaobaoItemUrl(itemUrl)}`;

  const existing = byKey.get(key);
  if (existing && existing.rowNumber >= 2) {
    const existingSlug = String(existing?.rowValues?.[1] || "").trim();
    if (existingSlug) row[1] = existingSlug;

    const range = `${sheetA1Tab(SHEET_TAB)}!A${existing.rowNumber}:T${existing.rowNumber}`;
    pendingUpdates.push({ key, range, values: [row], doneKey });
    return { key, kind: "update" };
  }

  const slugBase = String(row[1] || "").trim();
  const uniqueSlug = makeUniqueSlug(slugBase, existingSlugs);
  row[1] = uniqueSlug;
  existingSlugs.add(uniqueSlug);

  pendingAppends.push({ key, row, doneKey });
  byKey.set(key, { rowNumber: -1, rowValues: row });
  return { key, kind: "append" };
}

// =====================
// MAIN
// =====================
async function main() {
  const args = parseArgs(process.argv);

  const storageAbs = absPathFromRoot(args.storage || TAO_STORAGE_STATE);
  const headless = !args.headful && !args.auth;
  const primeUrl =
    (args.prime || "").trim() ||
    (args.url || "").trim() ||
    "https://shop575605088.world.taobao.com/";

  if (!args.file && !args.auth && !args.url) {
    console.log("\n❌ Uso:");
    console.log("1) Salvare login:");
    console.log(
      `   node scraper/scrape_taobao_to_sheet.mjs --auth --storage ${TAO_STORAGE_STATE} --prime "${primeUrl}"`
    );
    console.log("\n2) Eseguire jobs:");
    console.log(
      `   node scraper/scrape_taobao_to_sheet.mjs --file ./scraper/taobao_jobs.txt --storage ${TAO_STORAGE_STATE}`
    );
    console.log("\n3) Singolo item:");
    console.log(
      `   node scraper/scrape_taobao_to_sheet.mjs "https://item.taobao.com/item.htm?id=XXXX" --seller NAME --brand "BRAND" --category "BAGS" --storage ${TAO_STORAGE_STATE}`
    );
    process.exit(0);
  }

  const sheets = await getSheetsClient();
  const { existingSlugs, byKey, nextAppendRow: nextAppendRowInit } = await loadExistingIndex(sheets);
  let nextAppendRow = nextAppendRowInit;

  const checkpoint = loadCheckpoint();
  checkpoint.done = checkpoint.done || {};

  const limiter = new RateLimiter({ rpm: TAO_RPM, minDelayMs: TAO_MIN_DELAY_MS });

  const browser = await chromium.launch({ headless: args.auth ? false : headless });
  let context = null;

  const sheetLock = createMutex();

  let pendingAppends = [];
  let pendingUpdates = [];

  async function flushToSheet(force = false) {
    return sheetLock.runExclusive(async () => {
      if (!force && pendingAppends.length + pendingUpdates.length < FLUSH_EVERY) return;

      const upd = pendingUpdates.splice(0);
      const app = pendingAppends.splice(0);

      if (upd.length) {
        await batchUpdateRows(
          sheets,
          upd.map((u) => ({ range: u.range, values: u.values })),
          50
        );
      }

      if (app.length) {
        const startRow = nextAppendRow;
        nextAppendRow = await writeRowsInBatches(sheets, app.map((a) => a.row), startRow, 50);

        for (let i = 0; i < app.length; i++) {
          const rowNumber = startRow + i;
          byKey.set(app[i].key, { rowNumber, rowValues: padToLen(app[i].row, 20) });
        }
      }

      const doneKeys = [...upd.map((x) => x.doneKey), ...app.map((x) => x.doneKey)].filter(Boolean);
      for (const k of doneKeys) checkpoint.done[k] = 1;
      saveCheckpoint(checkpoint);

      console.log(`✅ FLUSH OK | updates=${upd.length} appends=${app.length} | nextAppendRow=${nextAppendRow}`);
    });
  }

  try {
    if (args.auth || !fs.existsSync(storageAbs)) {
      await ensureAuthStorage(browser, storageAbs, primeUrl);
      if (args.auth && !args.file && !args.url) return;
    }

    context = await browser.newContext({
      storageState: fs.existsSync(storageAbs) ? storageAbs : undefined,
    });
    context.setDefaultNavigationTimeout(NAV_TIMEOUT);

    // Keep images enabled
    await context.route("**/*", (route) => {
      try {
        const t = route.request().resourceType();
        if (t === "font" || t === "media") return route.abort();
        return route.continue();
      } catch {
        return route.continue();
      }
    });

    const jobs = args.file
      ? loadJobsFromFile(args.file)
      : [
          {
            url: args.url,
            seller: args.seller,
            brand: args.brand,
            category: args.category || "OTHER",
            maxPages: args.maxPages || 0,
            shopId: args.shopId || "",
            sellerId: args.sellerId || "",
            orderType: args.orderType || "popular",
            keyword: args.keyword || "",
            shop: args.shop || "",
          },
        ];

    console.log("====================================");
    console.log("✅ Taobao -> Google Sheet Scraper");
    console.log("VERSION:", VERSION);
    console.log("ROOT:", PROJECT_ROOT);
    console.log("SHEET_ID:", SHEET_ID);
    console.log("TAB:", SHEET_TAB);
    console.log("storageState:", storageAbs);
    console.log("RPM:", TAO_RPM, "| minDelayMs:", TAO_MIN_DELAY_MS, "| concurrency:", TAO_CONCURRENCY);
    console.log("open item page for price:", TAO_OPEN_ITEM_PAGE ? "ON" : "OFF");
    console.log("imgFilter: minDim=", TAO_MIN_IMG_DIM, "maxAspect=", TAO_MAX_ASPECT);
    console.log("====================================\n");

    for (let j = 0; j < jobs.length; j++) {
      const job = jobs[j];
      const urlRaw = String(job.url || "").trim();
      const mode = modeFromUrl(urlRaw);

      console.log("\n------------------------------------");
      console.log(`🚀 Job ${j + 1}/${jobs.length} | mode=${mode}`);
      console.log("🔗 URL:", urlRaw);
      console.log("👤 Seller:", job.seller || "(missing)");
      console.log("🏷️ Brand:", job.brand || "");
      console.log("📌 Category:", job.category || "OTHER");
      console.log("------------------------------------");

      const page = await context.newPage();

      if (mode === "ITEM") {
        const itemUrl = canonicalizeTaobaoItemUrl(urlRaw);

        const checkpointKey = `item||${itemUrl}`;
        if (RESUME && checkpoint.done[checkpointKey]) {
          console.log("⏩ checkpoint skip:", itemUrl);
          await page.close();
          continue;
        }

        let sellerName = String(job.seller || "").trim();

        if (SKIP_EXISTING && sellerName) {
          const key = `${sellerName.toLowerCase()}||${itemUrl}`;
          if (byKey.has(key)) {
            console.log("⏩ existing skip:", itemUrl);
            await page.close();
            continue;
          }
        }

        let det = null;
        try {
          det = await scrapeTaobaoItemDetail(page, limiter, itemUrl);
        } catch (e) {
          console.log("❌ item detail fail:", String(e?.message || e).split("\n")[0]);
        }

        if (!sellerName) sellerName = String(det?.sellerNick || "").trim();
        if (!sellerName) sellerName = "taobao";

        const titleFinal = String(det?.title || "").trim() || "Item";
        const priceCny = det?.priceCny ?? parseCnyFromText(titleFinal);

        const gallery = uniqueKeepOrder((det?.images || []).map(normalizeAlicdnUrl).filter(Boolean));
        const goodGallery = pickBestProductImages(gallery, TAO_MAX_IMAGES);

        const img1to8 = goodGallery.slice(0, 8);
        const extra = goodGallery.slice(8);

        const id = buildStableId(sellerName, itemUrl);
        const slugBase = buildUniqueSlug(titleFinal, sellerName, itemUrl);

        const shopForQ = String(job.shop || "").trim() || String(det?.shopUrl || "").trim() || "";

        const row = padToLen(
          [
            id,
            slugBase,
            titleFinal,
            String(job.brand || "").trim(),
            String(job.category || "OTHER").trim(),
            sellerName,
            img1to8[0] || "",
            img1to8[1] || "",
            img1to8[2] || "",
            img1to8[3] || "",
            img1to8[4] || "",
            img1to8[5] || "",
            img1to8[6] || "",
            img1to8[7] || "",
            extra.length ? extra.join(", ") : "",
            "ok",
            shopForQ,
            itemUrl,
            priceCny != null ? String(priceCny) : "",
            "",
          ],
          20
        );

        await upsertRow({
          byKey,
          existingSlugs,
          pendingAppends,
          pendingUpdates,
          seller: sellerName,
          itemUrl,
          row,
          doneKey: checkpointKey,
        });

        await flushToSheet(true);
        await page.close();
        continue;
      }

      const seller = String(job.seller || "").trim();
      if (!seller) {
        console.log("❌ Shop job senza seller=. Metti seller= nel jobs file.");
        await page.close();
        continue;
      }

      let shopId = String(job.shopId || "").trim();
      let sellerId = String(job.sellerId || "").trim();

      if (!shopId || !sellerId) {
        const ids = await extractShopIdsFromShopHome(page, urlRaw);
        shopId = shopId || ids.shopId;
        sellerId = sellerId || ids.sellerId;
      }

      if (!shopId || !sellerId) {
        console.log("❌ Non riesco a trovare shopId/sellerId. Mettili nel job: shopId=...|sellerId=...");
        await page.close();
        continue;
      }

      const maxPages = Number(job.maxPages || 0) || TAO_MAX_PAGES;
      let pageNum = 1;
      let hasNext = true;
      let totalProcessed = 0;

      while (hasNext) {
        if (maxPages > 0 && pageNum > maxPages) break;

        const dataObj = {
          page: pageNum,
          pageSize: TAO_PAGE_SIZE,
          orderType: job.orderType || "popular",
          sortType: "",
          catId: 0,
          keyword: job.keyword || "",
          filterType: "",
          shopId: String(shopId),
          sellerId: String(sellerId),
        };

        const mtop = await mtopGet(context, limiter, {
          api: "mtop.taobao.shop.simple.item.fetch",
          v: "1.0",
          dataObj,
          referer: urlRaw,
        });

        const json = mtop.json;
        const ret0 = String(json?.ret?.[0] || "");
        const ok = mtop.ok && ret0.includes("SUCCESS");

        if (!ok) {
          console.log("❌ MTOP fail:", ret0 || mtop.err || "unknown");
          console.log("   -> spesso significa sessione scaduta. Rifai: --auth");
          break;
        }

        const items = json?.data?.data || [];
        const hasNextResp = !!json?.data?.hasNext;

        console.log(`📄 page=${pageNum} | items=${items.length} | hasNext=${hasNextResp}`);

        for (const it of items) {
          const itemId = String(it?.itemId || "").trim();
          const itemUrl = canonicalizeTaobaoItemUrl(String(it?.itemUrl || ""));
          if (!itemId || !itemUrl) continue;

          const doneKey = makeDoneKey(seller, itemUrl);
          if (RESUME && checkpoint.done[doneKey]) continue;

          const key = `${seller.toLowerCase()}||${itemUrl}`;
          if (SKIP_EXISTING && byKey.has(key)) continue;

          const titleFromList = String(it?.title || "").trim();

          const coverCandidates = [it?.image, it?.picUrl, it?.imgUrl, it?.imageUrl]
            .map((x) => normalizeAlicdnUrl(String(x || "")))
            .filter(Boolean);

          const skuImgs = uniqueKeepOrder(
            (it?.skuInfoList || [])
              .map((s) => normalizeAlicdnUrl(s?.skuImageUrl || ""))
              .filter(Boolean)
          );

          let gallery = uniqueKeepOrder([...coverCandidates, ...skuImgs].filter(Boolean));
          let priceCny = null;
          let titleFinal = titleFromList;

          if (TAO_OPEN_ITEM_PAGE) {
            try {
              const det = await scrapeTaobaoItemDetail(page, limiter, itemUrl);
              if (det?.title) titleFinal = det.title;
              if (det?.priceCny != null) priceCny = det.priceCny;
              if (Array.isArray(det?.images) && det.images.length) {
                gallery = uniqueKeepOrder([...coverCandidates, ...det.images].filter(Boolean));
              }
            } catch {
              const pGuess = parseCnyFromText(titleFromList);
              if (pGuess != null) priceCny = pGuess;
            }
          } else {
            const pGuess = parseCnyFromText(titleFromList);
            if (pGuess != null) priceCny = pGuess;
          }

          const goodGallery = pickBestProductImages(gallery, TAO_MAX_IMAGES);
          const img1to8 = goodGallery.slice(0, 8);
          const extra = goodGallery.slice(8);

          const id = buildStableId(seller, itemUrl);
          const slugBase = buildUniqueSlug(titleFinal || "item", seller, itemUrl);

          const shopForQ = String(job.shop || "").trim() || urlRaw;

          const row = padToLen(
            [
              id,
              slugBase,
              titleFinal || "Item",
              String(job.brand || "").trim(),
              String(job.category || "OTHER").trim(),
              seller,
              img1to8[0] || "",
              img1to8[1] || "",
              img1to8[2] || "",
              img1to8[3] || "",
              img1to8[4] || "",
              img1to8[5] || "",
              img1to8[6] || "",
              img1to8[7] || "",
              extra.length ? extra.join(", ") : "",
              "ok",
              shopForQ,
              itemUrl,
              priceCny != null ? String(priceCny) : "",
              "",
            ],
            20
          );

          await upsertRow({
            byKey,
            existingSlugs,
            pendingAppends,
            pendingUpdates,
            seller,
            itemUrl,
            row,
            doneKey,
          });

          totalProcessed++;
          if (totalProcessed % FLUSH_EVERY === 0) await flushToSheet(false);
        }

        await flushToSheet(false);
        pageNum += 1;
        hasNext = !!hasNextResp;
      }

      await flushToSheet(true);
      await page.close();
      console.log(`✅ Shop job done | processed=${totalProcessed}`);
    }

    await flushToSheet(true);
    console.log("\n✅ FINITO!");
  } catch (e) {
    console.error("❌ ERRORE:", String(e?.message || e));
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