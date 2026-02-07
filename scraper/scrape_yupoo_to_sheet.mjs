"use strict";

/**
 * scrape_yupoo_to_sheet.mjs
 *
 * ✅ Fix/upgrade principali:
 * - FIX URL DOPPIO: https://photo.yupoo.com//photo.yupoo.com/...
 * - Normalizzazione robusta photo.yupoo.com
 * - Cover: internal header cover match (key seller/hash)
 * - ✅ FIX PAGINAZIONE "a blocchi": segue la FRECCIA NEXT finché non è disabled
 *   (risolve il caso: numeri 1-5 visibili, ma esistono 6-10)
 * - ✅ DETECT TOTAL PAGES: supporta "Page 10 of 10" e "Page10of10"
 * - ✅ STOP ANTI "VUOTO" più sicuro: retry + scroll prima di fermarsi
 * - ✅ SUMMARY per JOB: pagine trovate/visitate + articoli estratti/caricati
 */

import fs from "fs";
import path from "path";
import dotenv from "dotenv";
import { google } from "googleapis";
import { chromium } from "playwright";
import { fileURLToPath } from "url";
import readline from "node:readline";

// =====================================================
// __dirname for ESM
// =====================================================
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// =====================================================
// DOTENV
// =====================================================
dotenv.config({ path: path.join(__dirname, "../.env.local") });

// =====================================================
// ENV
// =====================================================
const VERSION =
  "2026-02-04 | FIX-photo-doublehost | auth+prime-photo | rescue-567 | FIX-write-by-colA-id | FIX-internal-cover-match | FIX-category-next-arrow | FIX-total-pages(Page of / Page10of10) | STOP-empty-pages-retry | JOB-SUMMARY";

const SHEET_ID = process.env.SHEET_ID || "";
const SHEET_TAB = process.env.SHEET_TAB || "items";
const SERVICE_ACCOUNT_JSON =
  process.env.GOOGLE_SERVICE_ACCOUNT_JSON || "./service-account.json";

const NAV_TIMEOUT = Number(process.env.NAV_TIMEOUT || "90000");
const BETWEEN_ALBUMS_SLEEP = Number(process.env.BETWEEN_ALBUMS_SLEEP || "80");
const DEBUG_COVER = String(process.env.DEBUG_COVER || "") === "1";

// UA “reale”
const REAL_UA =
  process.env.USER_AGENT ||
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";
const ACCEPT_LANG = process.env.ACCEPT_LANGUAGE || "it-IT,it;q=0.9,en;q=0.8";

if (!SHEET_ID) {
  console.error("❌ ERRORE: SHEET_ID mancante nel file .env(.local)");
  process.exit(1);
}

const absCredPath = path.isAbsolute(SERVICE_ACCOUNT_JSON)
  ? SERVICE_ACCOUNT_JSON
  : path.join(process.cwd(), SERVICE_ACCOUNT_JSON);

if (!fs.existsSync(absCredPath)) {
  console.error("❌ ERRORE: File credenziali non trovato:", absCredPath);
  process.exit(1);
}

function sheetA1Tab(tab) {
  const safe = String(tab || "").replace(/'/g, "''");
  return `'${safe}'`;
}

console.log("====================================");
console.log("✅ Yupoo -> Google Sheet Scraper");
console.log("VERSION:", VERSION);
console.log("SHEET_ID:", SHEET_ID);
console.log("TAB:", SHEET_TAB);
console.log("NAV_TIMEOUT(ms):", NAV_TIMEOUT);
console.log("UA:", REAL_UA);
console.log("🔐 Cred JSON:", absCredPath);
console.log("====================================");

// =====================================================
// UTILS
// =====================================================
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function absPath(p) {
  const raw = String(p || "").trim();
  if (!raw) return "";
  return path.isAbsolute(raw) ? raw : path.join(process.cwd(), raw);
}

function waitEnter(promptText) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
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
 * - forza uid=1
 * - mantiene isSubCate/referrercate se presenti
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

async function safeGoto(
  page,
  url,
  { retries = 3, timeout = NAV_TIMEOUT, allowRestricted = false } = {}
) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const resp = await page
        .goto(url, { waitUntil: "domcontentloaded", timeout })
        .catch(() => null);
      const status = resp?.status?.() ?? 0;

      if ((status === 567 || status === 403) && !allowRestricted) {
        throw new Error(`Restricted Access (${status || "blocked"})`);
      }
      if (status >= 400 && status !== 567 && !allowRestricted) {
        throw new Error(`HTTP ${status}`);
      }

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
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h) ^ s.charCodeAt(i);
  }
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
// ✅ YUPOO PHOTO NORMALIZATION (FIX doublehost)
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

  const isBig = (u) => String(u || "").toLowerCase().includes("/big.");

  for (const x of Array.isArray(list) ? list : []) {
    const u = String(x || "").trim();
    if (!u) continue;

    // Per Yupoo dedupiamo per "seller/hash" così non raddoppiano (og:image, header, ecc.)
    const key = yupooImageKey(u) || u;

    if (!chosen.has(key)) {
      chosen.set(key, u);
      order.push(key);
      continue;
    }

    const prev = chosen.get(key);
    if (isBig(u) && !isBig(prev)) chosen.set(key, u);
  }

  for (const k of order) {
    const v = String(chosen.get(k) || "").trim();
    if (v) out.push(v);
  }

  return out;
}

