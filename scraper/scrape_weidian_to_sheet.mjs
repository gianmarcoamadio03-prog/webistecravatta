"use strict";

import fs from "fs";
import path from "path";
import crypto from "node:crypto";
import dotenv from "dotenv";
import { google } from "googleapis";
import { chromium } from "playwright";
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
// CONFIG
// =====================
const VERSION = "2026-03-23 | weidian -> official sheet v3 images + title translate";

const SHEET_ID = (process.env.SHEET_ID || "").trim();
const SHEET_TAB = (process.env.SHEET_TAB || "items").trim();
const SERVICE_ACCOUNT_JSON = (
  process.env.GOOGLE_SERVICE_ACCOUNT_JSON || "./service-account.json"
).trim();

const NAV_TIMEOUT = Number(String(process.env.NAV_TIMEOUT || "90000").trim());
const REAL_UA =
  (process.env.USER_AGENT || "").trim() ||
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";
const ACCEPT_LANG = (process.env.ACCEPT_LANGUAGE || "it-IT,it;q=0.9,en;q=0.8").trim();

// traduzione titolo
const WEIDIAN_TRANSLATE_TITLE =
  String(process.env.WEIDIAN_TRANSLATE_TITLE || "1").trim() === "1";

const WEIDIAN_TRANSLATE_TO =
  (process.env.WEIDIAN_TRANSLATE_TO || "en").trim(); // en | it

if (!SHEET_ID) {
  console.error("❌ ERRORE: SHEET_ID mancante nel file .env.local");
  process.exit(1);
}

// cred JSON relativo al ROOT progetto
const absCredPath = path.isAbsolute(SERVICE_ACCOUNT_JSON)
  ? SERVICE_ACCOUNT_JSON
  : path.join(PROJECT_ROOT, SERVICE_ACCOUNT_JSON.replace(/^\.\//, ""));

if (!fs.existsSync(absCredPath)) {
  console.error("❌ ERRORE: File credenziali non trovato:", absCredPath);
  process.exit(1);
}

// =====================
// DEFAULT JOB
// =====================
const DEFAULTS = {
  MODE: "WEIDIAN_CLASSIFICATION",
  NAME: "AUTO",
  MAX_ITEMS: "0",
  NO_NEW_STOP: "4",
  HEADFUL: "1",
  CONCURRENCY: "2",
  OUTDIR: "out/weidian",
};

// =====================
// UTILS
// =====================
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function sha1(input) {
  return crypto.createHash("sha1").update(String(input)).digest("hex");
}

function slugify(input, maxLen = 95) {
  const out = String(input || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return out.slice(0, maxLen);
}

function normText(s) {
  return String(s || "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
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
  const itemId = parseItemId(source_url);
  if (itemId) return `${sid}-wd${itemId}`;
  return `${sid}-${sha1(source_url).slice(0, 10)}`;
}

function buildUniqueSlug(title, sellerName, source_url) {
  const sid = sellerKey(sellerName, source_url);
  const base = slugify(title || "item", 60) || "item";
  const itemId = parseItemId(source_url);
  const tail = itemId ? `wd${itemId}` : sha1(source_url).slice(0, 8);
  return slugify(`${base}-${sid}-${tail}`, 95);
}

function parseItemId(url) {
  const m =
    String(url).match(/[?&]itemID=(\d+)/i) ||
    String(url).match(/[?&]itemId=(\d+)/i) ||
    String(url).match(/[?&]itemid=(\d+)/i);
  return m?.[1] || "";
}

function parseJob(raw) {
  const job = { ...DEFAULTS };

  const text = String(raw || "").trim();
  if (!text) throw new Error("Job vuoto.");

  const parts = text.includes("|") ? text.split("|") : text.split(/\n+/g);

  for (const part of parts) {
    const row = String(part || "").trim();
    if (!row) continue;

    const idx = row.indexOf("=");
    if (idx === -1) continue;

    const key = row.slice(0, idx).trim().toUpperCase();
    const value = row.slice(idx + 1).trim();
    if (!key) continue;
    job[key] = value;
  }

  if (!job.SELLER) throw new Error("Manca SELLER");
  if (!job.MODE) throw new Error("Manca MODE");
  if (!job.URL) throw new Error("Manca URL");
  if (!job.CATEGORY) throw new Error("Manca CATEGORY");
  if (!job.BRAND) throw new Error("Manca BRAND");

  if (job.MODE === "WEIDIAN_CLASSIFICATION" && !job.TARGET_TAB) {
    throw new Error("Per MODE=WEIDIAN_CLASSIFICATION manca TARGET_TAB");
  }

  return job;
}

function loadJobsFromFile(filePath) {
  const abs = path.isAbsolute(filePath)
    ? filePath
    : path.join(PROJECT_ROOT, filePath.replace(/^\.\//, ""));

  if (!fs.existsSync(abs)) {
    console.error("❌ Jobs file non trovato:", abs);
    process.exit(1);
  }

  const txt = fs.readFileSync(abs, "utf-8");
  const lines = txt.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);

  const jobs = [];
  for (const line of lines) {
    if (!line || line.startsWith("#")) continue;
    jobs.push(parseJob(line));
  }
  return jobs;
}

function parseArgs(argv) {
  const args = {
    job: "",
    file: "",
  };

  const list = [...argv];
  for (let i = 2; i < list.length; i++) {
    const a = list[i];
    if (a === "--file") args.file = String(list[++i] || "");
    else if (!args.job) args.job = a;
  }

  return args;
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function hasCjk(text) {
  return /[\u3400-\u9fff]/.test(String(text || ""));
}

async function translateText(raw, targetLang = "en") {
  const text = String(raw || "").trim();
  if (!text) return "";
  if (!hasCjk(text)) return text;

  try {
    const url =
      "https://translate.googleapis.com/translate_a/single" +
      `?client=gtx&sl=auto&tl=${encodeURIComponent(targetLang)}` +
      `&dt=t&q=${encodeURIComponent(text)}`;

    const res = await fetch(url, {
      headers: {
        "user-agent": REAL_UA,
        "accept-language": ACCEPT_LANG,
      },
    });

    if (!res.ok) return text;

    const data = await res.json();
    const translated = Array.isArray(data?.[0])
      ? data[0].map((x) => String(x?.[0] || "")).join("").trim()
      : "";

    return translated || text;
  } catch {
    return text;
  }
}

// =====================
// GOOGLE SHEETS
// =====================
function getSheetsClient() {
  const credentials = JSON.parse(fs.readFileSync(absCredPath, "utf-8"));
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  return google.sheets({ version: "v4", auth });
}

async function getIdRowCount(sheets) {
  const range = `${sheetA1Tab(SHEET_TAB)}!A2:A`;
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range,
  });
  const values = res.data.values || [];
  return values.length;
}

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
  if (!s) s = fallbackId ? `item-${fallbackId}` : `item-${Date.now()}`;

  if (!existingSlugs.has(s)) return s;

  if (fallbackId) {
    const withId = `${s}-${fallbackId}`;
    if (!existingSlugs.has(withId)) return withId;
  }

  let n = 2;
  while (existingSlugs.has(`${s}-${n}`)) n++;
  return `${s}-${n}`;
}

async function loadExistingIndex(sheets) {
  const count = await getIdRowCount(sheets);
  if (count <= 0) {
    return {
      existingSlugs: new Set(),
      nameCounters: new Map(),
      byKey: new Map(),
      nextAppendRow: 2,
    };
  }

  const lastRow = count + 1;
  const range = `${sheetA1Tab(SHEET_TAB)}!A2:T${lastRow}`;
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range,
  });
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

    const sourceUrl = String(row[16] || "").trim(); // Q
    const key = sourceUrl ? `${seller}||${sourceUrl}` : "";
    if (key) byKey.set(key, { rowNumber, rowValues: row });
  }

  return {
    existingSlugs,
    nameCounters,
    byKey,
    nextAppendRow: count + 2,
  };
}

async function batchUpdateRows(sheets, updates, batchSize = 50) {
  if (!updates.length) return;

  const batches = Math.ceil(updates.length / batchSize);
  console.log(`\n🧾 UPDATE su Sheet in ${batches} batch...`);

  for (let i = 0; i < batches; i++) {
    const slice = updates.slice(i * batchSize, (i + 1) * batchSize);

    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: SHEET_ID,
      requestBody: { valueInputOption: "RAW", data: slice },
    });

    console.log(`✅ UPDATE Batch ${i + 1}/${batches} (${slice.length} righe)`);
    await sleep(200);
  }
}