// =====================================================
// ✅ AUTH: storageState + PRIME photo.yupoo.com
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
      const og =
        document.querySelector('meta[property="og:image"]')?.getAttribute("content") ||
        "";
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
  const sp = absPath(storagePath);
  if (sp && fs.existsSync(sp)) return sp;

  console.log("\n🔐 AUTH/SESSIONE richiesta (storageState non trovato).");
  console.log(
    "   Apro un browser visibile: risolvi eventuale blocco/captcha e poi premi INVIO."
  );
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
        await safeGoto(page, alb, {
          retries: 1,
          timeout: NAV_TIMEOUT,
          allowRestricted: true,
        });
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
// Weidian canonicalizer
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

// =====================================================
// Taobao canonicalizer + Source link picker
// (prende SOLO Taobao / Weidian / redirect Weidian)
// =====================================================
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

async function pickPreferredSourceUrl(context, rawLinks) {
  const links = dedupePreserveOrder(
    (rawLinks || []).map((x) => String(x || "").trim()).filter(Boolean)
  );

  // decodifica Yupoo /external?url=... -> link reale
  const decoded = links
    .map((u) => decodeYupooExternalUrl(u))
    .map((u) => String(u || "").trim());

  // 1) Weidian (diretto o decodificato)
  for (const u of decoded) {
    if (isWeidianItemUrl(u)) return canonicalizeWeidianItemUrl(u);
    if (u.includes("v.weidian.com/item.html")) return canonicalizeWeidianItemUrl(u);
  }

  // 2) Taobao (diretto o decodificato)
  for (const u of decoded) {
    if (isTaobaoItemUrl(u)) return canonicalizeTaobaoItemUrl(u);
  }

  // 3) Redirect short (solo se porta a Taobao/Weidian)
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
// Resolve short links
// =====================================================
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
// PRODUCT TYPE
// =====================================================
const ALLOWED_TYPES = new Set([
  "SNEAKERS","SHOES","SLIDES","JACKETS","COATS","VESTS","HOODIES","SWEATSHIRTS","SWEATERS","KNITWEAR",
  "TSHIRTS","SHIRTS","POLOS","PANTS","JEANS","SHORTS","TRACKSUITS","SETS","HATS","CAPS","BEANIES",
  "SCARVES","GLOVES","SOCKS","BAGS","BACKPACKS","CROSSBODY","WALLETS","ACCESSORIES","BELTS",
  "SUNGLASSES","WATCHES","JEWELRY","RINGS","BRACELETS","NECKLACES","EARRINGS","TECH","PHONE_CASES",
  "AIRPODS_CASES","GADGETS","GAMES","CONSOLES","CONTROLLERS","HOME","DECOR","LIGHTS","POSTERS",
  "SPORT","GYM","OUTDOOR","BEAUTY","FRAGRANCES","SKINCARE","HAIR","KIDS","PETS","UNDERWEAR",
  "UNDERPANTS","BOXERS","BRIEFS","TRUNKS","LINGERIE","BRA","SWIMWEAR","OTHER",
]);

function detectProductTypeFromTitle(titleRaw) {
  const t = normalizeForMatch(titleRaw);

  const rules = [
    { type: "BRA", re: /\bbra(s)?\b|\bbralette(s)?\b|\bpush\s*up\b|\bunderwire\b/ },
    { type: "LINGERIE", re: /\blingerie\b|\bnightgown\b|\bchemise\b|\bteddy\b|\bcorset\b/ },
    { type: "BOXERS", re: /\bboxer(s)?\b|\bboxer\s*brief(s)?\b/ },
    { type: "BRIEFS", re: /\bbrief(s)?\b/ },
    { type: "TRUNKS", re: /\btrunk(s)?\b/ },
    { type: "UNDERPANTS", re: /\bunderpants?\b|\bundershorts?\b/ },
    { type: "UNDERWEAR", re: /\bunderwear\b|\bundies\b|\bpanty\b|\bpanties\b|\bthong(s)?\b|\bjockstrap\b|\bintimo\b/ },
    { type: "SWIMWEAR", re: /\bswimwear\b|\bswimsuit(s)?\b|\bbikini(s)?\b|\bboardshort(s)?\b|\bswim\s*trunks?\b/ },
    { type: "SLIDES", re: /\bslides?\b|\bsandals?\b|\bflip\s*flops?\b|\bslippers?\b/ },
    { type: "SNEAKERS", re: /\bsneakers?\b|\btrainers?\b|\brunners?\b/ },
    { type: "SHOES", re: /\bshoes?\b|\bboots?\b|\bloafer(s)?\b|\bderby\b/ },
    { type: "SOCKS", re: /\bsocks?\b|\bsock\b/ },
    { type: "GLOVES", re: /\bgloves?\b/ },
    { type: "SCARVES", re: /\bscarf\b|\bscarves\b/ },
    { type: "JACKETS", re: /\bjacket(s)?\b|\bbomber\b|\bwindbreaker\b|\bvarsity\b|\bshell\b/ },
    { type: "COATS", re: /\bcoat(s)?\b|\btrench\b|\bparka\b/ },
    { type: "VESTS", re: /\bvest(s)?\b|\bgilet\b/ },
    { type: "HOODIES", re: /\bhoodie(s)?\b/ },
    { type: "SWEATSHIRTS", re: /\bsweatshirt(s)?\b|\bcrewneck\b/ },
    { type: "SWEATERS", re: /\bsweater(s)?\b|\bjumper(s)?\b/ },
    { type: "KNITWEAR", re: /\bknit(wear)?\b|\bcardigan\b/ },
    { type: "TSHIRTS", re: /\bt\s*-\s*shirt\b|\bt\s*shirt\b|\btshirt\b|\btee\b/ },
    { type: "POLOS", re: /\bpolo(s)?\b/ },
    { type: "SHIRTS", re: /\bshirt(s)?\b|\bbutton\s*up\b/ },
    { type: "JEANS", re: /\bjeans\b|\bdenim\b/ },
    { type: "SHORTS", re: /\bshort(s)?\b/ },
    { type: "PANTS", re: /\btrousers?\b|\bpants\b|\bjoggers?\b|\bsweatpants\b|\btrack\s*pants\b/ },
    { type: "TRACKSUITS", re: /\btracksuit(s)?\b/ },
    { type: "SETS", re: /\bset(s)?\b|\b2\s*pcs\b|\btwo\s*piece\b/ },
    { type: "BEANIES", re: /\bbeanie(s)?\b/ },
    { type: "CAPS", re: /\bcap(s)?\b|\bbaseball\s*cap\b/ },
    { type: "HATS", re: /\bhat(s)?\b|\bbucket\s*hat\b/ },
    { type: "CROSSBODY", re: /\bcrossbody\b|\bshoulder\s*bag\b/ },
    { type: "BACKPACKS", re: /\bbackpack(s)?\b/ },
    { type: "WALLETS", re: /\bwallet(s)?\b/ },
    { type: "BAGS", re: /\bbag(s)?\b|\btote\b|\bhandbag\b/ },
    { type: "BELTS", re: /\bbelt(s)?\b/ },
    { type: "SUNGLASSES", re: /\bsunglass(es)?\b|\bshades\b/ },
    { type: "WATCHES", re: /\bwatch(es)?\b/ },
  ];

  for (const r of rules) {
    if (r.re.test(t)) return r.type;
  }
  return "OTHER";
}

function buildDisplayName(titleRaw, brandOverride = "", forcedType = "") {
  const brand = String(brandOverride || "").trim();
  const forced = String(forcedType || "").trim().toUpperCase();

  const detected = detectProductTypeFromTitle(titleRaw);
  const finalType = forced && ALLOWED_TYPES.has(forced) ? forced : detected;

  const tr = String(titleRaw || "").trim();
  const noUsefulText = tr.length < 3;

  if (brand && (finalType === "OTHER" || noUsefulText)) return brand.toUpperCase();
  if (brand && finalType && finalType !== "OTHER") return `${brand.toUpperCase()} ${finalType}`;
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
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range,
  });
  const values = res.data.values || [];
  return values.length;
}