async function writeRowsInBatches_ByExplicitRow(
  sheets,
  rows,
  startRow,
  batchSize = 50
) {
  if (!rows.length) return startRow;

  const batches = Math.ceil(rows.length / batchSize);
  console.log(
    `\n🧾 APPEND su Sheet in ${batches} batch a partire da riga ${startRow}...`
  );

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

    console.log(`✅ APPEND Batch ${i + 1}/${batches} (${slice.length} righe) -> ${range}`);
    cur = endRow + 1;
    await sleep(200);
  }

  return cur;
}

// =====================
// WEIDIAN NAV HELPERS
// =====================
async function safeGoto(page, url, label = "goto") {
  for (let i = 1; i <= 3; i++) {
    try {
      console.log(`🌐 ${label} (${i}/3): ${url}`);
      await page.goto(url, {
        waitUntil: "domcontentloaded",
        timeout: NAV_TIMEOUT,
      });
      await sleep(1800);
      return;
    } catch (e) {
      console.warn(`⚠️ ${label} fail (${i}/3): ${url}`);
      console.warn(`   -> ${String(e?.message || e)}`);
      if (i === 3) throw e;
      await sleep(1500 * i);
    }
  }
}

async function createMobilePage(browser) {
  const context = await browser.newContext({
    viewport: { width: 430, height: 932 },
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 2,
    userAgent:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
    locale: "en-US",
    extraHTTPHeaders: { "accept-language": ACCEPT_LANG },
  });

  const page = await context.newPage();
  page.setDefaultTimeout(30000);
  return { context, page };
}

async function dismissWeidianNoise(page) {
  await sleep(1200);

  try {
    await page.evaluate(() => {
      const texts = ["close", "chiudi", "×", "x"];
      const els = Array.from(document.querySelectorAll("button, div, span, i"));
      for (const el of els) {
        const t = (el.textContent || "").trim().toLowerCase();
        if (!t) continue;
        if (texts.includes(t) && el instanceof HTMLElement) {
          const r = el.getBoundingClientRect();
          if (r.width <= 60 && r.height <= 60) {
            el.click();
            break;
          }
        }
      }
    });
  } catch {}
}

async function clickTargetTab(page, targetTab) {
  const wanted = normText(targetTab);

  console.log(`🎯 Cerco tab Weidian: "${targetTab}"`);

  try {
    const loc = page.getByText(targetTab, { exact: false }).first();
    if (await loc.isVisible({ timeout: 3000 })) {
      await loc.click({ timeout: 5000 });
      await sleep(1800);
      console.log(`✅ Tab cliccata via getByText: ${targetTab}`);
      return true;
    }
  } catch {}

  const clicked = await page.evaluate((wantedInner) => {
    function norm(s) {
      return String(s || "")
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase();
    }

    const candidates = Array.from(
      document.querySelectorAll("div, span, a, button")
    )
      .map((el) => {
        const text = norm(el.textContent || "");
        if (!text) return null;
        const rect = el.getBoundingClientRect();
        if (rect.width < 30 || rect.height < 18) return null;
        return { el, text };
      })
      .filter(Boolean);

    const exact = candidates.find((x) => x.text === wantedInner);
    if (exact) {
      exact.el.click();
      return true;
    }

    const partial = candidates.find(
      (x) => x.text.includes(wantedInner) || wantedInner.includes(x.text)
    );
    if (partial) {
      partial.el.click();
      return true;
    }

    return false;
  }, wanted);

  if (clicked) {
    await sleep(1800);
    console.log(`✅ Tab cliccata via DOM fallback: ${targetTab}`);
    return true;
  }

  console.warn(`❌ Tab non trovata: ${targetTab}`);
  return false;
}

async function collectVisibleItemUrls(page) {
  return await page.evaluate(() => {
    const out = new Set();

    const allAnchors = Array.from(document.querySelectorAll("a[href]"));
    for (const a of allAnchors) {
      const href = a.getAttribute("href") || "";
      if (/item\.html\?itemID=\d+/i.test(href) || /[?&]itemID=\d+/i.test(href)) {
        try {
          out.add(new URL(href, location.href).toString());
        } catch {}
      }
    }

    const nodes = Array.from(document.querySelectorAll("a, div, li, section"));
    for (const el of nodes) {
      const html = el.outerHTML || "";
      const matches =
        html.match(/https?:\/\/[^"' ]*item\.html\?itemID=\d+[^"' ]*/gi) || [];
      for (const m of matches) out.add(m);

      const rels = html.match(/\/item\.html\?itemID=\d+[^"' ]*/gi) || [];
      for (const m of rels) {
        try {
          out.add(new URL(m, location.href).toString());
        } catch {}
      }
    }

    return Array.from(out);
  });
}

async function findBestScrollable(page) {
  return await page.evaluate(() => {
    const all = Array.from(document.querySelectorAll("*"));

    const candidates = all
      .map((el) => {
        if (!(el instanceof HTMLElement)) return null;
        const style = window.getComputedStyle(el);
        const overflowY = style.overflowY;
        const canScroll =
          el.scrollHeight > el.clientHeight + 120 &&
          (overflowY === "auto" ||
            overflowY === "scroll" ||
            overflowY === "overlay");
        if (!canScroll) return null;

        const rect = el.getBoundingClientRect();
        if (rect.width < 200 || rect.height < 200) return null;

        const score =
          el.scrollHeight - el.clientHeight + rect.height + rect.width / 10;

        return { el, score };
      })
      .filter(Boolean)
      .sort((a, b) => b.score - a.score);

    const best =
      candidates[0]?.el || document.scrollingElement || document.documentElement;

    best.setAttribute("data-weidian-scroll-root", "1");
    return true;
  });
}

async function scrollOneStep(page) {
  return await page.evaluate(() => {
    const el =
      document.querySelector("[data-weidian-scroll-root='1']") ||
      document.scrollingElement ||
      document.documentElement;

    const beforeTop = el.scrollTop;
    const step = Math.max(500, Math.floor(el.clientHeight * 0.85));
    el.scrollTop = Math.min(el.scrollTop + step, el.scrollHeight);

    return {
      beforeTop,
      afterTop: el.scrollTop,
      clientHeight: el.clientHeight,
      scrollHeight: el.scrollHeight,
    };
  });
}

async function collectAllItemUrlsFromCategory(page, opts = {}) {
  const maxItems = Number(opts.maxItems || 0);
  const noNewStop = Number(opts.noNewStop || 4);

  await findBestScrollable(page);

  const seen = new Set();
  let noNewCount = 0;
  let round = 0;

  while (true) {
    round += 1;

    const urls = await collectVisibleItemUrls(page);
    let addedThisRound = 0;

    for (const url of urls) {
      if (!seen.has(url)) {
        seen.add(url);
        addedThisRound += 1;
      }
    }

    console.log(
      `🔎 round ${round} | visibili=${urls.length} | totali unici=${seen.size} | nuovi=${addedThisRound}`
    );

    if (maxItems > 0 && seen.size >= maxItems) {
      console.log(`🛑 Stop per MAX_ITEMS=${maxItems}`);
      break;
    }

    const before = seen.size;

    await scrollOneStep(page);
    await sleep(1800);

    const urlsAfter = await collectVisibleItemUrls(page);
    for (const url of urlsAfter) {
      if (!seen.has(url)) seen.add(url);
    }

    const after = seen.size;

    if (after === before) {
      noNewCount += 1;
      console.log(`⏳ Nessun nuovo item (${noNewCount}/${noNewStop})`);
    } else {
      noNewCount = 0;
    }

    if (noNewCount >= noNewStop) {
      console.log(`✅ Fine categoria: non compaiono nuovi item.`);
      break;
    }

    if (round >= 300) {
      console.log(`🛑 Stop sicurezza: round limite raggiunto.`);
      break;
    }
  }

  return Array.from(seen);
}

// =====================
// FORCE LOAD ALL PRODUCT IMAGES
// =====================
async function forceLoadAllItemImages(page) {
  let prevCount = -1;
  let stableRounds = 0;

  for (let round = 1; round <= 18; round++) {
    await page.evaluate(async () => {
      const delay = (ms) => new Promise((r) => setTimeout(r, ms));
      const root = document.scrollingElement || document.documentElement;

      const total = root.scrollHeight;
      const step = Math.max(500, Math.floor(window.innerHeight * 0.9));

      let y = 0;
      while (y < total) {
        window.scrollTo(0, y);
        await delay(220);
        y += step;
      }

      window.scrollTo(0, root.scrollHeight);
      await delay(500);
    });

    await page.waitForTimeout(900);

    const counts = await page.evaluate(() => {
      const detail = document.querySelectorAll("#dContainer img.d-image, #dContainer img, img.d-image").length;
      const gallery = document.querySelectorAll("img.item-img, .wd-swipe-item img, .v-com-vui-image__img").length;
      const all = document.querySelectorAll("img").length;
      return { detail, gallery, all };
    });

    const currentCount = counts.detail + counts.gallery;

    console.log(
      `🧩 load round ${round} | detail=${counts.detail} | gallery=${counts.gallery} | all=${counts.all}`
    );

    if (currentCount === prevCount) {
      stableRounds += 1;
    } else {
      stableRounds = 0;
      prevCount = currentCount;
    }

    if (stableRounds >= 2) {
      break;
    }
  }

  try {
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(400);
  } catch {}
}

// =====================
// ITEM EXTRACTION
// =====================
async function extractItemData(page, url) {
  await safeGoto(page, url, "item");
  await dismissWeidianNoise(page);

  try {
    await page.evaluate(() => window.scrollTo(0, 250));
    await sleep(500);
    await page.evaluate(() => window.scrollTo(0, 0));
    await sleep(500);
  } catch {}

  await forceLoadAllItemImages(page);

  const data = await page.evaluate(() => {
    function txt(s) {
      return String(s || "").replace(/\s+/g, " ").trim();
    }

    function abs(src) {
      try {
        return new URL(src, location.href).toString();
      } catch {
        return "";
      }
    }

    function cleanImgUrl(src) {
      return String(src || "")
        .replace(/([?&](w|h|width|height|cp)=[^&]+)/gi, "")
        .replace(/([?&]x-oss-process=[^&]+)/gi, "")
        .replace(/([?&]webp=[^&]+)/gi, "")
        .replace(/([?&]jpg=[^&]+)/gi, "")
        .replace(/([?&]png=[^&]+)/gi, "")
        .replace(/\?$/, "");
    }

    function pickImgSrc(el) {
      if (!el) return "";

      const attrs = [
        "src",
        "currentSrc",
        "data-src",
        "data-origin",
        "data-original",
        "data-lazy-src",
        "data-lazyload",
        "data-lazy-img",
        "data-url",
      ];

      for (const k of attrs) {
        try {
          let v = "";
          if (k === "currentSrc" && "currentSrc" in el) {
            v = el.currentSrc || "";
          } else if (k === "src") {
            v = el.currentSrc || el.src || "";
          } else if (typeof el.getAttribute === "function") {
            v = el.getAttribute(k) || "";
          }

          const s = String(v || "").trim();
          if (s) return abs(s);
        } catch {}
      }

      return "";
    }

    function pushImage(arr, src, bucket, order, area = 0) {
      const s = abs(src);
      if (!s) return;

      const lower = s.toLowerCase();
      const bad = [
        "logo",
        "icon",
        "avatar",
        "coupon",
        "qrcode",
        "qr",
      ];
      if (bad.some((x) => lower.includes(x))) return;

      arr.push({
        src: s,
        bucket,
        order,
        area,
      });
    }

    const pageText = txt(document.body?.innerText || "");
    const priceMatch = pageText.match(/¥\s*([0-9]+(?:\.[0-9]+)?)/);
    const price = priceMatch?.[1] || "";

    const blacklist = [
      "open the weidian app",
      "log in",
      "buy it now",
      "add to the cart",
      "shopping cart",
      "contact the store",
      "collect",
      "please select model",
      "front page",
      "classification",
      "customer service",
      "coupon",
      "instant discount",
      "pre-purchase instructions",
      "report",
    ];

    const textCandidates = Array.from(
      document.querySelectorAll("h1, h2, h3, div, span, p")
    )
      .map((el) => {
        const text = txt(el.textContent || "");
        if (!text) return null;
        if (text.length < 8 || text.length > 240) return null;

        const lower = text.toLowerCase();
        if (blacklist.some((b) => lower.includes(b))) return null;
        if (/^¥\s*[0-9]/.test(text)) return null;

        const rect = el.getBoundingClientRect();
        if (rect.width < 60 || rect.height < 16) return null;
        if (rect.top < 80 || rect.top > 2200) return null;

        const style = window.getComputedStyle(el);
        const fontSize = parseFloat(style.fontSize || "14") || 14;

        return { text, top: rect.top, fontSize };
      })
      .filter(Boolean)
      .sort((a, b) => {
        if (b.fontSize !== a.fontSize) return b.fontSize - a.fontSize;
        return a.top - b.top;
      });

    const originalTitle = txt(textCandidates[0]?.text || document.title || "");

    const found = [];

    const gallerySelectors = [
      "img.item-img",
      ".wd-swipe-item img",
      ".wd-swipe-item .item-img",
      ".v-com-vui-image__img",
      ".v-com-vui-image-preview__image img",
      ".v-com-vui-image-preview img",
    ];

    let order = 0;
    for (const sel of gallerySelectors) {
      const nodes = Array.from(document.querySelectorAll(sel));
      for (const node of nodes) {
        const src = pickImgSrc(node);
        if (!src) continue;

        const rect = node.getBoundingClientRect();
        const w = rect.width || node.naturalWidth || 0;
        const h = rect.height || node.naturalHeight || 0;
        if (w < 80 || h < 80) continue;

        pushImage(found, src, "gallery", order++, w * h);
      }
    }

    const detailSelectors = [
      "#dContainer img.d-image",
      "#dContainer img",
      ".d-container img",
      ".d-image",
      "img.d-image",
      "[data-spider-action-name='to_detail_activity'] img",
      "[data-spider='content-wrap'] img",
    ];

    let detailOrder = 0;
    for (const sel of detailSelectors) {
      const nodes = Array.from(document.querySelectorAll(sel));
      for (const node of nodes) {
        const src = pickImgSrc(node);
        if (!src) continue;

        const rect = node.getBoundingClientRect();
        const w = rect.width || node.naturalWidth || 0;
        const h = rect.height || node.naturalHeight || 0;
        if (w < 120 || h < 120) continue;

        pushImage(found, src, "detail", detailOrder++, w * h);
      }
    }

    let fallbackOrder = 0;
    const allImgs = Array.from(document.querySelectorAll("img"));
    for (const img of allImgs) {
      const src = pickImgSrc(img);
      if (!src) continue;

      const rect = img.getBoundingClientRect();
      const w = rect.width || img.naturalWidth || 0;
      const h = rect.height || img.naturalHeight || 0;
      if (w < 80 || h < 80) continue;

      pushImage(found, src, "fallback", fallbackOrder++, w * h);
    }

    const bucketPriority = { gallery: 0, detail: 1, fallback: 2 };

    found.sort((a, b) => {
      const ba = bucketPriority[a.bucket] ?? 9;
      const bb = bucketPriority[b.bucket] ?? 9;
      if (ba !== bb) return ba - bb;
      if (a.order !== b.order) return a.order - b.order;
      return b.area - a.area;
    });

    const images = [];
    const seen = new Set();

    for (const img of found) {
      const key = cleanImgUrl(img.src);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      images.push(img.src);
    }

    return {
      originalTitle,
      title: originalTitle,
      price,
      images: images.slice(0, 80),
    };
  });

  if (WEIDIAN_TRANSLATE_TITLE && data.title) {
    const translated = await translateText(data.title, WEIDIAN_TRANSLATE_TO);
    if (translated) data.title = translated;
  }

  console.log(`🖼️ immagini trovate: ${data.images?.length || 0}`);
  return data;
}

// =====================
// ROW BUILDER
// =====================
function makeRow(job, itemUrl, itemData) {
  const itemID = parseItemId(itemUrl) || sha1(itemUrl).slice(0, 12);

  let title = String(itemData.title || "").trim();
  if (!title) {
    title = `${String(job.BRAND || "").trim()} ${String(job.CATEGORY || "").trim()} ${itemID}`.trim();
  }

  const originalTitle = String(itemData.originalTitle || "").trim();
  const brand = String(job.BRAND || "").trim();
  const category = String(job.CATEGORY || "").trim();
  const seller = String(job.SELLER || "").trim();

  const images = Array.isArray(itemData.images) ? itemData.images : [];
  const imgSlots = Array.from({ length: 8 }, (_, i) => images[i] || "");
  const imgExtra = images.slice(8).join(" | ");

  const id = buildStableId(seller, itemUrl);
  const slug = buildUniqueSlug(title, seller, itemUrl);

  const tags =
    originalTitle && originalTitle !== title
      ? `orig_title=${originalTitle}`
      : "";

  return [
    id,                    // A id
    slug,                  // B slug
    title,                 // C title
    brand,                 // D brand
    category,              // E category
    seller,                // F seller
    imgSlots[0] || "",     // G img1
    imgSlots[1] || "",     // H img2
    imgSlots[2] || "",     // I img3
    imgSlots[3] || "",     // J img4
    imgSlots[4] || "",     // K img5
    imgSlots[5] || "",     // L img6
    imgSlots[6] || "",     // M img7
    imgSlots[7] || "",     // N img8
    imgExtra || "",        // O img_extra
    "ok",                  // P status
    itemUrl,               // Q source_url
    "",                    // R source/shop extra
    itemData.price || "",  // S source_price_cny
    tags,                  // T tags
  ];
}

// =====================
// CATEGORY / ITEMS
// =====================
async function getItemUrlsForJob(page, job) {
  if (job.MODE === "WEIDIAN_ITEM") {
    return [String(job.URL).trim()];
  }

  if (job.MODE !== "WEIDIAN_CLASSIFICATION") {
    throw new Error(`MODE non ancora supportato: ${job.MODE}`);
  }

  await safeGoto(page, job.URL, "classification");
  await dismissWeidianNoise(page);

  const ok = await clickTargetTab(page, job.TARGET_TAB);
  if (!ok) {
    throw new Error(`Target tab non trovata: ${job.TARGET_TAB}`);
  }

  return await collectAllItemUrlsFromCategory(page, {
    maxItems: Number(job.MAX_ITEMS || 0),
    noNewStop: Number(job.NO_NEW_STOP || 4),
  });
}

// =====================
// PROCESS + WRITE
// =====================
async function runJob(job, sheets, indexState) {
  console.log("\n------------------------------------");
  console.log("🚀 WEIDIAN JOB");
  console.log(`👤 Seller: ${job.SELLER}`);
  console.log(`🧭 Mode: ${job.MODE}`);
  console.log(`🔗 URL: ${job.URL}`);
  console.log(`🎯 Target tab: ${job.TARGET_TAB || "-"}`);
  console.log(`🏷️ Brand: ${job.BRAND}`);
  console.log(`📌 Category: ${job.CATEGORY}`);
  console.log(`📝 Name: ${job.NAME}`);
  console.log(`📦 MAX_ITEMS: ${job.MAX_ITEMS}`);
  console.log(`⚙️ CONCURRENCY: ${job.CONCURRENCY}`);
  console.log("------------------------------------\n");

  const browser = await chromium.launch({
    headless: String(job.HEADFUL || "1") === "1" ? false : true,
    slowMo: String(job.HEADFUL || "1") === "1" ? 80 : 0,
  });

  const { context, page } = await createMobilePage(browser);

  try {
    const itemUrls = await getItemUrlsForJob(page, job);
    console.log(`\n📦 Item trovati: ${itemUrls.length}\n`);

    const rows = [];
    const concurrency = Math.max(1, Number(job.CONCURRENCY || 2) || 2);

    const workerPages = [page];
    for (let i = 1; i < concurrency; i++) {
      const p = await context.newPage();
      p.setDefaultTimeout(30000);
      workerPages.push(p);
    }

    let cursor = 0;
    async function worker(workerId) {
      const p = workerPages[workerId];

      while (true) {
        const idx = cursor++;
        if (idx >= itemUrls.length) break;

        const itemUrl = String(itemUrls[idx] || "").trim();
        console.log(`\n🔎 Item ${idx + 1}/${itemUrls.length}`);
        console.log(`➡️ ${itemUrl}`);

        try {
          const itemData = await extractItemData(p, itemUrl);
          const row = makeRow(job, itemUrl, itemData);
          rows.push(row);

          console.log(
            `✅ ${row[0]} | ${row[2]} | ¥${row[18] || "N/D"} | imgs=${itemData.images?.length || 0}`
          );
        } catch (e) {
          console.warn(`⚠️ item skip: ${itemUrl}`);
          console.warn(`   -> ${String(e?.message || e)}`);
        }
      }
    }

    await Promise.all(workerPages.map((_, i) => worker(i)));

    for (let i = 1; i < workerPages.length; i++) {
      try {
        await workerPages[i].close();
      } catch {}
    }

    const outdir = path.resolve(PROJECT_ROOT, job.OUTDIR || DEFAULTS.OUTDIR);
    ensureDir(outdir);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const outJson = path.join(
      outdir,
      `${slugify(job.SELLER)}__${slugify(job.TARGET_TAB || "single")}__${slugify(job.CATEGORY)}__${stamp}.json`
    );
    fs.writeFileSync(outJson, JSON.stringify(rows, null, 2), "utf8");
    console.log(`\n💾 Debug JSON: ${outJson}`);

    const updates = [];
    const appends = [];

    for (const rowRaw of rows) {
      const row = padToLen(rowRaw, 20);
      const sellerLower = String(row[5] || "").trim().toLowerCase();
      const sourceUrl = String(row[16] || "").trim();
      const key = `${sellerLower}||${sourceUrl}`;

      const existing = indexState.byKey.get(key);

      if (existing && existing.rowNumber >= 2) {
        const prev = padToLen(existing.rowValues, 20);
        const next = [...row];

        const idPrev = String(prev[0] || "").trim();
        const slugPrev = String(prev[1] || "").trim();

        if (idPrev) next[0] = idPrev;
        if (slugPrev) next[1] = slugPrev;

        updates.push({
          range: `${sheetA1Tab(SHEET_TAB)}!A${existing.rowNumber}:T${existing.rowNumber}`,
          values: [next],
        });

        indexState.byKey.set(key, {
          rowNumber: existing.rowNumber,
          rowValues: next,
        });
      } else {
        const next = [...row];

        const rawSlug = String(next[1] || "").trim();
        const rawId = String(next[0] || "").trim();
        const uniqueSlug = makeUniqueSlug(rawSlug, rawId, indexState.existingSlugs);
        next[1] = uniqueSlug;
        indexState.existingSlugs.add(uniqueSlug);

        next[2] = makeUniqueNameForSeller(next[2], next[5], indexState.nameCounters);

        appends.push(next);
      }
    }

    if (updates.length) {
      await batchUpdateRows(sheets, updates, 50);
    }

    if (appends.length) {
      const startRow = indexState.nextAppendRow;
      indexState.nextAppendRow = await writeRowsInBatches_ByExplicitRow(
        sheets,
        appends,
        startRow,
        50
      );

      for (let i = 0; i < appends.length; i++) {
        const rowNumber = startRow + i;
        const row = appends[i];
        const sellerLower = String(row[5] || "").trim().toLowerCase();
        const sourceUrl = String(row[16] || "").trim();
        const key = `${sellerLower}||${sourceUrl}`;

        indexState.byKey.set(key, {
          rowNumber,
          rowValues: row,
        });
      }
    }

    console.log(`\n✅ SHEET DONE | update=${updates.length} | append=${appends.length}\n`);
  } finally {
    await context.close();
    await browser.close();
  }
}

// =====================
// MAIN
// =====================
async function main() {
  console.log("====================================");
  console.log("✅ Weidian -> Official Google Sheet");
  console.log("VERSION:", VERSION);
  console.log("ROOT:", PROJECT_ROOT);
  console.log("ENV:", path.join(PROJECT_ROOT, ".env.local"));
  console.log("SHEET_ID:", SHEET_ID);
  console.log("TAB:", SHEET_TAB);
  console.log("NAV_TIMEOUT(ms):", NAV_TIMEOUT);
  console.log("UA:", REAL_UA);
  console.log("🔐 Cred JSON:", absCredPath);
  console.log("🌐 Translate title:", WEIDIAN_TRANSLATE_TITLE ? "ON" : "OFF", `-> ${WEIDIAN_TRANSLATE_TO}`);
  console.log("====================================");

  const args = parseArgs(process.argv);

  if (!args.job && !args.file) {
    console.log("\n❌ Uso:");
    console.log(
      `node ./scraper/scrape_weidian_to_sheet.mjs "SELLER=TOP|MODE=WEIDIAN_CLASSIFICATION|URL=https://h5.weidian.com/decoration/shop-category/?userid=1836694635&spider_token=a13f|TARGET_TAB=Yeezy|CATEGORY=SNEAKERS|BRAND=YEEZY|NAME=AUTO|MAX_ITEMS=0|HEADFUL=1"`
    );
    console.log(
      `node ./scraper/scrape_weidian_to_sheet.mjs --file ./scraper/weidian_jobs.txt`
    );
    process.exit(0);
  }

  const jobs = args.file ? loadJobsFromFile(args.file) : [parseJob(args.job)];
  const sheets = getSheetsClient();
  const indexState = await loadExistingIndex(sheets);

  console.log(`\n🧩 Jobs caricati: ${jobs.length}`);
  if (args.file) console.log(`📄 File jobs: ${args.file}`);

  for (let i = 0; i < jobs.length; i++) {
    console.log(`\n========== JOB ${i + 1}/${jobs.length} ==========\n`);
    await runJob(jobs[i], sheets, indexState);
  }

  console.log("\n✅ FINITO!");
}

main().catch((err) => {
  console.error("\n❌ ERRORE FATALE:", err);
  process.exit(1);
});