async function getNextAppendRowByIdColumn(sheets) {
  const n = await getIdRowCount(sheets);
  return n + 2;
}

async function loadExistingIndex(sheets) {
  const count = await getIdRowCount(sheets);
  if (count <= 0) {
    return {
      existingSlugs: new Set(),
      nameCounters: new Map(),
      byKey: new Map(),
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

    const yupooUrl = String(row[16] || "").trim();
    const key = yupooUrl ? `${seller}||${yupooUrl}` : "";
    if (key) byKey.set(key, { rowNumber, rowValues: row });
  }

  return { existingSlugs, nameCounters, byKey };
}

async function writeRowsInBatches_ByIdColumn(sheets, rows, batchSize = 50) {
  if (!rows.length) return;

  let startRow = await getNextAppendRowByIdColumn(sheets);

  const batches = Math.ceil(rows.length / batchSize);
  console.log(
    `\n🧾 WRITE su Sheet in ${batches} batch (size=${batchSize}) a partire da riga ${startRow}...`
  );

  for (let i = 0; i < batches; i++) {
    const slice = rows.slice(i * batchSize, (i + 1) * batchSize);
    const endRow = startRow + slice.length - 1;

    const range = `${sheetA1Tab(SHEET_TAB)}!A${startRow}:T${endRow}`;

    let attempt = 0;
    while (true) {
      try {
        await sheets.spreadsheets.values.update({
          spreadsheetId: SHEET_ID,
          range,
          valueInputOption: "RAW",
          requestBody: { values: slice },
        });

        console.log(
          `✅ WRITE Batch ${i + 1}/${batches} (${slice.length} righe) -> ${range}`
        );
        break;
      } catch (err) {
        attempt++;
        const msg = String(err?.message || err);
        if (msg.includes("Quota exceeded") && attempt <= 6) {
          const wait = 15000 * attempt;
          console.log(
            `⏳ Quota exceeded... retry tra ${wait / 1000}s (tentativo ${attempt}/6)`
          );
          await sleep(wait);
          continue;
        }
        throw err;
      }
    }

    startRow = endRow + 1;
    await sleep(250);
  }
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
          console.log(
            `⏳ Quota exceeded... retry tra ${wait / 1000}s (tentativo ${attempt}/6)`
          );
          await sleep(wait);
          continue;
        }
        throw err;
      }
    }
    await sleep(250);
  }
}

// =====================================================
// ✅ DETECT TOTAL PAGES (anche Page10of10)
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
      /page\d+of(\d+)/i,      // Page10of10
      /page\d+\/(\d+)/i,      // Page10/10
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
// ✅ NEXT PAGE (freccetta) - chiave per paginazione a blocchi
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
      for (const r of roots) {
        all.push(...Array.from(r.querySelectorAll("a")));
      }

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

      // primo candidato "next" NON disabilitato e con href
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
// SCRAPE: CATEGORY (AUTO PAGES) + cover map + summary pages
// =====================================================
async function scrapeCategory(
  context,
  categoryUrl,
  maxPagesCap = 0,
  storageAbsForRescue = "",
  primeUrlForRescue = ""
) {
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
          const m = style.match(
            /background-image\s*:\s*url\(["']?([^"')]+)["']?\)/i
          );
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
        try {
          hrefAbs = new URL(href, location.href).toString();
        } catch {}
        if (rawImg) {
          try {
            imgAbs = new URL(rawImg, location.href).toString();
          } catch {}
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
      if (imgAbs && !coverByAlbum.has(normAlbum)) {
        coverByAlbum.set(normAlbum, toHttpsUrl(imgAbs));
      }
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

    // start page=1
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

    // log “trovate” come info, ma NON ci fidiamo per fermarci
    console.log(
      `📚 Pagine totali (best-effort detector): ${pagesDetected}${
        cap ? ` | cap maxPages=${cap}` : ""
      }`
    );

    pagesVisited = 1;
    let current = 1;

    const c1 = await collectWithRetryIfEmpty();
    console.log(
      `📦 Album trovati finora: ${albumUrls.size} (page1 found=${c1.foundCount}, new=${c1.newCount})`
    );

    // ✅ LOOP: segue NEXT finché esiste (paginazione a blocchi 1-5, poi 6-10, ecc.)
    let safety = 0;
    while (true) {
      if (cap && current >= cap) break;

      // aggiorna detector mentre nav cambia (spesso su page10 mostra "Page 10 of 10")
      const detHere = await detectCategoryTotalPages(page).catch(() => 1);
      pagesDetected = Math.max(pagesDetected, detHere, current);

      const nextPage = await getNextPageNumberFromDom(page).catch(() => 0);
      if (!nextPage || nextPage <= current) break;

      // vai alla prossima pagina direttamente col parametro (più stabile)
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

      // se una pagina è davvero vuota anche dopo retry+scroll, stop
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

    // ultimo aggiornamento (se su ultima pagina appare finalmente il totale)
    const detEnd = await detectCategoryTotalPages(page).catch(() => 1);
    pagesDetected = Math.max(pagesDetected, detEnd, pagesVisited);

    console.log(
      `\n📌 CATEGORY DONE | pagesVisited=${pagesVisited} | pagesDetected(best)=${pagesDetected}${
        stoppedEarly ? " | STOP-EARLY" : ""
      }`
    );
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
// SCRAPE: ALBUM
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

async function scrapeAlbum(
  context,
  albumUrl,
  categoryOverride,
  seller,
  brand,
  img1Pick,
  coverUrlFromCategory,
  storageAbsForRescue = "",
  primeUrlForRescue = ""
) {
  const page = await context.newPage();

  async function extractAlbumPhotosRaw() {
    return page.evaluate(() => {
      const attrs = [
        "data-src",
        "data-origin-src",
        "data-original",
        "data-lazy",
        "data-lazy-src",
        "src",
      ];

      const normalize = (raw) => {
        const r = (raw || "").toString().trim();
        if (!r) return "";
        if (r === "about:blank") return "";
        if (r.startsWith("data:")) return "";

        if (r.startsWith("//")) return `https:${r}`;
        if (r.startsWith("/photo.yupoo.com/")) return `https://${r.slice(1)}`;
        if (r.startsWith("/")) return `https://photo.yupoo.com${r}`;

        try {
          return new URL(r, location.href).toString();
        } catch {
          return "";
        }
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

      const ogImg =
        document.querySelector('meta[property="og:image"]')?.getAttribute("content") ||
        "";
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

  try {
    const normAlbumUrl = normalizeAlbumUrl(albumUrl);

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

    const detectedType = detectProductTypeFromTitle(titleRaw);
    const finalCategory =
      categoryOverride && String(categoryOverride).trim()
        ? String(categoryOverride).trim().toUpperCase()
        : detectedType;

    const titleBase = buildDisplayName(titleRaw, brand, finalCategory);

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

// ✅ SOURCE LINK: prendi SOLO Taobao / Weidian / redirect (no agent links tipo acbuy)
const rawLinks = await page
  .evaluate(() => {
    return Array.from(document.querySelectorAll('a[href]'))
      .map((a) => a.getAttribute('href'))
      .filter(Boolean)
      .map((h) => {
        try {
          return new URL(h, location.href).toString();
        } catch {
          return null;
        }
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

    const orderedImages = dedupePreserveOrder(
      buildOrderedImages(imagesBig, img1Pick, coverSmart)
    );

    const img1to8 = orderedImages.slice(0, 8);
    const extra = orderedImages.slice(8);

    const brandCell = String(brand || "").trim();
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
    await page.close();
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
  const job = { url, brand: "", seller: "", maxPages: 0, category: "", img1: 0 };

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
  }

  return job;
}

function loadJobsFromFile(filePath) {
  const abs = path.isAbsolute(filePath) ? filePath : path.join(process.cwd(), filePath);
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
  }
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
    console.log(
      `node ./scraper/scrape_yupoo_to_sheet.mjs --auth --storage ./scraper/yupoo_state.json`
    );
    process.exit(0);
  }

  const storagePath =
    args.storage ||
    process.env.YUPOO_STORAGE_STATE ||
    path.join(__dirname, "yupoo_state.json");

  const storageAbs = absPath(storagePath);
  const jobPrimeUrl = (jobs?.[0]?.url || args.url || "https://www.yupoo.com/").trim();

  const headless = !args.headful;

  const sheets = getSheetsClient();
  const { existingSlugs, nameCounters, byKey } = await loadExistingIndex(sheets);

  const browser = await chromium.launch({ headless });
  let context = null;

  const global = {
    jobs: 0,
    albumsExtracted: 0,
    albumsOk: 0,
    albumsFail: 0,
    sheetAppend: 0,
    sheetUpdate: 0,
  };

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

    context.route("**/*", (route) => {
      const t = route.request().resourceType();
if (t === "font" || t === "media" || t === "image") return route.abort();
      return route.continue();
    });

    if (args.auth && !jobs && !args.url) {
      console.log("\n✅ Auth salvata. Ora puoi lanciare lo scraper con --storage.");
      return;
    }

    const rowsToAppend = [];
    const rowsToUpdate = [];

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
          },
        ];

    console.log(`\n🧩 Jobs caricati: ${jobList.length}`);
    if (args.file) console.log(`📄 File jobs: ${args.file}`);
    console.log("🔐 storageState:", storageAbs);

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

      if (!seller) {
        console.log("❌ ERRORE: seller mancante. Passa --seller o seller= nel jobs file.");
        continue;
      }

      const jobStats = {
        url,
        mode,
        seller,
        brand: brand || "(vuoto)",
        categoryOverride: categoryOverride || "(AUTO)",
        pagesDetected: 1,
        pagesVisited: 1,
        stoppedEarly: false,
        albumsExtracted: 0,
        albumsOk: 0,
        albumsFail: 0,
        sheetAppend: 0,
        sheetUpdate: 0,
      };

      console.log("\n------------------------------------");
      console.log(`🚀 Job ${j + 1}/${jobList.length}`);
      console.log("🔎 Modalità:", mode);
      console.log("🔗 URL:", url);
      console.log("🏷️ Brand:", brand || "(vuoto)");
      console.log("👤 Seller:", seller);
      console.log("📌 Category override:", categoryOverride || "(AUTO)");
      console.log("📄 maxPages:", maxPages ? `${maxPages} (CAP)` : "AUTO (tutte)");
      console.log(
        "🖼️ img1:",
        img1Pick > 0 ? `MANUAL #${img1Pick}` : "AUTO (internal cover -> fallback category)"
      );
      console.log("------------------------------------");

      let albumUrls = [];
      let coverByAlbum = new Map();

      if (mode === "CATEGORY") {
        const res = await scrapeCategory(context, url, maxPages, storageAbs, url);
        albumUrls = res.albumUrls;
        coverByAlbum = res.coverByAlbum;

        jobStats.pagesDetected = res.pagesDetected || 1;
        jobStats.pagesVisited = res.pagesVisited || 1;
        jobStats.stoppedEarly = !!res.stoppedEarly;

        albumUrls = Array.from(new Set(albumUrls.map(normalizeAlbumUrl)));
        jobStats.albumsExtracted = albumUrls.length;

        console.log(`\n🧾 Totale prodotti estratti: ${albumUrls.length}`);
        console.log(`🖼️  Cover categoria mappate (best effort): ${coverByAlbum.size}`);
      } else {
        albumUrls = [normalizeAlbumUrl(url)];
        jobStats.albumsExtracted = 1;
        jobStats.pagesDetected = 1;
        jobStats.pagesVisited = 1;
        console.log(`\n🧾 Totale prodotti estratti: 1`);
      }

      global.albumsExtracted += jobStats.albumsExtracted;

      for (let i = 0; i < albumUrls.length; i++) {
        const normUrl = normalizeAlbumUrl(albumUrls[i]);
        const coverUrl = coverByAlbum.get(normUrl) || "";

        let row;
        try {
          row = await scrapeAlbum(
            context,
            normUrl,
            categoryOverride,
            seller,
            brand,
            img1Pick,
            coverUrl,
            storageAbs,
            url
          );
          jobStats.albumsOk += 1;
          global.albumsOk += 1;
        } catch (err) {
          jobStats.albumsFail += 1;
          global.albumsFail += 1;
          console.log(`❌ FAIL album: ${normUrl}`);
          console.log(`   -> ${String(err?.message || err).split("\n")[0]}`);
          continue;
        }

        const sellerLower = String(seller).trim().toLowerCase();
        const yupooUrl = String(row[16] || "").trim();
        const key = yupooUrl ? `${sellerLower}||${yupooUrl}` : "";
        if (!key) continue;

        const existing = byKey.get(key);

        if (existing) {
          const prev = padToLen(existing.rowValues, 20);
          const idPrev = String(prev[0] || "").trim();
          const slugPrev = String(prev[1] || "").trim();

          const next = padToLen(row, 20);
          if (idPrev) next[0] = idPrev;
          if (slugPrev) next[1] = slugPrev;

          const range = `${sheetA1Tab(SHEET_TAB)}!A${existing.rowNumber}:T${existing.rowNumber}`;
          rowsToUpdate.push({ range, values: [next] });
          byKey.set(key, { rowNumber: existing.rowNumber, rowValues: next });

          jobStats.sheetUpdate += 1;
          global.sheetUpdate += 1;

          console.log(`🔁 UPDATE riga ${existing.rowNumber}: ${next[1]} | "${next[2]}"`);
        } else {
          const next = padToLen(row, 20);

          const rawSlug = String(next[1] || "").trim();
          const rawId = String(next[0] || "").trim();
          const uniqueSlug = makeUniqueSlug(rawSlug, rawId, existingSlugs);
          next[1] = uniqueSlug;
          existingSlugs.add(uniqueSlug);

          next[2] = makeUniqueNameForSeller(next[2], seller, nameCounters);

          rowsToAppend.push(next);

          jobStats.sheetAppend += 1;
          global.sheetAppend += 1;

          console.log(`✅ APPEND: ${next[1]} | "${next[2]}" | CAT="${next[4]}"`);
        }

        if (BETWEEN_ALBUMS_SLEEP > 0) await sleep(BETWEEN_ALBUMS_SLEEP);
      }

      console.log("\n================ JOB SUMMARY ================");
      console.log(`Seller: ${jobStats.seller}`);
      console.log(`Brand : ${jobStats.brand}`);
      console.log(`Mode  : ${jobStats.mode}`);
      console.log(`URL   : ${jobStats.url}`);
      if (jobStats.mode === "CATEGORY") {
        console.log(
          `Pagine: visited=${jobStats.pagesVisited} | detected(best)=${jobStats.pagesDetected}${
            jobStats.stoppedEarly ? " | STOP-EARLY" : ""
          }`
        );
      } else {
        console.log("Pagine: (album singolo) 1");
      }
      console.log(`Articoli/Album estratti : ${jobStats.albumsExtracted}`);
      console.log(`Album processati        : ok=${jobStats.albumsOk} | fail=${jobStats.albumsFail}`);
      console.log(`Sheet                   : append=${jobStats.sheetAppend} | update=${jobStats.sheetUpdate}`);
      console.log("============================================\n");
    }

    if (!rowsToUpdate.length && !rowsToAppend.length) {
      console.log("\n⚠️ Nessuna riga nuova da scrivere / aggiornare.");
      return;
    }

    await batchUpdateRows(sheets, rowsToUpdate, 50);
    await writeRowsInBatches_ByIdColumn(sheets, rowsToAppend, 50);

    console.log("\n✅ FINITO! Update + Write completati.");

    console.log("\n================ GLOBAL SUMMARY ================");
    console.log(`Jobs totali             : ${global.jobs}`);
    console.log(`Album estratti          : ${global.albumsExtracted}`);
    console.log(`Album processati        : ok=${global.albumsOk} | fail=${global.albumsFail}`);
    console.log(`Sheet                   : append=${global.sheetAppend} | update=${global.sheetUpdate}`);
    console.log("===============================================");
  } catch (err) {
    console.error("❌ ERRORE FATALE:", err);
  } finally {
    try {
      if (context) await context.close();
    } catch {}
    await browser.close();
  }
}

main();