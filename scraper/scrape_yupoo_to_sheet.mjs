"use strict";

/**
 * Yupoo / 1688 -> Google Sheet scraper
 *
 * File singolo e auto-contenuto.
 *
 * Novità rispetto alla versione precedente:
 * - Mappa colonne (COL) al posto degli indici numerici sparsi
 * - removeRedundantBrandPrefix ora funziona davvero
 * - gracefulExit chiude browser/context e usa exit code corretti
 * - --source e --dry-run disponibili anche da CLI
 * - AI usata SOLO per il brand (categoria = keyword strict) e con le stesse
 *   condizioni su Yupoo e su 1688
 * - breadcrumb estratto solo da selettori reali, mai su pagine 1688
 * - prezzo: segnali DOM letti solo se titolo/card non bastano
 * - prezzo: colonna T con valuta originale e tasso usato
 * - checkpoint e cache AI in JSONL append-only (con migrazione dai .json legacy)
 * - retry per singolo item + dead-letter file
 * - pagina worker ricreata se il target muore
 * - rate limit per host + VigorBuy con circuit breaker
 * - dry-run: nessuna scrittura sul Sheet
 */

import fs from "fs";
import path from "path";
import dotenv from "dotenv";
import { google } from "googleapis";
import { chromium } from "playwright";
import { fileURLToPath } from "url";
import readline from "node:readline";
import OpenAI from "openai";
import { createHash, randomUUID } from "node:crypto";

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
// VERSION
// =====================
const VERSION =
  "2026-10-07a | VigorBuy: header di sessione (client-id/token) + verifica link corto + token scaduto | Yupoo safe mode (1 worker) + serialized Restricted rescue + cooldown + photo cleanup";

// =====================
// ENV HELPERS
// =====================
function envStr(name, fallback = "") {
  const v = process.env[name];
  return v === undefined || v === null ? fallback : String(v).trim();
}

function envNum(name, fallback, { min = -Infinity, max = Infinity } = {}) {
  const raw = envStr(name, "");
  const n = raw === "" ? NaN : Number(raw);
  const v = Number.isFinite(n) ? n : fallback;
  return Math.min(max, Math.max(min, v));
}

function envBool(name, fallback = false) {
  const raw = envStr(name, "").toLowerCase();
  if (raw === "") return fallback;
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

// =====================
// CONFIG: SHEET
// =====================
const SHEET_ID = envStr("SHEET_ID");
const SHEET_TAB = envStr("SHEET_TAB", "items");

const SERVICE_ACCOUNT_JSON = envStr("GOOGLE_SERVICE_ACCOUNT_JSON", "./service-account.json");

// =====================
// CONFIG: BROWSER
// =====================
const NAV_TIMEOUT = envNum("NAV_TIMEOUT", 90000, { min: 10000 });
const BETWEEN_ALBUMS_SLEEP = envNum("BETWEEN_ALBUMS_SLEEP", 0, { min: 0 });
const DEBUG_COVER = envBool("DEBUG_COVER", false);

const REAL_UA =
  envStr("USER_AGENT") ||
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";
const ACCEPT_LANG = envStr("ACCEPT_LANGUAGE", "it-IT,it;q=0.9,en;q=0.8");

// =====================
// CONFIG: CONCORRENZA
// =====================
const SCRAPER_CONCURRENCY = Math.max(1, Math.floor(envNum("SCRAPER_CONCURRENCY", 2, { min: 1, max: 16 })));

// Limite di richieste simultanee PER HOST (Yupoo e 1688 hanno soglie diverse).
const SCRAPER_HOST_CONCURRENCY = Math.max(
  1,
  Math.floor(envNum("SCRAPER_HOST_CONCURRENCY", SCRAPER_CONCURRENCY, { min: 1, max: 16 }))
);

// Yupoo applica spesso limiti più aggressivi dei marketplace.
// Di default usiamo 1 solo worker Yupoo e una pausa tra album,
// lasciando invece SCRAPER_CONCURRENCY invariata per 1688/altri flussi.
const YUPOO_CONCURRENCY = Math.max(1, Math.floor(envNum("YUPOO_CONCURRENCY", 1, { min: 1, max: 4 })));
const YUPOO_BETWEEN_ALBUMS_SLEEP = Math.max(0, envNum("YUPOO_BETWEEN_ALBUMS_SLEEP", 3000, { min: 0 }));
const YUPOO_RESCUE_SETTLE_MS = Math.max(1000, envNum("YUPOO_RESCUE_SETTLE_MS", 3500, { min: 1000 }));
const YUPOO_RESCUE_COOLDOWN_MS = Math.max(3000, envNum("YUPOO_RESCUE_COOLDOWN_MS", 12000, { min: 3000 }));

// =====================
// CONFIG: FLUSH / RESUME
// =====================
const SCRAPER_SKIP_EXISTING = envBool("SCRAPER_SKIP_EXISTING", false);
const SCRAPER_FLUSH_EVERY = Math.max(1, Math.floor(envNum("SCRAPER_FLUSH_EVERY", 25, { min: 1 })));
const SCRAPER_RESUME = envBool("SCRAPER_RESUME", true);

const SCRAPER_CHECKPOINT_FILE = envStr("SCRAPER_CHECKPOINT_FILE", "./scraper/checkpoint.json");
const SCRAPER_AI_CACHE_FILE = envStr("SCRAPER_AI_CACHE_FILE", "./scraper/ai_cache.json");
const SCRAPER_FAILED_FILE = envStr("SCRAPER_FAILED_FILE", "./scraper/failed.jsonl");
const SCRAPER_DRYRUN_FILE = envStr("SCRAPER_DRYRUN_FILE", "./scraper/dry-run.jsonl");

// Quante entry accumulare prima di scrivere su disco la cache AI.
const SCRAPER_AI_CACHE_FLUSH_EVERY = Math.max(1, Math.floor(envNum("SCRAPER_AI_CACHE_FLUSH_EVERY", 20, { min: 1 })));

// =====================
// CONFIG: RETRY ITEM
// =====================
const SCRAPER_ITEM_RETRIES = Math.max(1, Math.floor(envNum("SCRAPER_ITEM_RETRIES", 2, { min: 1, max: 6 })));

// =====================
// CONFIG: AI IMAGE FETCH
// =====================
const SCRAPER_AI_ALLOW_PAGE_GOTO_FALLBACK = envBool("SCRAPER_AI_ALLOW_PAGE_GOTO_FALLBACK", false);
const SCRAPER_AI_ALLOW_SCREENSHOT_FALLBACK = envBool("SCRAPER_AI_ALLOW_SCREENSHOT_FALLBACK", false);
const SCRAPER_AI_MAX_BYTES = Math.max(200000, Math.floor(envNum("SCRAPER_AI_MAX_BYTES", 2500000, { min: 200000 })));

// =====================
// CONFIG: BACKOFF
// =====================
const SCRAPER_BACKOFF_BASE_MS = Math.max(0, envNum("SCRAPER_BACKOFF_BASE_MS", 0, { min: 0 }));
const SCRAPER_BACKOFF_MAX_MS = Math.max(2000, envNum("SCRAPER_BACKOFF_MAX_MS", 60000, { min: 2000 }));

// =====================
// CONFIG: PREZZI
// =====================
// Alcuni seller Yupoo scrivono i prezzi in USD (es. "32$") invece che in CNY.
// Il Google Sheet continua a ricevere source_price_cny in colonna S, mentre la
// colonna T conserva valuta originale e tasso usato per la conversione.
const SCRAPER_USD_CNY_RATE = Math.max(0.1, envNum("SCRAPER_USD_CNY_RATE", 7.1, { min: 0.1 }));
const SCRAPER_PRICE_DEBUG = envBool("SCRAPER_PRICE_DEBUG", true);
const SCRAPER_WRITE_PRICE_META = envBool("SCRAPER_WRITE_PRICE_META", true);

// =====================
// CONFIG: VIGORBUY
// =====================
const VIGORBUY_ENABLED = envBool("VIGORBUY_ENABLED", true);

// Referral usato per TUTTI i link VigorBuy generati.
const VIGORBUY_INVITE_CODE = envStr("VIGORBUY_INVITE_CODE", "nPxRowk9");

// Valori usati dal frontend VigorBuy per firmare lo shortener.
// Sono legati alla build del sito: quando cambia, si aggiorna da .env.local
// senza toccare questo file.
const VIGORBUY_SIGN_KEY = envStr("VIGORBUY_SIGN_KEY", "980683EF-46C6-47D5-80C1-7B2CB6B2D0BF");
const VIGORBUY_SIGN_VERSION = envStr("VIGORBUY_SIGN_VERSION", "vigorbuy-production-web-1.0");
const VIGORBUY_SHORTEN_API = envStr("VIGORBUY_SHORTEN_API", "https://api.vigorbuy.com/vigorbuy_wallet/pub/shorten/create");

// Contesto di sessione che il pulsante "Share" di VigorBuy invia allo shortener.
// Vanno SOLO in .env.local, mai nel codice: il token è legato a sessione/account
// e può cambiare dopo logout, pulizia dei dati del browser o refresh lato VigorBuy.
const VIGORBUY_CLIENT_ID = envStr("VIGORBUY_CLIENT_ID");
const VIGORBUY_TOKEN = envStr("VIGORBUY_TOKEN");

// Dopo la creazione il link corto viene risolto e confrontato con prodotto e
// inviteCode richiesti. Un link non verificato non viene scritto nel foglio.
const VIGORBUY_VERIFY = envBool("VIGORBUY_VERIFY", true);

const VIGORBUY_TIMEOUT_MS = Math.max(3000, envNum("VIGORBUY_TIMEOUT_MS", 15000, { min: 3000 }));
const VIGORBUY_RETRIES = Math.max(1, Math.floor(envNum("VIGORBUY_RETRIES", 3, { min: 1, max: 6 })));

// Dopo N fallimenti consecutivi disattiviamo VigorBuy per il resto della run:
// se l'API rifiuta tutto, insistere costa solo tempo.
const VIGORBUY_BREAKER_THRESHOLD = Math.max(1, Math.floor(envNum("VIGORBUY_BREAKER_THRESHOLD", 10, { min: 1 })));

// =====================
// CONFIG: AI DETECT
// =====================
const SCRAPER_DETECT_AI = envBool("SCRAPER_DETECT_AI", false);
const SCRAPER_DETECT_MODEL = envStr("SCRAPER_DETECT_MODEL", "gpt-4o-mini");
const SCRAPER_DETECT_IMAGE_DETAIL = envStr("SCRAPER_DETECT_IMAGE_DETAIL", "auto");
const SCRAPER_DETECT_MAX_OUTPUT_TOKENS = Math.max(40, Math.floor(envNum("SCRAPER_DETECT_MAX_OUTPUT_TOKENS", 180, { min: 40 })));
const SCRAPER_DETECT_RETRIES = Math.max(1, Math.floor(envNum("SCRAPER_DETECT_RETRIES", 2, { min: 1, max: 5 })));
const SCRAPER_DETECT_DEBUG = envBool("SCRAPER_DETECT_DEBUG", false);
const SCRAPER_OPENAI_API_KEY = envStr("SCRAPER_OPENAI_API_KEY") || envStr("OPENAI_API_KEY");

const SCRAPER_DETECT_EFFECTIVE = SCRAPER_DETECT_AI && !!SCRAPER_OPENAI_API_KEY;
const openai = SCRAPER_DETECT_EFFECTIVE ? new OpenAI({ apiKey: SCRAPER_OPENAI_API_KEY }) : null;

// Iniezione del modello scarpa nel titolo (default ON quando l'AI è attiva).
const SCRAPER_DETECT_SHOE_NAME = envBool("SCRAPER_DETECT_SHOE_NAME", true);

// =====================
// LAYOUT COLONNE SHEET
// =====================
/**
 * Unica fonte di verità per la struttura della riga.
 * Se aggiungi una colonna nel foglio, aggiorni SOLO questo blocco.
 */
const COL = {
  ID: 0,             // A
  SLUG: 1,           // B
  TITLE: 2,          // C
  BRAND: 3,          // D
  CATEGORY: 4,       // E
  SELLER: 5,         // F
  IMG1: 6,           // G
  IMG2: 7,           // H
  IMG3: 8,           // I
  IMG4: 9,           // J
  IMG5: 10,          // K
  IMG6: 11,          // L
  IMG7: 12,          // M
  IMG8: 13,          // N
  IMAGES_EXTRA: 14,  // O
  STATUS: 15,        // P
  SOURCE_URL: 16,    // Q  (album Yupoo / offer 1688)
  BUY_URL: 17,       // R  (VigorBuy per Weidian, altrimenti source originale)
  PRICE_CNY: 18,     // S
  PRICE_META: 19,    // T  (es. "USD 32 @7.10" oppure "CNY 208")
};

const IMG_COLS = [COL.IMG1, COL.IMG2, COL.IMG3, COL.IMG4, COL.IMG5, COL.IMG6, COL.IMG7, COL.IMG8];
const ROW_LEN = 20;
const SHEET_FIRST_COL = "A";
const SHEET_LAST_COL = "T";

// =====================
// VALIDAZIONI DI AVVIO
// =====================
if (!SHEET_ID) {
  console.error("❌ ERRORE: SHEET_ID mancante nel file .env.local (root progetto)");
  process.exit(1);
}

function absPathFromRoot(p) {
  const raw = String(p || "").trim();
  if (!raw) return "";
  return path.isAbsolute(raw) ? raw : path.join(PROJECT_ROOT, raw.replace(/^\.\//, ""));
}

const absCredPath = absPathFromRoot(SERVICE_ACCOUNT_JSON);

if (!fs.existsSync(absCredPath)) {
  console.error("❌ ERRORE: File credenziali non trovato:", absCredPath);
  process.exit(1);
}

function sheetA1Tab(tab) {
  const safe = String(tab || "").replace(/'/g, "''");
  return `'${safe}'`;
}

function sheetRange(startRow, endRow) {
  return `${sheetA1Tab(SHEET_TAB)}!${SHEET_FIRST_COL}${startRow}:${SHEET_LAST_COL}${endRow}`;
}

function logAiDebug(...args) {
  if (SCRAPER_DETECT_DEBUG) console.log("🧠 AI-DEBUG:", ...args);
}

console.log("====================================");
console.log("✅ Yupoo/1688 -> Google Sheet Scraper");
console.log("VERSION:", VERSION);
console.log("ROOT:", PROJECT_ROOT);
console.log("ENV:", path.join(PROJECT_ROOT, ".env.local"));
console.log("SHEET_ID:", SHEET_ID);
console.log("TAB:", SHEET_TAB);
console.log("NAV_TIMEOUT(ms):", NAV_TIMEOUT);
console.log("UA:", REAL_UA);
console.log("🔐 Cred JSON:", absCredPath);
console.log("⚡ CONCURRENCY:", SCRAPER_CONCURRENCY, "| per-host:", SCRAPER_HOST_CONCURRENCY);
console.log("🧊 YUPOO:", `workers=${YUPOO_CONCURRENCY}`, `| sleep=${YUPOO_BETWEEN_ALBUMS_SLEEP}ms`, `| rescue-settle=${YUPOO_RESCUE_SETTLE_MS}ms`);
console.log("⏩ SKIP_EXISTING(pre-open):", SCRAPER_SKIP_EXISTING ? "ON" : "OFF");
console.log("🧾 FLUSH_EVERY:", SCRAPER_FLUSH_EVERY);
console.log("🔁 ITEM_RETRIES:", SCRAPER_ITEM_RETRIES);
console.log("🤖 AI DETECT (global):", SCRAPER_DETECT_EFFECTIVE ? `ON (${SCRAPER_DETECT_MODEL})` : "OFF");
console.log("💱 USD->CNY:", SCRAPER_USD_CNY_RATE);
console.log("💰 PRICE DEBUG:", SCRAPER_PRICE_DEBUG ? "ON" : "OFF");
console.log(
  "🔗 VIGORBUY:",
  VIGORBUY_ENABLED
    ? `ON | invite=${VIGORBUY_INVITE_CODE} | client-id=${VIGORBUY_CLIENT_ID ? "ok" : "MANCANTE"} | token=${
        VIGORBUY_TOKEN ? `…${VIGORBUY_TOKEN.slice(-4)}` : "MANCANTE"
      } | verify=${VIGORBUY_VERIFY ? "ON" : "OFF"}`
    : "OFF"
);
if (VIGORBUY_ENABLED && (!VIGORBUY_CLIENT_ID || !VIGORBUY_TOKEN)) {
  console.log("⚠️ VIGORBUY: VIGORBUY_CLIENT_ID / VIGORBUY_TOKEN mancanti in .env.local: lo shortener potrebbe rifiutare le richieste.");
}
console.log("====================================");

// =====================
// UTILS GENERICI
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

function ensureDirFor(absFilePath) {
  const dir = path.dirname(absFilePath);
  if (dir && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
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

function normalizeForMatch(text) {
  let t = String(text || "").toLowerCase();
  t = t.normalize("NFKD");
  t = t.replace(/[\u2010-\u2012\u2013\u2014\u2212]/g, "-");
  t = t.replace(/[^\p{L}\p{N}\s-]+/gu, " ");
  t = t.replace(/\s+/g, " ").trim();
  return t;
}

function hash36(input) {
  const s = String(input || "");
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h) ^ s.charCodeAt(i);
  return (h >>> 0).toString(36);
}

function padToLen(arr, len = ROW_LEN) {
  const out = Array.isArray(arr) ? [...arr] : [];
  while (out.length < len) out.push("");
  return out.slice(0, len);
}

function hostOf(url) {
  try {
    return new URL(String(url || "")).hostname.toLowerCase();
  } catch {
    return "unknown";
  }
}

function firstLine(msg) {
  return String(msg || "").split("\n")[0];
}

function dedupeStrings(list) {
  const seen = new Set();
  const out = [];
  for (const x of Array.isArray(list) ? list : []) {
    const v = String(x || "").trim();
    if (!v || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

// =====================
// MUTEX
// =====================
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

// Una sola procedura anti-Restricted alla volta. Evita che due worker
// aprano contemporaneamente due challenge sulla stessa sessione Yupoo.
const restrictedRescueMutex = createMutex();
let lastRestrictedRescueAt = 0;

// =====================
// BACKOFF
// =====================
function createBackoff() {
  let streak = 0;

  return {
    onOk() {
      streak = Math.max(0, streak - 1);
    },
    async onFail(kind = "fail") {
      streak = Math.min(10, streak + (kind === "restricted" ? 2 : 1));
      const base = SCRAPER_BACKOFF_BASE_MS || 300;
      const exp = Math.min(SCRAPER_BACKOFF_MAX_MS, Math.round(base * Math.pow(2, streak - 1)));
      const jitter = Math.round(exp * (0.15 + Math.random() * 0.25));
      const wait = Math.min(SCRAPER_BACKOFF_MAX_MS, exp + jitter);
      console.log(`⏳ Backoff(${kind}) streak=${streak} -> sleep ${(wait / 1000).toFixed(1)}s`);
      await sleep(wait);
    },
    getStreak() {
      return streak;
    },
  };
}

// =====================
// RATE LIMIT PER HOST
// =====================
/**
 * Yupoo e 1688 non tollerano lo stesso ritmo. Con SCRAPER_CONCURRENCY globale
 * un job misto martellava entrambi allo stesso modo: questo gate limita le
 * richieste simultanee per singolo hostname.
 */
function createHostGate(limit) {
  const state = new Map();

  const get = (host) => {
    const h = String(host || "unknown");
    if (!state.has(h)) state.set(h, { active: 0, queue: [] });
    return state.get(h);
  };

  return {
    async acquire(host) {
      const s = get(host);
      if (s.active < limit) {
        s.active += 1;
        return;
      }
      await new Promise((resolve) => s.queue.push(resolve));
      s.active += 1;
    },
    release(host) {
      const s = get(host);
      s.active = Math.max(0, s.active - 1);
      const next = s.queue.shift();
      if (next) next();
    },
    async run(host, fn) {
      const h = String(host || "unknown");
      await this.acquire(h);
      try {
        return await fn();
      } finally {
        this.release(h);
      }
    },
  };
}

const hostGate = createHostGate(SCRAPER_HOST_CONCURRENCY);

// =====================
// STORE JSONL (append-only)
// =====================
/**
 * Checkpoint e cache AI erano riscritti interamente a ogni flush: con decine di
 * migliaia di item l'I/O diventava quadratico. Qui usiamo un log append-only,
 * compattato solo quando è cresciuto troppo.
 */
function jsonlPathFor(jsonPath) {
  const abs = absPathFromRoot(jsonPath);
  if (!abs) return "";
  return abs.replace(/\.json$/i, "") + ".jsonl";
}

function loadJsonlMap(absPath) {
  const map = new Map();
  if (!absPath || !fs.existsSync(absPath)) return map;

  let txt = "";
  try {
    txt = fs.readFileSync(absPath, "utf-8");
  } catch {
    return map;
  }

  for (const line of txt.split(/\r?\n/)) {
    const l = line.trim();
    if (!l) continue;
    try {
      const o = JSON.parse(l);
      if (!o || typeof o !== "object" || typeof o.k !== "string") continue;
      if (o.d) map.delete(o.k);
      else map.set(o.k, o.v);
    } catch {
      // riga corrotta (crash a metà scrittura): la ignoriamo e proseguiamo
    }
  }

  return map;
}

function appendJsonl(absPath, records) {
  if (!absPath || !records.length) return;
  ensureDirFor(absPath);
  const payload = records.map((r) => JSON.stringify(r)).join("\n") + "\n";
  fs.appendFileSync(absPath, payload, "utf-8");
}

function rewriteJsonl(absPath, map) {
  if (!absPath) return;
  ensureDirFor(absPath);
  const tmp = `${absPath}.tmp`;
  const lines = [];
  for (const [k, v] of map.entries()) lines.push(JSON.stringify({ k, v }));
  fs.writeFileSync(tmp, lines.length ? lines.join("\n") + "\n" : "", "utf-8");
  fs.renameSync(tmp, absPath);
}

function countJsonlLines(absPath) {
  if (!absPath || !fs.existsSync(absPath)) return 0;
  try {
    const txt = fs.readFileSync(absPath, "utf-8");
    return txt.split("\n").filter((l) => l.trim()).length;
  } catch {
    return 0;
  }
}

function createJsonlStore(jsonPath, legacyLoader) {
  const abs = jsonlPathFor(jsonPath);
  const legacyAbs = absPathFromRoot(jsonPath);

  let map = loadJsonlMap(abs);
  let lines = countJsonlLines(abs);

  // Migrazione one-shot dal vecchio formato .json monolitico.
  if (!map.size && legacyAbs && fs.existsSync(legacyAbs) && typeof legacyLoader === "function") {
    try {
      const legacy = JSON.parse(fs.readFileSync(legacyAbs, "utf-8"));
      const seeded = legacyLoader(legacy);
      if (seeded && seeded.size) {
        map = seeded;
        rewriteJsonl(abs, map);
        lines = map.size;
        console.log(`♻️  Migrato ${map.size} record da ${path.basename(legacyAbs)} a ${path.basename(abs)}`);
      }
    } catch {
      // legacy illeggibile: partiamo da zero, non è un errore bloccante
    }
  }

  let pending = [];

  return {
    path: abs,
    get size() {
      return map.size;
    },
    has(k) {
      return map.has(k);
    },
    get(k) {
      return map.get(k);
    },
    set(k, v) {
      map.set(k, v);
      pending.push({ k, v });
    },
    pendingCount() {
      return pending.length;
    },
    flush(force = false) {
      if (!pending.length) return;
      if (!force && pending.length < 1) return;

      try {
        appendJsonl(abs, pending);
        lines += pending.length;
        pending = [];

        // Compattazione quando il log è molto più grande dei dati utili.
        if (map.size > 0 && lines > map.size * 3 && lines > 500) {
          rewriteJsonl(abs, map);
          lines = map.size;
        }
      } catch (e) {
        console.log("⚠️ Store flush failed:", firstLine(e?.message || e));
      }
    },
  };
}

const checkpointStore = createJsonlStore(SCRAPER_CHECKPOINT_FILE, (legacy) => {
  const m = new Map();
  const done = legacy && typeof legacy === "object" ? legacy.done : null;
  if (done && typeof done === "object") {
    for (const k of Object.keys(done)) m.set(k, 1);
  }
  return m;
});

const aiStore = createJsonlStore(SCRAPER_AI_CACHE_FILE, (legacy) => {
  const m = new Map();
  const entries = legacy && typeof legacy === "object" ? legacy.entries : null;
  if (entries && typeof entries === "object") {
    for (const [k, v] of Object.entries(entries)) m.set(k, v);
  }
  return m;
});

console.log("💾 CHECKPOINT:", checkpointStore.path, "| resume:", SCRAPER_RESUME ? "ON" : "OFF", `| done=${checkpointStore.size}`);
console.log("💾 AI_CACHE:", aiStore.path, `| entries=${aiStore.size}`);

function setAiCache(k, v) {
  aiStore.set(k, v);
  if (aiStore.pendingCount() >= SCRAPER_AI_CACHE_FLUSH_EVERY) aiStore.flush(true);
}

function getAiCache(k) {
  return aiStore.get(k);
}

function hasAiCache(k) {
  return aiStore.has(k);
}

// =====================
// DEAD LETTER
// =====================
function recordFailedItem(entry) {
  const abs = absPathFromRoot(SCRAPER_FAILED_FILE);
  if (!abs) return;
  try {
    ensureDirFor(abs);
    fs.appendFileSync(abs, JSON.stringify({ ...entry, at: new Date().toISOString() }) + "\n", "utf-8");
  } catch {
    // il dead-letter non deve mai far cadere la run
  }
}

// =====================
// URL: YUPOO
// =====================
function extractAlbumId(url) {
  const m = String(url).match(/\/albums\/(\d+)/);
  return m ? m[1] : "";
}

function isCategoryUrl(url) {
  return /\/categories(?:\/\d+)?(?:[/?#]|$)/.test(String(url || ""));
}

function isAlbumUrl(url) {
  return /\/albums\/\d+/.test(String(url || ""));
}

/**
 * Normalizza l'url album:
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

    for (const k of ["isSubCate", "referrercate"]) {
      const v = u.searchParams.get(k);
      if (v !== null) out.searchParams.set(k, v);
    }

    out.searchParams.set("uid", "1");
    return out.toString();
  } catch {
    return url;
  }
}

// =====================
// URL: 1688
// =====================
function extract1688OfferId(url) {
  const s = String(url || "");
  const m = s.match(/\/offer\/(\d+)\.html/i);
  return m && m[1] ? m[1] : "";
}

function is1688OfferUrl(url) {
  try {
    const u = new URL(String(url || ""));
    if (!u.hostname.toLowerCase().includes("1688.com")) return false;
    return /\/offer\/\d+\.html/i.test(u.pathname);
  } catch {
    return false;
  }
}

function canonicalize1688OfferUrl(url) {
  const id = extract1688OfferId(url);
  if (!id) return String(url || "");
  return `https://detail.1688.com/offer/${id}.html`;
}

function is1688ShopOfferListUrl(url) {
  try {
    const u = new URL(String(url || ""));
    if (!u.hostname.toLowerCase().includes("1688.com")) return false;
    const p = u.pathname.toLowerCase();
    if (!p.includes("offerlist")) return false;
    return p.endsWith(".htm") || p.endsWith(".html");
  } catch {
    return false;
  }
}

// =====================
// URL: WEIDIAN / TAOBAO
// =====================
function extractWeidianItemId(url) {
  try {
    const u = new URL(url);
    if (!u.hostname.toLowerCase().includes("weidian.com")) return "";
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

function isWeidianItemUrl(url) {
  try {
    const u = new URL(url);
    if (!u.hostname.toLowerCase().includes("weidian.com")) return false;
    if (!/\/item\.html$/i.test(u.pathname)) return false;
    return !!extractWeidianItemId(url);
  } catch {
    return false;
  }
}

function extractTaobaoItemId(url) {
  try {
    const u = new URL(url);
    if (!u.hostname.toLowerCase().includes("taobao.com")) return "";
    const id = u.searchParams.get("id") || u.searchParams.get("itemId") || "";
    return String(id || "").trim();
  } catch {
    return "";
  }
}

function isTaobaoItemUrl(url) {
  try {
    const u = new URL(url);
    if (!u.hostname.toLowerCase().includes("taobao.com")) return false;
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

function isShortRedirectUrl(url) {
  try {
    const h = new URL(url).hostname.toLowerCase();
    return h === "k.youshop10.com" || h.endsWith(".youshop10.com") || h === "m.tb.cn";
  } catch {
    return false;
  }
}

/**
 * Chiave canonica dell'item, usata per checkpoint, dedup e indice Sheet.
 */
function normalizeItemUrl(url) {
  const s = String(url || "").trim();
  if (!s) return "";
  if (isAlbumUrl(s)) return normalizeAlbumUrl(s);
  if (is1688OfferUrl(s)) return canonicalize1688OfferUrl(s);
  return s;
}

function makeDoneKey(seller, itemUrl) {
  return `${String(seller || "").trim().toLowerCase()}||${normalizeItemUrl(String(itemUrl || "").trim())}`;
}

// =====================
// YUPOO: decoder redirect esterni
// =====================
function decodeYupooExternalUrl(href) {
  try {
    const u = new URL(href);
    if (!u.hostname.includes("yupoo.com")) return href;
    if (!u.pathname.includes("/external")) return href;

    const encoded = u.searchParams.get("url");
    if (!encoded) return href;

    let decoded = encoded;
    for (let i = 0; i < 4; i++) {
      try {
        const d = decodeURIComponent(decoded);
        if (d === decoded) break;
        decoded = d;
      } catch {
        break;
      }
    }

    return /^https?:\/\//i.test(decoded) ? decoded : href;
  } catch {
    return href;
  }
}

// =====================
// RISOLUZIONE SHORT LINK
// =====================
/**
 * HEAD prima di GET: per seguire un redirect non serve scaricare il body.
 * Alcuni server cinesi non supportano HEAD, quindi resta il fallback.
 */
async function resolveFinalUrl(context, url) {
  const start = String(url || "").trim();
  if (!start) return "";

  let final = start;
  const host = hostOf(start);

  await hostGate.run(host, async () => {
    try {
      const res = await context.request.head(start, { maxRedirects: 10, timeout: 15000 });
      const u = res.url();
      if (u) final = u;
    } catch {
      try {
        const res = await context.request.get(start, { maxRedirects: 10, timeout: 20000 });
        const u = res.url();
        if (u) final = u;
      } catch {
        // lasciamo l'url originale
      }
    }
  });

  // Alcuni short link risolvono solo lato client (JS redirect).
  if (isShortRedirectUrl(final)) {
    let p = null;
    try {
      p = await context.newPage();
      await safeGoto(p, final, { retries: 1, timeout: 30000, allowRestricted: true });
      await p.waitForTimeout(900);
      final = p.url() || final;
    } catch {
      // ignoriamo: torniamo comunque il best-effort
    } finally {
      if (p) {
        try {
          await p.close();
        } catch {}
      }
    }
  }

  return final;
}

// =====================
// NAVIGAZIONE
// =====================
async function safeGoto(page, url, { retries = 3, timeout = NAV_TIMEOUT, allowRestricted = false } = {}) {
  const host = hostOf(url);

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await hostGate.run(host, async () => {
        const resp = await page.goto(url, { waitUntil: "domcontentloaded", timeout }).catch(() => null);
        const status = resp?.status?.() ?? 0;

        if ((status === 567 || status === 403) && !allowRestricted) {
          throw new Error(`Restricted Access (${status || "blocked"})`);
        }
        if (status >= 400 && status !== 567 && !allowRestricted) throw new Error(`HTTP ${status}`);

        const blocked = await page
          .evaluate(() => {
            const t = (document.body?.innerText || "").toLowerCase();
            return (
              t.includes("restricted access") ||
              t.includes("access restricted") ||
              t.includes("forbidden") ||
              t.includes("denied") ||
              t.includes("访问受限") ||
              t.includes("异常访问") ||
              t.includes("安全验证") ||
              t.includes("captcha") ||
              t.includes("verify") ||
              t.includes("请登录") ||
              t.includes("登录")
            );
          })
          .catch(() => false);

        if (blocked && !allowRestricted) throw new Error("Restricted Access (html)");
        return true;
      });
    } catch (err) {
      const msg = String(err?.message || err);
      console.log(`⚠️ goto fail (${attempt}/${retries}): ${url}`);
      console.log(`   -> ${firstLine(msg)}`);

      const low = msg.toLowerCase();
      const isNetDown =
        low.includes("err_internet_disconnected") ||
        low.includes("enotfound") ||
        low.includes("econnreset") ||
        low.includes("timed out") ||
        low.includes("net::err");

      if (isNetDown) await sleep(Math.min(10000, 2500 * attempt));
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

// =====================
// IMMAGINI: YUPOO
// =====================
function fixPhotoDoubleHost(u) {
  let s = String(u || "").trim();
  if (!s) return "";
  s = s.replace(/^https?:\/\/photo\.yupoo\.com\/+photo\.yupoo\.com\//i, "https://photo.yupoo.com/");
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
  return fixPhotoDoubleHost(s);
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
    if (!(u.hostname || "").toLowerCase().includes("photo.yupoo.com")) return "";
    const parts = u.pathname.split("/").filter(Boolean);
    return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : "";
  } catch {
    return "";
  }
}

/**
 * Dedup preservando l'ordine, con preferenza:
 * file reale (/xxxx.jpg) > /big.jpg > altre varianti di dimensione.
 */
function dedupePreserveOrder(list) {
  const order = [];
  const chosen = new Map();

  const isSizeVariant = (u) => /\/(big|medium|small|thumb|square)\.(jpg|jpeg|png|webp)(\?.*)?$/i.test(String(u || ""));

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
    const prevIsVar = isSizeVariant(prev);
    const nextIsVar = isSizeVariant(u);

    if (prevIsVar && !nextIsVar) {
      chosen.set(key, u);
      continue;
    }

    if (prevIsVar && nextIsVar) {
      const prevIsBig = /\/big\./i.test(prev);
      const nextIsBig = /\/big\./i.test(u);
      if (nextIsBig && !prevIsBig) chosen.set(key, u);
    }
  }

  const out = [];
  for (const k of order) {
    const v = String(chosen.get(k) || "").trim();
    if (v) out.push(v);
  }
  return out;
}

// =====================
// IMMAGINI: 1688 / ALICDN
// =====================
function toHttpsMaybe(u) {
  let s = String(u || "").trim();
  if (!s) return "";
  if (s.startsWith("//")) s = `https:${s}`;
  return s;
}

function toBigAlicdnUrl(u) {
  let s = toHttpsMaybe(u);
  if (!s) return "";
  return s.replace(/_(\d+)x(\d+)\.(jpg|jpeg|png|webp)(\?.*)?$/i, ".$3$4");
}

function extractImageUrlsFromHtml(html) {
  const h = String(html || "");
  if (!h) return [];

  const out = [];
  const re = /https?:\/\/[^"'\\\s>]+?\.(?:jpg|jpeg|png|webp)(?:\?[^"'\\\s>]*)?/gi;
  let m;

  while ((m = re.exec(h)) !== null) {
    const u = String(m[0] || "").trim();
    if (!u) continue;
    if (!u.includes("alicdn.com") && !u.includes("1688img") && !u.includes("aliimg")) continue;
    out.push(u);
    if (out.length >= 120) break;
  }

  return out;
}

// =====================
// ORDINAMENTO IMMAGINI
// =====================
function reorderImagesForImg1(images, img1Pick) {
  const list = Array.isArray(images) ? [...images] : [];
  const pick = Number(img1Pick || 0);

  if (!list.length || !Number.isFinite(pick) || pick <= 0) return list;

  const idx = pick - 1;
  if (idx < 0 || idx >= list.length) return list;

  return [list[idx], ...list.filter((_, i) => i !== idx)];
}

function reorderImagesCoverFirst(images, coverUrl) {
  const list = Array.isArray(images) ? [...images] : [];
  const cover = String(coverUrl || "").trim();

  if (!cover || !list.length) return list;

  let idx = list.indexOf(cover);
  if (idx < 0) {
    const key = yupooImageKey(cover);
    if (key) idx = list.findIndex((u) => yupooImageKey(u) === key);
  }
  if (idx < 0) return list;

  return [list[idx], ...list.filter((_, i) => i !== idx)];
}

function buildOrderedImages(images, img1Pick, coverUrl) {
  if (Number(img1Pick || 0) > 0) return reorderImagesForImg1(images, img1Pick);
  return reorderImagesCoverFirst(images, coverUrl);
}

// =====================
// COVER
// =====================
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
          if (!v || v.startsWith("data:") || v === "about:blank") continue;
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

// =====================
// CATEGORIE
// =====================
/**
 * Nota: canonicalizeCategory converte gli spazi in "_" e i trattini in "_"
 * PRIMA del lookup, quindi qui le chiavi devono usare solo underscore.
 * Chiavi con trattino sarebbero irraggiungibili.
 */
const CATEGORY_ALIASES = {
  // Tops
  TSHIRT: "TSHIRTS",
  T_SHIRT: "TSHIRTS",
  TEE: "TSHIRTS",
  TEES: "TSHIRTS",
  LONG_SLEEVE: "LONGSLEEVES",
  LONG_SLEEVES: "LONGSLEEVES",
  LONG_SLEEVED: "LONGSLEEVES",
  LONGSLEEVE: "LONGSLEEVES",
  HOODIE: "HOODIES",
  SWEATSHIRT: "SWEATSHIRTS",
  CREWNECK: "SWEATSHIRTS",
  POLO: "POLOS",
  BLOUSE: "BLOUSES",
  SHIRT: "SHIRTS",
  TANK_TOP: "TANK_TOPS",
  CROP_TOP: "CROP_TOPS",
  BODYSUIT: "BODYSUITS",

  // Knit
  SWEATER: "SWEATERS",
  JUMPER: "SWEATERS",
  JUMPERS: "SWEATERS",
  PULLOVER: "SWEATERS",
  PULLOVERS: "SWEATERS",
  TURTLENECK: "SWEATERS",
  TURTLENECKS: "SWEATERS",
  MOCKNECK: "SWEATERS",
  MOCKNECKS: "SWEATERS",
  KNIT: "KNITWEAR",
  KNITS: "KNITWEAR",
  KNITTED: "KNITWEAR",
  CARDIGAN: "CARDIGANS",

  // Bottoms
  PANT: "PANTS",
  TROUSERS: "PANTS",
  JOGGER: "JOGGERS",
  SWEATPANT: "SWEATPANTS",
  JEAN: "JEANS",
  DENIM: "JEANS",
  SHORT: "SHORTS",
  SKIRT: "SKIRTS",
  LEGGING: "LEGGINGS",

  // Footwear
  SNEAKER: "SNEAKERS",
  SHOE: "SNEAKERS",
  SHOES: "SNEAKERS",
  TRAINER: "SNEAKERS",
  TRAINERS: "SNEAKERS",
  BOOT: "BOOTS",
  SANDAL: "SANDALS",
  SLIDE: "SLIDES",
  SLIPPER: "SLIDES",
  SLIPPERS: "SLIDES",
  LOAFER: "LOAFERS",
  MOCCASIN: "LOAFERS",
  MOCCASINS: "LOAFERS",

  // Outerwear
  JACKET: "JACKETS",
  COAT: "COATS",
  BOMBER: "BOMBERS",
  PARKA: "PARKAS",
  PUFFER: "PUFFERS",
  BLAZER: "BLAZERS",
  VEST: "VESTS",
  GILET: "VESTS",
  TRENCH: "TRENCH_COATS",
  TRENCH_COAT: "TRENCH_COATS",

  // Bags / leather
  BAG: "BAGS",
  HANDBAG: "BAGS",
  HANDBAGS: "BAGS",
  PURSE: "BAGS",
  PURSES: "BAGS",
  TOTE: "TOTE_BAGS",
  TOTE_BAG: "TOTE_BAGS",
  SHOULDER_BAG: "SHOULDER_BAGS",
  CROSSBODY_BAG: "CROSSBODY",
  BACKPACK: "BACKPACKS",
  DUFFLE: "DUFFLE_BAGS",
  DUFFLE_BAG: "DUFFLE_BAGS",
  WALLET: "WALLETS",
  CARDHOLDER: "CARDHOLDERS",
  CARD_HOLDER: "CARDHOLDERS",

  // Accessori
  SUNGLASS: "SUNGLASSES",
  GLASS: "SUNGLASSES",
  GLASSES: "SUNGLASSES",
  BELT: "BELTS",
  HAT: "HATS",
  CAP: "CAPS",
  BEANIE: "BEANIES",
  SCARF: "SCARVES",
  SCARFS: "SCARVES",
  SHAWL: "SCARVES",
  SHAWLS: "SCARVES",
  GLOVE: "GLOVES",
  TIE: "TIES",
  NECKTIE: "TIES",
  KEYCHAIN: "KEYCHAINS",
  WATCH: "WATCHES",
  RING: "RINGS",
  BRACELET: "BRACELETS",
  NECKLACE: "NECKLACES",
  EARRING: "EARRINGS",
  JEWELLERY: "JEWELRY",

  // One-piece
  DRESS: "DRESSES",
  JUMPSUIT: "JUMPSUITS",
  ROMPER: "ROMPERS",
  SUIT: "SUITS",
  TRACKSUIT: "TRACKSUITS",
  SET: "SETS",

  // Beauty
  PERFUME: "FRAGRANCES",
  PERFUMES: "FRAGRANCES",
  FRAGRANCE: "FRAGRANCES",
  COLOGNE: "FRAGRANCES",
  COLOGNES: "FRAGRANCES",

  // Intimo
  SOCK: "SOCKS",
  BOXER: "BOXERS",
  BRIEF: "BRIEFS",
  TRUNK: "TRUNKS",
  UNDERPANT: "UNDERPANTS",
  BRAS: "BRA",

  // Tech
  PHONE_CASE: "PHONE_CASES",
  AIRPODS_CASE: "AIRPODS_CASES",
};

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

function canonicalizeCategory(raw) {
  let s = String(raw || "").trim().toUpperCase();
  if (!s) return "";
  s = s.replace(/\s+/g, "_").replace(/[^A-Z0-9_/-]/g, "");
  s = s.replace(/-/g, "_");
  return CATEGORY_ALIASES[s] || s;
}

function fixCommonTyposForType(t) {
  let s = ` ${String(t || "")} `;

  // typo ricorrenti nei cataloghi Yupoo
  s = s.replace(/\bswearter(s)?\b/g, " sweater$1 ");
  s = s.replace(/\bswetear(s)?\b/g, " sweater$1 ");
  s = s.replace(/\blong[-\s]*sle+e+\b/g, " long sleeve ");
  s = s.replace(/\bscarfs?\b/g, " scarf ");
  s = s.replace(/\bsneakrs?\b/g, " sneakers ");
  s = s.replace(/\bsneekers?\b/g, " sneakers ");
  s = s.replace(/\bshooes?\b/g, " shoes ");
  s = s.replace(/\bt[-\s]*shirts?\b/g, " t-shirt ");

  return s.trim();
}

/*
 * CATEGORY AUTO — STRICT KEYWORD MODE
 *
 * 1. Categoria SOLO da parole chiave testuali.
 * 2. Priorità segnali: titolo > card categoria > breadcrumb > body.
 * 3. shoe/shoes => SEMPRE SNEAKERS (ma non "shoe bag", "shoe box"...).
 * 4. Keyword specifiche battono quelle generiche.
 * 5. Nessuna keyword => OTHER.
 * 6. L'AI non inventa mai la categoria.
 */
const CATEGORY_KEYWORD_RULES = [
  // FOOTWEAR — le categorie specifiche battono "shoes"
  { type: "CHELSEA_BOOTS", re: /\bchelsea\s*boots?\b/i },
  { type: "HIKING_BOOTS", re: /\bhiking\s*boots?\b|\btrekking\s*boots?\b/i },
  { type: "LOAFERS", re: /\bloafers?\b|\bmoccasins?\b|\bmocassini?\b/i },
  { type: "DERBIES", re: /\bderb(?:y|ies)\b/i },
  { type: "OXFORDS", re: /\boxfords?\b/i },
  { type: "HEELS", re: /\bhigh\s*heels?\b|\bheels?\b|\bdecollete\b/i },
  { type: "FLATS", re: /\bballet\s*flats?\b|\bballet\s*shoes?\b|\bflats?\b/i },
  { type: "MULES", re: /\bmules?\b/i },
  { type: "CLOGS", re: /\bclogs?\b/i },
  { type: "ESPADRILLES", re: /\bespadrilles?\b/i },
  { type: "SLIDES", re: /\bslides?\b|\bslippers?\b|\bciabatt(?:a|e)\b|拖鞋/i },
  { type: "SANDALS", re: /\bsandals?\b|\bflip[\s-]*flops?\b|\bsandali?\b|凉鞋/i },
  { type: "BOOTS", re: /\bboots?\b|\bstivali?\b|靴子?|短靴|长靴/i },

  // "shoe"/"shoes" => SNEAKERS, escluso quando è un accessorio per scarpe.
  {
    type: "SNEAKERS",
    re: /\bsneakers?\b|\btrainers?\b|\brunning\s*shoes?\b|\bfootball\s*shoes?\b|\bsoccer\s*shoes?\b|\bbasketball\s*shoes?\b|\bshoes?\b(?!\s*(?:bag|box|care|tree|rack|brush|lace|laces|cleaner|horn))|\bscarpe\b|运动鞋|球鞋|跑鞋|鞋子?/i,
  },

  // BAGS / PELLETTERIA
  { type: "TOTE_BAGS", re: /\btote\s*bags?\b|\bshopper\s*bags?\b/i },
  { type: "SHOULDER_BAGS", re: /\bshoulder\s*bags?\b/i },
  { type: "CROSSBODY", re: /\bcross[\s-]*body(?:\s*bags?)?\b/i },
  { type: "BACKPACKS", re: /\bbackpacks?\b|\brucksacks?\b|双肩包/i },
  { type: "DUFFLE_BAGS", re: /\bduff(?:el|le)\s*bags?\b|\bgym\s*bags?\b|\btravel\s*bags?\b/i },
  { type: "LUGGAGE", re: /\bluggage\b|\bsuitcases?\b|\btrolleys?\b|行李箱/i },
  { type: "WALLETS", re: /\bwallets?\b|\bportafogli(?:o)?\b|钱包/i },
  { type: "CARDHOLDERS", re: /\bcard[\s-]*holders?\b|卡包/i },
  { type: "BAGS", re: /\bhandbags?\b|\bbags?\b|\bpurses?\b|\bbors(?:a|e)\b|包包|手提包|包/i },

  // CALZE / INTIMO / MARE
  { type: "SOCKS", re: /\bsocks?\b|\bcalzini?\b|袜子|袜/i },
  { type: "HOSIERY", re: /\bhosiery\b|\btights?\b|\bpantyhose\b|\bcollant\b/i },
  { type: "BOXERS", re: /\bboxers?\b|\bboxer\s*shorts?\b/i },
  { type: "BRIEFS", re: /\bbriefs?\b/i },
  { type: "TRUNKS", re: /\btrunks?\b/i },
  { type: "UNDERPANTS", re: /\bunderpants?\b/i },
  { type: "UNDERWEAR", re: /\bunderwear\b|\bintimo\b|内衣/i },
  { type: "LINGERIE", re: /\blingerie\b/i },
  { type: "BRA", re: /\bbras?\b|\bbrassiere\b/i },
  { type: "SWIMWEAR", re: /\bswimwear\b|\bswimsuits?\b|\bbikini\b|\bcostume\s*da\s*bagno\b/i },

  // CAPPELLI / ACCESSORI
  { type: "BEANIES", re: /\bbeanies?\b|\bberretti?\b|\bknit\s*caps?\b/i },
  { type: "CAPS", re: /\bbaseball\s*caps?\b|\bsnapbacks?\b|\bcaps?\b/i },
  { type: "HATS", re: /\bhats?\b|\bcappelli?\b|帽子|帽/i },
  { type: "SCARVES", re: /\bscarves?\b|\bscarfs?\b|\bshawls?\b|\bfoulards?\b|\bsciarp(?:a|e)\b|围巾/i },
  { type: "GLOVES", re: /\bgloves?\b|\bguanti?\b|手套/i },
  { type: "BELTS", re: /\bbelts?\b|\bcinture?\b|腰带|皮带/i },
  { type: "TIES", re: /\bneckties?\b|\bties?\b|\bcravatt(?:a|e)\b|领带/i },
  { type: "KEYCHAINS", re: /\bkey[\s-]*chains?\b|\bkeyrings?\b/i },
  { type: "SUNGLASSES", re: /\bsunglasses?\b|\bshades\b|\bocchiali\s+da\s+sole\b|太阳镜/i },
  { type: "OPTICAL_FRAMES", re: /\boptical\s*frames?\b|\beyeglass(?:es)?\b|\bglasses\b|\bmontature?\b/i },
  { type: "WATCHES", re: /\bwatches?\b|\borologi?\b|手表/i },
  { type: "RINGS", re: /\brings?\b|\banelli?\b|戒指/i },
  { type: "BRACELETS", re: /\bbracelets?\b|\bbraccialetti?\b|手链/i },
  { type: "NECKLACES", re: /\bnecklaces?\b|\bcollane?\b|项链/i },
  { type: "EARRINGS", re: /\bearrings?\b|\borecchini?\b|耳环/i },
  { type: "JEWELRY", re: /\bjewel(?:ry|lery)\b|\bgioielli?\b|首饰|珠宝/i },

  // CAPISPALLA — specifico prima di generico
  { type: "TRENCH_COATS", re: /\btrench(?:\s*coat)?s?\b/i },
  { type: "RAIN_JACKETS", re: /\brain\s*jackets?\b|\braincoats?\b/i },
  { type: "LEATHER_JACKETS", re: /\bleather\s*jackets?\b/i },
  { type: "DENIM_JACKETS", re: /\bdenim\s*jackets?\b|\bjean\s*jackets?\b/i },
  { type: "BOMBERS", re: /\bbombers?(?:\s*jackets?)?\b/i },
  { type: "WINDBREAKERS", re: /\bwind[\s-]*breakers?\b/i },
  { type: "PUFFERS", re: /\bpuffers?\b|\bdown\s*jackets?\b|\bpiumini?\b|羽绒服|羽绒/i },
  { type: "PARKAS", re: /\bparkas?\b/i },
  { type: "BLAZERS", re: /\bblazers?\b/i },
  { type: "VESTS", re: /\bvests?\b|\bgilets?\b/i },
  { type: "COATS", re: /\bcoats?\b|\bcappotti?\b|大衣/i },
  { type: "JACKETS", re: /\bjackets?\b|\bgiacche?\b|夹克|外套/i },

  // TOPS — l'ordine conta
  { type: "HOODIES", re: /\bhoodies?\b|\bhooded\s*sweatshirts?\b|\bfelpa\s+con\s+cappuccio\b|连帽|卫衣/i },
  { type: "SWEATSHIRTS", re: /\bsweatshirts?\b|\bcrew[\s-]*necks?\b|\bfelpe?\b/i },
  { type: "CARDIGANS", re: /\bcardigans?\b/i },
  { type: "KNITWEAR", re: /\bknit[\s-]*wear\b|\bknitted\b|\bknits?\b|\btricot\b|\bmaglieria\b/i },
  { type: "SWEATERS", re: /\bsweaters?\b|\bjumpers?\b|\bpullovers?\b|\bturtlenecks?\b|\bmocknecks?\b|\bmaglioni?\b|\bpull\b|毛衣/i },

  // Polo prima di shirt
  { type: "POLOS", re: /\bpolo(?:\s*shirts?)?s?\b/i },

  // Long sleeve prima di t-shirt/shirt
  { type: "LONGSLEEVES", re: /\blong[\s-]*sleeves?\b|\blong[\s-]*sleeved\b|\bl\/s\b|\bls\s*tee\b|长袖/i },

  // T-shirt prima di shirt
  { type: "TSHIRTS", re: /\bt[\s-]*shirts?\b|\btshirts?\b|\btees?\b|\bmagliett(?:a|e)\b|\bshort[\s-]*sleeve(?:d)?\b|短袖/i },
  { type: "BLOUSES", re: /\bblouses?\b/i },
  { type: "TANK_TOPS", re: /\btank\s*tops?\b/i },
  { type: "CROP_TOPS", re: /\bcrop\s*tops?\b/i },
  { type: "BODYSUITS", re: /\bbodysuits?\b/i },
  { type: "SHIRTS", re: /\bshirts?\b|\bbutton[\s-]*ups?\b|\bcamic(?:ia|ie)\b|衬衫/i },

  // BOTTOMS
  { type: "SWEATPANTS", re: /\bsweatpants?\b|\btrack\s*pants?\b|\bpantaloni\s+tuta\b/i },
  { type: "JOGGERS", re: /\bjoggers?\b/i },
  { type: "JEANS", re: /\bjeans?\b|\bdenim\s*pants?\b|\bdenims?\b|牛仔裤|牛仔/i },
  { type: "SHORTS", re: /\bshorts?\b|\bbermudas?\b|短裤/i },
  { type: "LEGGINGS", re: /\bleggings?\b/i },
  { type: "PANTS", re: /\btrousers?\b|\bpants?\b|\bpantaloni?\b|长裤|裤子|裤/i },
  { type: "SKIRTS", re: /\bskirts?\b|\bgonne?\b|裙子|短裙/i },

  // ONE-PIECE / SET
  { type: "TRACKSUITS", re: /\btracksuits?\b|\btrack\s*suits?\b|\btute?\b/i },
  { type: "JUMPSUITS", re: /\bjumpsuits?\b/i },
  { type: "ROMPERS", re: /\brompers?\b/i },
  { type: "DRESSES", re: /\bdresses?\b|\babiti?\b|连衣裙/i },
  { type: "SUITS", re: /\bsuits?\b|\bcompleti?\b/i },
  { type: "SETS", re: /\bsets?\b|\btwo[\s-]*piece\b|\b2[\s-]*piece\b/i },

  // BEAUTY / TECH
  { type: "FRAGRANCES", re: /\bperfumes?\b|\bparfums?\b|\bfragrances?\b|\bcolognes?\b|\beau\s+de\b|\bprofumi?\b/i },
  { type: "PHONE_CASES", re: /\bphone\s*cases?\b|\biphone\s*cases?\b/i },
  { type: "AIRPODS_CASES", re: /\bairpods?\s*cases?\b/i },
  { type: "TECH_ACCESSORIES", re: /\btech\s*accessor(?:y|ies)\b/i },
  { type: "SKINCARE", re: /\bskin[\s-]*care\b/i },
  { type: "MAKEUP", re: /\bmake[\s-]*up\b/i },
  { type: "HAIR", re: /\bhair\s*(?:care|products?)\b/i },
];

function detectProductTypeFromTitle(titleRaw) {
  let t = normalizeForMatch(titleRaw);
  t = fixCommonTyposForType(t);
  if (!t) return "OTHER";

  for (const r of CATEGORY_KEYWORD_RULES) {
    r.re.lastIndex = 0;
    if (r.re.test(t)) return r.type;
  }

  return "OTHER";
}

/**
 * I testi NON vengono concatenati: era la causa dei falsi positivi.
 * Esempio: titolo "Nike shoes" + body che cita "polo" deve restare SNEAKERS.
 */
function detectProductTypeFromSignals(titleRaw, crumbText, bodyText, categoryCardText = "") {
  const signals = [
    { source: "title", text: titleRaw },
    { source: "category-card", text: categoryCardText },
    { source: "breadcrumb", text: crumbText },
    { source: "body", text: String(bodyText || "").slice(0, 1800) },
  ];

  for (const signal of signals) {
    const type = detectProductTypeFromTitle(signal.text);
    if (type !== "OTHER") return type;
  }

  return "OTHER";
}

/**
 * Breadcrumb: solo selettori reali.
 * La versione precedente raccoglieva anche 40 link generici della pagina
 * (menu del seller), producendo categorie casuali.
 */
async function getYupooBreadcrumbText(page) {
  try {
    return await page.evaluate(() => {
      const out = [];
      const push = (s) => {
        const t = String(s || "").replace(/\s+/g, " ").trim();
        if (t && t.length >= 2 && t.length <= 200 && !out.includes(t)) out.push(t);
      };

      const selectors = [
        ".showalbumheader__breadcrumb",
        ".showalbumheader__bread",
        ".breadcrumb",
        ".breadcrumbs",
        ".crumb",
        ".crumbs",
        "nav[aria-label='breadcrumb']",
        ".album__breadcrumb",
        ".category__breadcrumb",
        ".showheader__categoryname",
      ];

      for (const sel of selectors) {
        for (const el of Array.from(document.querySelectorAll(sel)).slice(0, 4)) {
          push(el.textContent || "");
        }
      }

      return out.join(" | ");
    });
  } catch {
    return "";
  }
}

// =====================
// BRAND / TITOLO
// =====================
function normalizeBrandForCompare(b) {
  return String(b || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[^a-z0-9 ]+/g, "");
}

function escapeRegExp(s) {
  return String(s || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Toglie il brand ripetuto all'inizio del nome modello.
 * Prima questa funzione ritornava sempre il valore invariato: era un no-op
 * e produceva titoli tipo "NIKE Nike Air Max".
 */
function removeRedundantBrandPrefix(shoeName, brandHint) {
  const name = String(shoeName || "").trim();
  if (!name) return "";

  const brand = String(brandHint || "").trim();
  if (!brand) return name;

  const nb = normalizeBrandForCompare(brand);
  if (!nb) return name;

  // Confronto tollerante a punteggiatura: "A.P.C." vs "APC".
  const words = name.split(/\s+/);
  const brandWords = nb.split(" ").filter(Boolean);

  if (words.length <= brandWords.length) return name;

  const head = normalizeBrandForCompare(words.slice(0, brandWords.length).join(" "));
  if (head === nb) {
    const rest = words.slice(brandWords.length).join(" ").trim();
    return rest || name;
  }

  const re = new RegExp(`^${escapeRegExp(brand)}\\s+`, "i");
  const stripped = name.replace(re, "").trim();
  return stripped || name;
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
  if (!t || !b) return t;
  if (titleHasBrand(t, b)) return t;
  return `${b.toUpperCase()} ${t}`.trim();
}

function looksDescriptiveTitle(titleRaw) {
  const t = String(titleRaw || "").trim();
  if (t.length < 6) return false;

  const hasLetters = /[A-Za-z]{3,}/.test(t);
  const hasCjk = /\p{Script=Han}/u.test(t);
  const digits = (t.match(/\d/g) || []).length;

  if (!hasLetters && !hasCjk) return false;
  if (digits > 10 && t.length < 18) return false;
  return true;
}

function shouldTryShoeNameAi(titleRaw, crumbText, bodyText) {
  // L'AI sul modello scarpa serve solo quando Yupoo non è descrittivo.
  if (!looksDescriptiveTitle(titleRaw)) return true;
  const c = String(crumbText || "").trim();
  if (!c && String(bodyText || "").trim().length < 30) return true;
  return false;
}

// =====================
// PREZZI
// =====================
function parsePriceNumber(raw) {
  let s = String(raw ?? "").trim();
  if (!s) return null;

  s = s.replace(/\s+/g, "");

  // 1,299 => 1299 ; 35,5 => 35.5
  if (/^\d{1,3}(?:,\d{3})+$/.test(s)) s = s.replace(/,/g, "");
  else if (/^\d+,\d+$/.test(s)) s = s.replace(",", ".");

  const n = Number(s);
  if (!Number.isFinite(n) || n <= 0 || n >= 100000) return null;
  return n;
}

function roundPrice(n) {
  return Math.round(Number(n) * 100) / 100;
}

/**
 * Ritorna prezzo + valuta SOLO quando il numero è chiaramente associato a un
 * simbolo/codice valuta o a un'etichetta prezzo. In questo modo i numeri di
 * modello ("Sabrina 3", "Jordan 4", "990 v6", "2.0", "B30") non diventano prezzi.
 */
function extractMoneyFromText(text) {
  const t = String(text ?? "").replace(/\u00a0/g, " ");
  if (!t.trim()) return null;

  const candidates = [];

  const SEP = String.raw`(?:-|–|—|~|～|至|到|\bto\b)`;
  const CNY_SUFFIX = String.raw`(?:¥|￥|元|CNY|RMB|CN\s*[¥￥]|YUAN|YUANS|RENMINBI|(?<![A-Za-z])Y(?![A-Za-z]))`;
  const CNY_PREFIX = String.raw`(?:¥|￥|CNY|RMB|CN\s*[¥￥]|YUAN|YUANS|RENMINBI|(?<![A-Za-z0-9])Y(?![A-Za-z]))`;
  const USD_SUFFIX = String.raw`(?:\$|＄|USD|US\s*\$|DOLLARS?|US\s+DOLLARS?)`;
  const USD_PREFIX = String.raw`(?:\$|＄|USD|US\s*\$)`;

  function addCandidate({ a, b = null, currency, raw, index = 0, priority = 0 }) {
    const n1 = parsePriceNumber(a);
    if (!n1) return;

    const n2 = b !== null && b !== undefined && String(b).trim() !== ""
      ? parsePriceNumber(b)
      : null;

    // Se è un range prendiamo SEMPRE il valore più piccolo.
    const amount = n2 ? Math.min(n1, n2) : n1;

    const cny =
      currency === "USD"
        ? roundPrice(amount * SCRAPER_USD_CNY_RATE)
        : roundPrice(amount);

    if (!(cny > 0 && cny < 100000)) return;

    candidates.push({
      amount,
      currency,
      cny,
      rate: currency === "USD" ? SCRAPER_USD_CNY_RATE : 1,
      raw: String(raw || "").trim(),
      index: Number(index || 0),
      priority,
      isRange: !!n2,
    });
  }

  function scan(patterns, currency, basePriority) {
    for (let i = 0; i < patterns.length; i++) {
      const re = patterns[i];
      re.lastIndex = 0;

      let m;
      let guard = 0;

      while ((m = re.exec(t)) !== null && guard < 60) {
        guard += 1;
        addCandidate({
          a: m[1],
          b: m[2] ?? null,
          currency,
          raw: m[0],
          index: m.index,
          priority: basePriority + i,
        });
      }
    }
  }

  // =====================
  // RANGE USD
  // =====================
  scan(
    [
      // 29-33$ | 29 - 33 $ | 29~33 USD | 29 to 33 dollars
      new RegExp(`(\\d+(?:[.,]\\d+)?)\\s*${SEP}\\s*(\\d+(?:[.,]\\d+)?)\\s*${USD_SUFFIX}`, "gi"),

      // $29-33 | USD 29~33 | US$ 29 to 33
      new RegExp(`${USD_PREFIX}\\s*[:：=]?\\s*(\\d+(?:[.,]\\d+)?)\\s*${SEP}\\s*(\\d+(?:[.,]\\d+)?)`, "gi"),

      // $29-$33 | USD29-USD33
      new RegExp(`${USD_PREFIX}\\s*(\\d+(?:[.,]\\d+)?)\\s*${SEP}\\s*${USD_PREFIX}\\s*(\\d+(?:[.,]\\d+)?)`, "gi"),

      // 29$-33$ | 29 USD - 33 USD
      new RegExp(`(\\d+(?:[.,]\\d+)?)\\s*${USD_SUFFIX}\\s*${SEP}\\s*(\\d+(?:[.,]\\d+)?)\\s*${USD_SUFFIX}`, "gi"),
    ],
    "USD",
    0
  );

  // =====================
  // RANGE CNY / RMB / YUAN / Y / ¥
  // =====================
  scan(
    [
      // 169-199Y | 169-199¥ | 169~199 CNY | 169 to 199 yuan
      new RegExp(`(\\d+(?:[.,]\\d+)?)\\s*${SEP}\\s*(\\d+(?:[.,]\\d+)?)\\s*${CNY_SUFFIX}`, "gi"),

      // ¥169-199 | RMB 169-199 | CNY169~199 | Y169-199
      new RegExp(`${CNY_PREFIX}\\s*[:：=]?\\s*(\\d+(?:[.,]\\d+)?)\\s*${SEP}\\s*(\\d+(?:[.,]\\d+)?)`, "gi"),

      // ¥169-¥199 | RMB169-RMB199 | Y169-Y199
      new RegExp(`${CNY_PREFIX}\\s*(\\d+(?:[.,]\\d+)?)\\s*${SEP}\\s*${CNY_PREFIX}\\s*(\\d+(?:[.,]\\d+)?)`, "gi"),

      // 169Y-199Y | 169¥-199¥ | 169 RMB - 199 RMB
      new RegExp(`(\\d+(?:[.,]\\d+)?)\\s*${CNY_SUFFIX}\\s*${SEP}\\s*(\\d+(?:[.,]\\d+)?)\\s*${CNY_SUFFIX}`, "gi"),
    ],
    "CNY",
    10
  );

  // =====================
  // CNY SINGOLO
  // =====================
  scan(
    [
      // 【169Y】 | 169Y | 169 Y | 169¥ | 169元 | 169CNY | 169RMB | 169yuan
      new RegExp(`(\\d+(?:[.,]\\d+)?)\\s*${CNY_SUFFIX}`, "gi"),

      // Y169 | ¥169 | ￥169 | RMB169 | CNY:169 | yuan 169
      new RegExp(`${CNY_PREFIX}\\s*[:：=]?\\s*~?\\s*(\\d+(?:[.,]\\d+)?)`, "gi"),

      // price: 169 | sale price 169
      /\b(?:price|sale\s*price|selling\s*price|wholesale\s*price|unit\s*price)\b\s*[:：=\-]?\s*(?:CNY|RMB|YUAN|Y|¥|￥|元)?\s*(\d+(?:[.,]\d+)?)/gi,

      // 价格169 | 售价：169 | 现价169
      /(?:价格|售价|现价|单价|批发价|零售价)\s*[:：=\-]?\s*(?:CNY|RMB|YUAN|Y|¥|￥|元)?\s*(\d+(?:[.,]\d+)?)/gi,
    ],
    "CNY",
    30
  );

  // =====================
  // USD SINGOLO
  // =====================
  scan(
    [
      // 32$ | 32 $ | 32USD | 32 dollars
      new RegExp(`(\\d+(?:[.,]\\d+)?)\\s*${USD_SUFFIX}`, "gi"),

      // $32 | USD32 | USD 32 | US$32
      new RegExp(`${USD_PREFIX}\\s*[:：=]?\\s*~?\\s*(\\d+(?:[.,]\\d+)?)`, "gi"),
    ],
    "USD",
    40
  );

  if (!candidates.length) return null;

  // Prima posizione nel testo; a parità il range vince sul singolo.
  candidates.sort((a, b) => {
    if (a.index !== b.index) return a.index - b.index;
    if (a.isRange !== b.isRange) return a.isRange ? -1 : 1;
    if (a.priority !== b.priority) return a.priority - b.priority;
    return String(b.raw).length - String(a.raw).length;
  });

  const best = candidates[0];

  return {
    amount: best.amount,
    currency: best.currency,
    cny: best.cny,
    rate: best.rate,
    raw: best.raw,
  };
}

function choosePriceInfo(sources) {
  for (const src of Array.isArray(sources) ? sources : []) {
    const text = String(src?.text || "").trim();
    if (!text) continue;

    const found = extractMoneyFromText(text);
    if (found) return { ...found, source: String(src?.source || "unknown") };
  }
  return null;
}

/**
 * Colonna T: valuta originale e tasso usato.
 * Serve a non perdere l'informazione quando convertiamo USD->CNY: se il tasso
 * cambia, si ricalcola a valle senza ri-scrapare.
 */
function buildPriceMeta(info) {
  if (!SCRAPER_WRITE_PRICE_META || !info) return "";
  if (info.currency === "CNY") return `CNY ${info.amount}`;
  return `${info.currency} ${info.amount} @${info.rate}`;
}

function logPriceResult(itemUrl, info) {
  if (!SCRAPER_PRICE_DEBUG) return;

  const id = extractAlbumId(itemUrl) || extract1688OfferId(itemUrl) || "?";

  if (!info) {
    console.log(`⚠️ PRICE missing | item=${id}`);
    return;
  }

  const original = info.currency === "USD" ? `${info.amount} USD -> ${info.cny} CNY` : `${info.cny} CNY`;
  console.log(`💰 PRICE | item=${id} | ${original} | source=${info.source}`);
}

/**
 * Segnali prezzo dal DOM: meta, itemprop, attributi data-*, JSON-LD.
 * È un evaluate pesante, quindi viene chiamato SOLO se titolo e card categoria
 * non hanno già dato un prezzo (il caso più comune su Yupoo).
 */
async function extractDedicatedPriceSignals(page) {
  return page
    .evaluate(() => {
      const out = [];
      const seen = new Set();

      const add = (value, currency = "") => {
        const v = String(value || "").replace(/\s+/g, " ").trim();
        if (!v) return;

        const cur = String(currency || "").trim().toUpperCase();
        const combined = cur && /^\d+(?:[.,]\d+)?$/.test(v) ? `${cur} ${v}` : v;

        if (!combined || seen.has(combined)) return;
        seen.add(combined);
        out.push(combined);
      };

      const currency =
        document.querySelector('meta[itemprop="priceCurrency"]')?.getAttribute("content") ||
        document.querySelector('[itemprop="priceCurrency"]')?.getAttribute("content") ||
        document.querySelector('[itemprop="priceCurrency"]')?.textContent ||
        "";

      const metaSelectors = [
        'meta[itemprop="price"]',
        'meta[property="product:price:amount"]',
        'meta[property="og:price:amount"]',
        'meta[name="price"]',
      ];

      for (const sel of metaSelectors) {
        const el = document.querySelector(sel);
        if (el) add(el.getAttribute("content") || el.getAttribute("value") || "", currency);
      }

      const elSelectors = ['[itemprop="price"]', "[data-price]", "[data-product-price]", '[class*="price"]', '[id*="price"]'];

      for (const sel of elSelectors) {
        for (const el of Array.from(document.querySelectorAll(sel)).slice(0, 30)) {
          const raw =
            el.getAttribute("data-price") ||
            el.getAttribute("data-product-price") ||
            el.getAttribute("content") ||
            el.getAttribute("value") ||
            el.textContent ||
            "";

          // Un numero nudo vale solo se la pagina dichiara la valuta.
          if (/^\s*\d+(?:[.,]\d+)?\s*$/.test(String(raw)) && !String(currency).trim()) continue;
          add(raw, currency);
        }
      }

      // JSON-LD / schema.org offers
      for (const script of Array.from(document.querySelectorAll('script[type="application/ld+json"]')).slice(0, 20)) {
        try {
          const obj = JSON.parse(script.textContent || "null");
          const stack = Array.isArray(obj) ? [...obj] : [obj];
          let guard = 0;

          while (stack.length && guard < 200) {
            guard += 1;
            const x = stack.shift();
            if (!x || typeof x !== "object") continue;

            const offers = x.offers;
            if (offers) {
              for (const o of Array.isArray(offers) ? offers : [offers]) {
                if (!o || typeof o !== "object") continue;
                const p = o.price ?? o.lowPrice ?? o.highPrice;
                const c = o.priceCurrency || currency || "";
                if (p != null && c) add(String(p), String(c));
              }
            }

            for (const v of Object.values(x)) {
              if (v && typeof v === "object") {
                if (Array.isArray(v)) stack.push(...v);
                else stack.push(v);
              }
            }
          }
        } catch {}
      }

      return out.slice(0, 80).join(" | ");
    })
    .catch(() => "");
}

async function resolvePriceInfo(page, { titleRaw, categoryCardText, bodyText, labels = {} }) {
  const cheap = choosePriceInfo([
    { source: labels.title || "album-title", text: titleRaw },
    { source: labels.card || "category-card", text: categoryCardText },
  ]);

  if (cheap) return cheap;

  const domSignals = await extractDedicatedPriceSignals(page);

  return choosePriceInfo([
    { source: labels.dom || "dom-price", text: domSignals },
    { source: labels.body || "album-body", text: bodyText },
  ]);
}

function parseCnyFrom1688Html(html) {
  const h = String(html || "");
  if (!h) return null;

  const patterns = [
    /"price"\s*:\s*"(\d+(?:\.\d+)?)"/i,
    /"discountPrice"\s*:\s*"(\d+(?:\.\d+)?)"/i,
    /"offerPrice"\s*:\s*"(\d+(?:\.\d+)?)"/i,
  ];

  for (const re of patterns) {
    const m = h.match(re);
    if (m && m[1]) {
      const n = Number(m[1]);
      if (Number.isFinite(n) && n > 0 && n < 100000) return n;
    }
  }
  return null;
}

// =====================
// TITOLO: pulizia prezzo + AUTO cleanup
// =====================
/**
 * Rimuove SOLO token riconoscibili come prezzo; i numeri senza valuta restano.
 *
 * 208¥DIPLOMATIC ZIPSET       -> DIPLOMATIC ZIPSET
 * 380¥748&COR URBAN SET       -> 748&COR URBAN SET
 * 32$ XY Batch Nike Sabrina 3 -> XY Batch Nike Sabrina 3
 * 89¥ 2.0 new cargo shorts    -> 2.0 new cargo shorts
 */
function stripPriceTokensFromTitle(title) {
  let s = String(title ?? "").replace(/\u00a0/g, " ").trim();
  if (!s) return "";

  const SEP = String.raw`(?:-|–|—|~|～|至|到|\bto\b)`;
  const CNY_SUFFIX = String.raw`(?:¥|￥|元|CNY|RMB|CN\s*[¥￥]|YUAN|YUANS|RENMINBI|(?<![A-Za-z])Y(?![A-Za-z]))`;
  const CNY_PREFIX = String.raw`(?:¥|￥|CNY|RMB|CN\s*[¥￥]|YUAN|YUANS|RENMINBI|(?<![A-Za-z0-9])Y(?![A-Za-z]))`;
  const USD_SUFFIX = String.raw`(?:\$|＄|USD|US\s*\$|DOLLARS?|US\s+DOLLARS?)`;
  const USD_PREFIX = String.raw`(?:\$|＄|USD|US\s*\$)`;

  // Prima i RANGE completi, poi i prezzi singoli.
  const patterns = [
    // USD range
    new RegExp(`\\d+(?:[.,]\\d+)?\\s*${SEP}\\s*\\d+(?:[.,]\\d+)?\\s*${USD_SUFFIX}`, "gi"),
    new RegExp(`${USD_PREFIX}\\s*[:：=]?\\s*\\d+(?:[.,]\\d+)?\\s*${SEP}\\s*\\d+(?:[.,]\\d+)?`, "gi"),
    new RegExp(`${USD_PREFIX}\\s*\\d+(?:[.,]\\d+)?\\s*${SEP}\\s*${USD_PREFIX}\\s*\\d+(?:[.,]\\d+)?`, "gi"),
    new RegExp(`\\d+(?:[.,]\\d+)?\\s*${USD_SUFFIX}\\s*${SEP}\\s*\\d+(?:[.,]\\d+)?\\s*${USD_SUFFIX}`, "gi"),

    // CNY range
    new RegExp(`\\d+(?:[.,]\\d+)?\\s*${SEP}\\s*\\d+(?:[.,]\\d+)?\\s*${CNY_SUFFIX}`, "gi"),
    new RegExp(`${CNY_PREFIX}\\s*[:：=]?\\s*\\d+(?:[.,]\\d+)?\\s*${SEP}\\s*\\d+(?:[.,]\\d+)?`, "gi"),
    new RegExp(`${CNY_PREFIX}\\s*\\d+(?:[.,]\\d+)?\\s*${SEP}\\s*${CNY_PREFIX}\\s*\\d+(?:[.,]\\d+)?`, "gi"),
    new RegExp(`\\d+(?:[.,]\\d+)?\\s*${CNY_SUFFIX}\\s*${SEP}\\s*\\d+(?:[.,]\\d+)?\\s*${CNY_SUFFIX}`, "gi"),

    // CNY singolo
    new RegExp(`\\d+(?:[.,]\\d+)?\\s*${CNY_SUFFIX}`, "gi"),
    new RegExp(`${CNY_PREFIX}\\s*[:：=]?\\s*~?\\s*\\d+(?:[.,]\\d+)?`, "gi"),

    // USD singolo
    new RegExp(`\\d+(?:[.,]\\d+)?\\s*${USD_SUFFIX}`, "gi"),
    new RegExp(`${USD_PREFIX}\\s*[:：=]?\\s*~?\\s*\\d+(?:[.,]\\d+)?`, "gi"),

    // Etichette prezzo
    /\b(?:price|sale\s*price|selling\s*price|wholesale\s*price|unit\s*price)\b\s*[:：=\-]?\s*(?:CNY|RMB|YUAN|Y|¥|￥|元|USD|US\s*\$|\$)?\s*\d+(?:[.,]\d+)?/gi,
    /(?:价格|售价|现价|单价|批发价|零售价)\s*[:：=\-]?\s*(?:CNY|RMB|YUAN|Y|¥|￥|元)?\s*\d+(?:[.,]\d+)?/gi,
  ];

  for (const re of patterns) s = s.replace(re, " ");

  // Elimina cornici rimaste vuote: 【169Y】 -> niente residui.
  s = s
    .replace(/【\s*】|［\s*］|\[\s*\]|\(\s*\)|（\s*）/g, " ")
    .replace(/^[\s\-–—|:：,;·•/\\]+/, "")
    .replace(/[\s\-–—|:：,;·•/\\]+$/, "")
    .replace(/\s+([,.;:!?\]])/g, "$1")
    .replace(/([[(【（])\s+/g, "$1")
    .replace(/\s{2,}/g, " ")
    .trim();

  return s;
}

/**
 * Pulizia extra SOLO per titleMode=AUTO:
 * - rimuove blocchi tra parentesi tonde, incluse quelle full-width
 * - rimuove caratteri Han e punteggiatura CJK
 * - mantiene lettere latine, numeri e modelli (B30, 1:1, 2.0, 990 v6)
 * - NON tocca le parentesi quadre, quindi tag tipo [WASHED] restano
 */
function cleanAutoProductTitle(title) {
  let s = stripPriceTokensFromTitle(title);
  if (!s) return "";

  for (let i = 0; i < 4; i++) {
    const prev = s;
    s = s.replace(/\([^()]*\)/g, " ").replace(/（[^（）]*）/g, " ");
    if (s === prev) break;
  }

  s = s.replace(/[()（）]/g, " ");
  s = s.replace(/\p{Script=Han}+/gu, " ");
  s = s.replace(/[，。；：？！、﹑·《》〈〉「」『』【】〖〗〔〕]/g, " ");

  s = s
    .replace(/\s+([,.;:!?])/g, "$1")
    .replace(/^[\s\-–—|:：,;·•/\\]+/, "")
    .replace(/[\s\-–—|:：,;·•/\\]+$/, "")
    .replace(/\s{2,}/g, " ")
    .trim();

  return s;
}

function normalizeTitleMode(mode, titleProvided = "") {
  const s = String(mode || "").trim().toUpperCase();
  if (titleProvided && String(titleProvided).trim()) return "FORCE";
  if (s === "ALBUM" || s === "AUTO" || s === "FORCE") return s;
  return "AUTO";
}

function finalizeProductTitle(titleBase, titleRaw, titleMode) {
  const basePriceClean = stripPriceTokensFromTitle(titleBase) || stripPriceTokensFromTitle(titleRaw) || "Item";

  if (String(titleMode || "").toUpperCase() !== "AUTO") return basePriceClean;

  return cleanAutoProductTitle(titleBase) || cleanAutoProductTitle(titleRaw) || basePriceClean || "Item";
}

function buildDisplayName(titleRaw, brandOverride = "", forcedType = "") {
  const brand = String(brandOverride || "").trim();
  const forced = canonicalizeCategory(forcedType);

  const detected = detectProductTypeFromTitle(titleRaw);
  const finalType = forced && ALLOWED_TYPES.has(forced) ? forced : detected;

  const tr = stripPriceTokensFromTitle(titleRaw);
  const noUsefulText = tr.length < 3;

  if (brand && finalType && finalType !== "OTHER") return `${brand.toUpperCase()} ${finalType}`;
  if (brand && (finalType === "OTHER" || noUsefulText)) return brand.toUpperCase();
  if (brand) return brand.toUpperCase();
  return tr || "Item";
}

// =====================
// ID / SLUG / NOMI UNICI
// =====================
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
  if (aid) return `${sid}-${aid}`;

  const oid = extract1688OfferId(source_url);
  if (oid) return `${sid}-1688${oid}`;

  return `${sid}-${hash36(source_url).slice(0, 10)}`;
}

function buildUniqueSlug(title, sellerName, source_url) {
  const sid = sellerKey(sellerName, source_url);
  const base = slugify(title || "item", 60) || "item";

  const aid = extractAlbumId(source_url);
  const oid = extract1688OfferId(source_url);
  const tail = aid ? aid : oid ? `1688${oid}` : hash36(source_url).slice(0, 8);

  return slugify(`${base}-${sid}-${tail}`, 95);
}

function splitBaseAndIndex(name) {
  const n = String(name || "").trim();
  if (!n) return { base: "", idx: 0 };

  const m = n.match(/^(.*)\s+\((\d+)\)$/);
  if (m) {
    const base = String(m[1] || "").trim();
    const idx = Number(m[2] || "1");
    return { base: base || n, idx: Number.isFinite(idx) ? idx : 1 };
  }

  // Un numero finale non è un indice duplicato: "Sabrina 3", "Jordan 4",
  // "990 v6" sono nomi/modelli reali. I duplicati usano solo il formato "(2)".
  return { base: n, idx: 1 };
}

function makeUniqueNameForSeller(baseName, seller, countersMap) {
  const base = String(baseName || "").trim();
  if (!base) return base;

  const s = String(seller || "").trim().toLowerCase();
  const key = s ? `${base}||${s}` : base;

  const next = (countersMap.get(key) || 0) + 1;
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

// =====================
// COSTRUZIONE RIGA SHEET
// =====================
/**
 * Unico punto in cui si scrive la struttura della riga.
 * Tutto il resto del codice usa COL.*, mai indici numerici.
 */
function buildSheetRow({
  id,
  slug,
  title,
  brand,
  category,
  seller,
  images = [],
  status = "ok",
  sourceUrl = "",
  buyUrl = "",
  priceInfo = null,
}) {
  const row = new Array(ROW_LEN).fill("");

  row[COL.ID] = String(id || "");
  row[COL.SLUG] = String(slug || "");
  row[COL.TITLE] = String(title || "");
  row[COL.BRAND] = String(brand || "").trim();
  row[COL.CATEGORY] = String(category || "OTHER");
  row[COL.SELLER] = String(seller || "");

  const list = Array.isArray(images) ? images : [];
  for (let i = 0; i < IMG_COLS.length; i++) row[IMG_COLS[i]] = list[i] || "";

  const extra = list.slice(IMG_COLS.length);
  row[COL.IMAGES_EXTRA] = extra.length ? extra.join(", ") : "";

  row[COL.STATUS] = String(status || "ok");
  row[COL.SOURCE_URL] = String(sourceUrl || "");
  row[COL.BUY_URL] = String(buyUrl || "");
  row[COL.PRICE_CNY] = priceInfo?.cny ? String(priceInfo.cny) : "";
  row[COL.PRICE_META] = buildPriceMeta(priceInfo);

  return row;
}

// =====================
// MODALITÀ PER JOB (tri-state)
// =====================
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
  if (m === "1") return !!openai;
  return SCRAPER_DETECT_EFFECTIVE && !!openai;
}

function isShoeNameEnabledForJob(jobShoeName, aiEnabled) {
  const m = normTriState(jobShoeName);
  if (m === "0") return false;
  if (m === "1") return aiEnabled && !!openai;
  return aiEnabled && SCRAPER_DETECT_SHOE_NAME && !!openai;
}

// =====================
// AI: helpers
// =====================
function toAiCoverUrl(u) {
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
    try {
      return JSON.parse(txt.slice(start, end + 1));
    } catch {}
  }
  return null;
}

function safeJsonExtractObj(s) {
  const obj = safeJsonExtract(s);
  return obj && typeof obj === "object" ? obj : null;
}

/**
 * Fetch immagine per la vision, con cap sui byte:
 * 1) context.request.get
 * 2) page.goto + resp.body()   (opzionale)
 * 3) screenshot jpeg           (opzionale)
 */
async function fetchImageAsDataUri(context, url, opts = {}) {
  const raw = String(url || "").trim();
  if (!raw) return "";

  const referer = String(opts.referer || "").trim();

  const candidates = dedupeStrings([
    fixPhotoDoubleHost(toAiCoverUrl(raw)),
    fixPhotoDoubleHost(toBigYupooPhotoUrl(raw)),
    fixPhotoDoubleHost(toHttpsUrl(raw)),
  ]);

  const headers = {
    "user-agent": REAL_UA,
    accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
    "accept-language": ACCEPT_LANG,
    ...(referer ? { referer } : {}),
  };

  let lastErr = null;

  // (1) request.get
  for (const u of candidates) {
    for (let attempt = 1; attempt <= SCRAPER_DETECT_RETRIES; attempt++) {
      try {
        const res = await hostGate.run(hostOf(u), () =>
          context.request.get(u, { timeout: 25000, maxRedirects: 6, headers })
        );

        const status = res.status();
        const ct = String(res.headers()["content-type"] || "").split(";")[0].trim().toLowerCase();

        if (res.ok() && ct.startsWith("image/")) {
          const buf = await res.body();

          if (buf.length > SCRAPER_AI_MAX_BYTES) {
            logAiDebug("AI image too large, skip", { url: u, bytes: buf.length, cap: SCRAPER_AI_MAX_BYTES });
            lastErr = new Error("AI image too large");
            continue;
          }

          const head = buf.slice(0, 160).toString("utf8").toLowerCase();
          if (head.includes("<!doctype") || head.includes("<html")) {
            logAiDebug("request.get fake-image/html", { status, ct, url: u });
            continue;
          }

          return `data:${ct || "image/jpeg"};base64,${buf.toString("base64")}`;
        }

        logAiDebug("request.get non-image/blocked", { status, ct, url: u });
        lastErr = new Error(`request.get non-image/blocked: ${status} ${ct}`);
      } catch (e) {
        lastErr = e;
        logAiDebug(`request.get failed (attempt ${attempt})`, { url: u, err: firstLine(e?.message || e) });
        await sleep(350 * attempt);
      }
    }
  }

  // (2) page.goto + body (opzionale)
  if (!SCRAPER_AI_ALLOW_PAGE_GOTO_FALLBACK) {
    throw lastErr || new Error("fetchImageAsDataUri failed (request.get only)");
  }

  for (const u of candidates) {
    for (let attempt = 1; attempt <= SCRAPER_DETECT_RETRIES; attempt++) {
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
          .goto(u, { waitUntil: "domcontentloaded", timeout: 60000, ...(referer ? { referer } : {}) })
          .catch(() => null);

        await p.waitForTimeout(350);

        if (resp) {
          const status = resp.status();
          const ct = String(resp.headers()["content-type"] || "").split(";")[0].trim().toLowerCase();

          if (status < 400 && ct.startsWith("image/")) {
            const buf = Buffer.from(await resp.body());
            if (buf.length > SCRAPER_AI_MAX_BYTES) {
              logAiDebug("AI image too large (page.goto), skip", { url: u });
            } else {
              return `data:${ct || "image/jpeg"};base64,${buf.toString("base64")}`;
            }
          }

          lastErr = new Error(`page.goto non-image/blocked: ${status} ${ct}`);
          logAiDebug("page.goto non-image/blocked", { status, ct, url: u });
        } else {
          lastErr = new Error("page.goto no response");
        }

        // (3) screenshot (opzionale)
        if (SCRAPER_AI_ALLOW_SCREENSHOT_FALLBACK) {
          try {
            const shot = await p.screenshot({ type: "jpeg", quality: 75, fullPage: true });
            if (shot.length <= SCRAPER_AI_MAX_BYTES) {
              return `data:image/jpeg;base64,${Buffer.from(shot).toString("base64")}`;
            }
          } catch (e2) {
            lastErr = e2;
            logAiDebug("screenshot failed", { url: u, err: firstLine(e2?.message || e2) });
          }
        }
      } catch (e) {
        lastErr = e;
        logAiDebug(`page.goto failed (attempt ${attempt})`, { url: u, err: firstLine(e?.message || e) });
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

// =====================
// AI: solo BRAND dalla cover
// =====================
/**
 * La categoria è sempre keyword-based (STRICT), quindi il prompt non la chiede
 * più: meno token, meno latenza, nessun output buttato via.
 */
async function aiDetectBrandFromCover(context, coverUrl, titleRaw, bodyText, refererUrl = "", opts = {}) {
  if (!opts.aiEnabled || !openai) return "";

  const cover = String(coverUrl || "").trim();
  if (!cover) return "";

  const cacheKey = `brand::${yupooImageKey(cover) || cover}`;
  if (hasAiCache(cacheKey)) return String(getAiCache(cacheKey) || "");

  const prompt = `
Return ONLY valid JSON: {"brand":"", "confidence":0}

GOAL:
- Identify the fashion brand of the product in the IMAGE.

RULES:
- brand: uppercase brand name if clearly visible (logo, wordmark, unmistakable design), else "".
- confidence MUST be a number between 0 and 1.
- If unsure, return {"brand":"", "confidence":0}. Never guess.
- Title and body are secondary hints only.

TITLE: ${String(titleRaw || "").slice(0, 280)}
BODY: ${String(bodyText || "").slice(0, 400)}
`.trim();

  let lastErr = null;

  for (let attempt = 1; attempt <= SCRAPER_DETECT_RETRIES; attempt++) {
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
        max_output_tokens: Math.min(120, SCRAPER_DETECT_MAX_OUTPUT_TOKENS),
      });

      const obj = safeJsonExtractObj(resp.output_text || "") || {};
      const brand = String(obj.brand || "").trim().toUpperCase();
      const conf = Number(obj.confidence);

      const finalBrand = brand && Number.isFinite(conf) && conf >= 0.6 ? brand : "";

      setAiCache(cacheKey, finalBrand);
      return finalBrand;
    } catch (e) {
      lastErr = e;
      logAiDebug(`aiDetectBrand attempt ${attempt} failed`, firstLine(e?.message || e));
      await sleep(500 * attempt);
    }
  }

  logAiDebug("aiDetectBrand final fail", firstLine(lastErr?.message || lastErr));
  setAiCache(cacheKey, "");
  return "";
}

// =====================
// AI: nome modello footwear
// =====================
async function aiDetectFootwearNameFromCover(context, coverUrl, brandHint, titleRaw, bodyText, refererUrl = "", opts = {}) {
  if (!opts.aiEnabled || !openai) return "";
  if (!opts.shoeNameEnabled) return "";

  const cover = String(coverUrl || "").trim();
  if (!cover) return "";

  const cacheKey = `shoeName::${yupooImageKey(cover) || cover}`;
  if (hasAiCache(cacheKey)) return String(getAiCache(cacheKey) || "");

  const prompt = `
Return ONLY valid JSON: {"name":"", "confidence":0}

GOAL:
- Detect the shoe model / collaboration from the IMAGE when possible.
- Keep it concise (max ~60 chars). No sizes, no price, no colorway codes.

RULES:
- If NOT sure, return {"name":"", "confidence":0}
- confidence MUST be a number between 0 and 1
- Do not repeat the brand if it equals BRAND_HINT.

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

    const obj = safeJsonExtractObj(resp.output_text || "") || {};
    const name = String(obj.name || "").trim();
    const conf = Number(obj.confidence);

    const finalName = name && Number.isFinite(conf) && conf >= 0.6 ? name : "";
    setAiCache(cacheKey, finalName);
    return finalName;
  } catch (e) {
    setAiCache(cacheKey, "");
    logAiDebug("shoeName detect failed", firstLine(e?.message || e));
    return "";
  }
}

// =====================
// VIGORBUY
// =====================
const _vigorbuyShortCache = new Map();

const vigorbuyStats = {
  ok: 0,
  fail: 0,
  verifyFail: 0,
  cacheHit: 0,
  skippedNonWeidian: 0,
  consecutiveFails: 0,
  disabled: false,
  authError: false,
  firstError: "",
};

function buildVigorBuyLongUrlFromWeidian(url) {
  const itemId = extractWeidianItemId(url);
  if (!itemId) return "";

  return (
    `https://vigorbuy.com/product/2/${itemId}` +
    `?utm_source=website` +
    `&utm_medium=share` +
    `&utm_campaign=product_details` +
    `&utm_content=${itemId}` +
    `&inviteCode=${encodeURIComponent(VIGORBUY_INVITE_CODE)}`
  );
}

function buildVigorBuySignature(nonce) {
  return createHash("md5").update(`${String(nonce || "")}${VIGORBUY_SIGN_KEY}`, "utf8").digest("hex");
}

function isValidVigorBuyShortUrl(url) {
  try {
    const u = new URL(String(url || "").trim());
    return u.protocol === "https:" && u.hostname.toLowerCase() === "vigorbuy.cc" && /^\/[A-Za-z0-9]+\/?$/.test(u.pathname);
  } catch {
    return false;
  }
}

/**
 * Errore VigorBuy con due flag:
 * - retryable: false = ritentare non serve (token scaduto, link che punta altrove)
 * - auth: true = problema di sessione/token, da risolvere in .env.local
 */
function vigorBuyError(message, { retryable = true, auth = false, verify = false } = {}) {
  const err = new Error(message);
  err.vigorbuyRetryable = retryable;
  err.vigorbuyAuth = auth;
  err.vigorbuyVerify = verify;
  return err;
}

function isVigorBuySiteHost(hostname) {
  const h = String(hostname || "").toLowerCase();
  return h === "vigorbuy.com" || h.endsWith(".vigorbuy.com");
}

function isVigorBuyAnyHost(hostname) {
  return isVigorBuySiteHost(hostname) || String(hostname || "").toLowerCase() === "vigorbuy.cc";
}

/**
 * Cerca la pagina prodotto VigorBuy dentro un URL di redirect.
 *
 * Il link corto può rispondere in due modi:
 *   1) diretto:   https://vigorbuy.com/product/2/<id>?inviteCode=...
 *   2) "wrapped": https://vigorbuy.com/cloudflare-verify?redirect=%2Fproduct%2F2%2F<id>%3FinviteCode%3D...
 * Nel secondo caso la destinazione vera è dentro un parametro della query.
 */
function findVigorBuyProductUrl(candidate, baseUrl, depth = 0) {
  if (depth > 3) return null;

  let u;
  try {
    u = new URL(String(candidate || ""), baseUrl);
  } catch {
    return null;
  }

  if (!isVigorBuySiteHost(u.hostname)) return null;
  if (/^\/product\//i.test(u.pathname)) return u;

  for (const value of u.searchParams.values()) {
    if (!/^(\/|https?:\/\/)/i.test(value)) continue;
    const nested = findVigorBuyProductUrl(value, u.href, depth + 1);
    if (nested) return nested;
  }

  return null;
}

/**
 * Risolve il link corto e controlla che porti al prodotto richiesto con il
 * nostro inviteCode. Ritorna l'URL prodotto trovato, altrimenti lancia.
 * Legge solo l'header Location: non apre la pagina VigorBuy.
 */
async function verifyVigorBuyShortUrl(shortUrl, itemId) {
  let current = shortUrl;

  for (let hop = 0; hop < 4; hop++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), VIGORBUY_TIMEOUT_MS);

    let status = 0;
    let location = "";

    try {
      const response = await fetch(current, {
        method: "GET",
        redirect: "manual",
        headers: {
          accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "accept-language": "it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7",
          "user-agent": REAL_UA,
        },
        signal: controller.signal,
      });

      status = response.status;
      location = String(response.headers.get("location") || "").trim();
      try {
        await response.body?.cancel();
      } catch {}
    } catch (err) {
      const why = err?.name === "AbortError" ? `timeout ${VIGORBUY_TIMEOUT_MS}ms` : firstLine(err?.message || err);
      throw vigorBuyError(`VigorBuy verifica ${shortUrl}: ${why}`, { verify: true });
    } finally {
      clearTimeout(timer);
    }

    if (status < 300 || status >= 400 || !location) {
      throw vigorBuyError(`VigorBuy verifica ${shortUrl}: nessun redirect (HTTP ${status})`, { verify: true });
    }

    let next;
    try {
      next = new URL(location, current);
    } catch {
      throw vigorBuyError(`VigorBuy verifica ${shortUrl}: Location non valido`, { retryable: false, verify: true });
    }

    const product = findVigorBuyProductUrl(next.href, current);

    if (product) {
      const expectedPath = `/product/2/${itemId}`;
      const gotPath = product.pathname.replace(/\/+$/, "");

      if (gotPath !== expectedPath) {
        throw vigorBuyError(
          `VigorBuy verifica ${shortUrl}: punta a ${gotPath} invece di ${expectedPath}`,
          { retryable: false, verify: true }
        );
      }

      const gotInvite = String(product.searchParams.get("inviteCode") || "");
      if (gotInvite !== VIGORBUY_INVITE_CODE) {
        throw vigorBuyError(
          `VigorBuy verifica ${shortUrl}: inviteCode="${gotInvite}" invece di "${VIGORBUY_INVITE_CODE}"`,
          { retryable: false, verify: true }
        );
      }

      return product.href;
    }

    if (!isVigorBuyAnyHost(next.hostname)) {
      throw vigorBuyError(
        `VigorBuy verifica ${shortUrl}: redirect verso host inatteso ${next.hostname}`,
        { retryable: false, verify: true }
      );
    }

    current = next.href;
  }

  throw vigorBuyError(`VigorBuy verifica ${shortUrl}: troppi redirect senza pagina prodotto`, {
    retryable: false,
    verify: true,
  });
}

/**
 * Una singola chiamata allo shortener, con gli stessi header del pulsante
 * "Share" del sito. Nonce e firma sono nuovi a ogni chiamata.
 */
async function requestVigorBuyShortUrl(longUrl) {
  const nonce = randomUUID().toLowerCase();
  const signature = buildVigorBuySignature(nonce);

  const headers = {
    accept: "application/json",
    "accept-language": "it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7",
    "cache-control": "no-cache",
    "content-type": "application/json",
    language: "en",
    origin: "https://vigorbuy.com",
    pragma: "no-cache",
    referer: "https://vigorbuy.com/",
    timezone: "Europe/Rome",
    "user-agent": REAL_UA,
    "x-nonce": nonce,
    "x-platform": "web",
    "x-signature": signature,
    "x-version": VIGORBUY_SIGN_VERSION,
  };

  // Contesto di sessione: letto da .env.local, mai scritto nel codice.
  if (VIGORBUY_CLIENT_ID) headers["x-client-id"] = VIGORBUY_CLIENT_ID;
  if (VIGORBUY_TOKEN) headers["x-token"] = VIGORBUY_TOKEN;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), VIGORBUY_TIMEOUT_MS);

  let status = 0;
  let raw = "";

  try {
    const response = await fetch(VIGORBUY_SHORTEN_API, {
      method: "POST",
      headers,
      body: JSON.stringify({ url: longUrl }),
      signal: controller.signal,
    });

    status = response.status;
    raw = await response.text();
  } catch (err) {
    if (err?.name === "AbortError") throw vigorBuyError(`VigorBuy timeout dopo ${VIGORBUY_TIMEOUT_MS}ms`);
    throw err;
  } finally {
    clearTimeout(timer);
  }

  let data = null;
  try {
    data = JSON.parse(raw);
  } catch {}

  const httpOk = status >= 200 && status < 300;
  const isObj = !!data && typeof data === "object";

  if (!httpOk || !isObj || Number(data.code) !== 0) {
    const msg = isObj ? String(data.msg || data.message || "").trim() : "";

    // Risposta non JSON = non arriva dall'API VigorBuy ma da qualcosa in mezzo
    // (challenge anti-bot, proxy, firewall). Non è un problema di token e non
    // va confuso con quello: si ritenta e, se continua, ci pensa il breaker.
    if (!isObj && status !== 401) {
      const snippet = raw.replace(/\s+/g, " ").trim().slice(0, 120);
      const antiBot = /cloudflare|cf-ray|just a moment|attention required|captcha/i.test(raw);
      throw vigorBuyError(
        antiBot
          ? `VigorBuy bloccato da protezione anti-bot (HTTP ${status})`
          : `VigorBuy risposta non JSON (HTTP ${status})${snippet ? `: ${snippet}` : ""}`
      );
    }

    if (status === 401 || status === 403 || /token|login|auth|unauthorized|expired|登录|登錄|未授权/i.test(msg)) {
      throw vigorBuyError(
        `VIGORBUY_TOKEN_EXPIRED: update VIGORBUY_TOKEN in .env.local (HTTP ${status}${
          isObj ? ` code=${data.code}` : ""
        }${msg ? ` msg=${msg.slice(0, 120)}` : ""})`,
        { retryable: false, auth: true }
      );
    }

    throw vigorBuyError(`VigorBuy HTTP ${status}: code=${data.code} msg=${(msg || raw).slice(0, 180)}`);
  }

  const payload = data.data;
  const shortUrl = String((typeof payload === "string" ? payload : payload?.url) || "").trim();

  if (!isValidVigorBuyShortUrl(shortUrl)) {
    throw vigorBuyError(`VigorBuy shorten rifiutato: url non valido "${shortUrl.slice(0, 80)}"`);
  }

  return shortUrl;
}

function describeVigorBuyFirstError() {
  return vigorbuyStats.firstError ? ` Primo errore: ${vigorbuyStats.firstError}` : "";
}

function tripVigorBuyBreaker() {
  vigorbuyStats.consecutiveFails += 1;
  if (!vigorbuyStats.disabled && vigorbuyStats.consecutiveFails >= VIGORBUY_BREAKER_THRESHOLD) {
    vigorbuyStats.disabled = true;
    console.log(
      `🔌 VigorBuy disattivato per questa run dopo ${vigorbuyStats.consecutiveFails} fallimenti consecutivi. I link Weidian originali restano nel foglio.${describeVigorBuyFirstError()}`
    );
  }
}

/**
 * Token scaduto/cambiato: insistere non serve, quindi si apre subito il
 * breaker, ma con un messaggio che dice esattamente cosa fare.
 */
function disableVigorBuyForAuth(reason) {
  if (vigorbuyStats.authError) return;

  vigorbuyStats.authError = true;
  vigorbuyStats.disabled = true;

  console.log("🚨 VIGORBUY TOKEN SCADUTO O CAMBIATO");
  console.log(
    VIGORBUY_TOKEN
      ? "   Aggiorna VIGORBUY_TOKEN nel file .env.local"
      : "   VIGORBUY_TOKEN mancante: aggiungilo nel file .env.local"
  );
  console.log(`   Dettaglio: ${reason}`);
  console.log("   VigorBuy disattivato per questa run: i link Weidian originali restano nel foglio.");
}

async function createVigorBuyShortUrl(weidianUrl) {
  if (!VIGORBUY_ENABLED || vigorbuyStats.disabled) return "";

  const itemId = extractWeidianItemId(weidianUrl);
  if (!itemId) return "";

  const cacheKey = `${itemId}||${VIGORBUY_INVITE_CODE}`;
  const cached = _vigorbuyShortCache.get(cacheKey);
  if (cached) {
    vigorbuyStats.cacheHit += 1;
    return cached;
  }

  const longUrl = buildVigorBuyLongUrlFromWeidian(weidianUrl);
  if (!longUrl) return "";

  let lastError = null;

  // Se la creazione riesce ma la verifica ha un errore di rete, i tentativi
  // successivi ripetono solo la verifica: non si crea un secondo link corto.
  let createdShortUrl = "";

  for (let attempt = 1; attempt <= VIGORBUY_RETRIES; attempt++) {
    try {
      if (!createdShortUrl) createdShortUrl = await requestVigorBuyShortUrl(longUrl);

      // Solo un link verificato entra in cache e nel foglio.
      if (VIGORBUY_VERIFY) await verifyVigorBuyShortUrl(createdShortUrl, itemId);

      _vigorbuyShortCache.set(cacheKey, createdShortUrl);
      vigorbuyStats.ok += 1;
      vigorbuyStats.consecutiveFails = 0;

      console.log(`🔗 VigorBuy ${itemId} -> ${createdShortUrl}${VIGORBUY_VERIFY ? " (verificato)" : ""}`);
      return createdShortUrl;
    } catch (err) {
      lastError = err;
      if (err?.vigorbuyRetryable === false) break;
      if (attempt < VIGORBUY_RETRIES) {
        await sleep(Math.min(8000, 700 * Math.pow(2, attempt - 1)));
      }
    }
  }

  const reason = firstLine(lastError?.message || lastError || "unknown");

  vigorbuyStats.fail += 1;
  if (lastError?.vigorbuyVerify) vigorbuyStats.verifyFail += 1;
  if (!vigorbuyStats.firstError) vigorbuyStats.firstError = reason;

  // Prima l'errore vero dell'item, poi (eventualmente) il messaggio del breaker.
  console.log(`⚠️ VigorBuy conversion failed item=${itemId}; mantengo Weidian originale. -> ${reason}`);

  if (lastError?.vigorbuyAuth) {
    disableVigorBuyForAuth(reason);
  } else {
    tripVigorBuyBreaker();
  }

  return "";
}

async function convertExternalSourceToVigorBuy(sourceUrl) {
  const source = String(sourceUrl || "").trim();
  if (!source) return "";

  // La formula /product/2/{itemID} è verificata solo per Weidian.
  // Taobao e 1688 restano invariati.
  if (!extractWeidianItemId(source)) {
    vigorbuyStats.skippedNonWeidian += 1;
    return source;
  }

  const shortUrl = await createVigorBuyShortUrl(source);

  // Se lo shortener fallisce non perdiamo il prodotto: resta il link Weidian.
  return shortUrl || source;
}

// =====================
// SOURCE LINK: preferenza piattaforma
// =====================
function normalizeSourcePreference(value) {
  const s = String(value || "").trim().toLowerCase();

  if (!s || s === "auto" || s === "automatic" || s === "automatico") return "auto";
  if (s === "taobao" || s === "tb") return "taobao";
  if (s === "weidian" || s === "wd") return "weidian";

  // Valore sconosciuto: non blocchiamo il job, torniamo ad AUTO.
  return "auto";
}

function detectSourcePlatform(url) {
  const s = String(url || "").trim();
  if (!s) return "";

  if (isTaobaoItemUrl(s)) return "taobao";
  if (isWeidianItemUrl(s) || s.includes("v.weidian.com/item.html")) return "weidian";
  if (is1688OfferUrl(s)) return "1688";

  return "";
}

/**
 * AUTO preferisce Weidian: è l'unica piattaforma che VigorBuy converte,
 * quindi è quella che genera commissione.
 * source=taobao / source=weidian sono forzature strette: se la piattaforma
 * richiesta non c'è, non ripieghiamo su un'altra.
 */
async function pickPreferredSourceUrl(context, rawLinks, sourcePreference = "auto") {
  const preference = normalizeSourcePreference(sourcePreference);

  const decoded = dedupeStrings(
    dedupeStrings(rawLinks || []).map((u) => String(decodeYupooExternalUrl(u) || "").trim())
  );

  const directTaobao = [];
  const directWeidian = [];
  const direct1688 = [];
  const shortLinks = [];

  for (const u of decoded) {
    if (isTaobaoItemUrl(u)) {
      directTaobao.push(canonicalizeTaobaoItemUrl(u));
      continue;
    }
    if (isWeidianItemUrl(u) || u.includes("v.weidian.com/item.html")) {
      directWeidian.push(canonicalizeWeidianItemUrl(u));
      continue;
    }
    if (is1688OfferUrl(u)) {
      direct1688.push(canonicalize1688OfferUrl(u));
      continue;
    }
    if (isShortRedirectUrl(u)) shortLinks.push(u);
  }

  // Se la piattaforma è forzata e abbiamo già un diretto, evitiamo di risolvere
  // short link inutili.
  if (preference === "taobao" && directTaobao.length) return directTaobao[0];
  if (preference === "weidian" && directWeidian.length) return directWeidian[0];
  if (preference === "auto" && directWeidian.length) return directWeidian[0];

  // Un Taobao può nascondersi dietro m.tb.cn e un Weidian dietro youshop10.
  const resolvedTaobao = [];
  const resolvedWeidian = [];
  const resolved1688 = [];

  for (const u0 of shortLinks) {
    const resolved = await resolveFinalUrl(context, u0);
    const u = String(decodeYupooExternalUrl(resolved || u0) || "").trim();

    if (isTaobaoItemUrl(u)) {
      resolvedTaobao.push(canonicalizeTaobaoItemUrl(u));
      continue;
    }
    if (isWeidianItemUrl(u) || u.includes("v.weidian.com/item.html")) {
      resolvedWeidian.push(canonicalizeWeidianItemUrl(u));
      continue;
    }
    if (is1688OfferUrl(u)) resolved1688.push(canonicalize1688OfferUrl(u));
  }

  if (preference === "taobao") return resolvedTaobao[0] || "";
  if (preference === "weidian") return resolvedWeidian[0] || "";

  // AUTO: Weidian > Taobao > 1688
  return (
    directWeidian[0] ||
    resolvedWeidian[0] ||
    directTaobao[0] ||
    resolvedTaobao[0] ||
    direct1688[0] ||
    resolved1688[0] ||
    ""
  );
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

/**
 * Conta le righe usate guardando più colonne chiave.
 * Guardare solo la colonna A era pericoloso: una riga con A vuota ma Q piena
 * faceva calcolare male nextAppendRow e sovrascriveva dati esistenti.
 */
async function getSheetRowCount(sheets) {
  const tab = sheetA1Tab(SHEET_TAB);
  const res = await sheets.spreadsheets.values.batchGet({
    spreadsheetId: SHEET_ID,
    ranges: [`${tab}!A2:A`, `${tab}!C2:C`, `${tab}!Q2:Q`],
  });

  const ranges = res.data.valueRanges || [];
  let max = 0;

  for (const r of ranges) {
    const values = r.values || [];
    // Ignoriamo le righe finali completamente vuote.
    let last = 0;
    for (let i = 0; i < values.length; i++) {
      const cell = String(values[i]?.[0] || "").trim();
      if (cell) last = i + 1;
    }
    max = Math.max(max, last);
  }

  return max;
}

async function loadExistingIndex(sheets) {
  const count = await getSheetRowCount(sheets);

  if (count <= 0) {
    return { existingSlugs: new Set(), nameCounters: new Map(), byKey: new Map(), nextAppendRow: 2 };
  }

  const lastRow = count + 1;
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: sheetRange(2, lastRow),
  });

  const values = res.data.values || [];

  const existingSlugs = new Set();
  const nameCounters = new Map();
  const byKey = new Map();

  for (let i = 0; i < values.length; i++) {
    const rowNumber = 2 + i;
    const row = padToLen(values[i]);

    const slug = String(row[COL.SLUG] || "").trim();
    if (slug) existingSlugs.add(slug);

    const title = String(row[COL.TITLE] || "").trim();
    const seller = String(row[COL.SELLER] || "").trim().toLowerCase();

    if (title) {
      const { base, idx } = splitBaseAndIndex(title);
      const k = seller ? `${base}||${seller}` : base;
      nameCounters.set(k, Math.max(nameCounters.get(k) || 0, idx));
    }

    const sourceUrl = String(row[COL.SOURCE_URL] || "").trim();
    if (sourceUrl) byKey.set(`${seller}||${normalizeItemUrl(sourceUrl)}`, { rowNumber, rowValues: row });
  }

  return { existingSlugs, nameCounters, byKey, nextAppendRow: count + 2 };
}

async function writeRowsByExplicitRow(sheets, rows, startRow, batchSize = 50) {
  if (!rows.length) return startRow;

  const batches = Math.ceil(rows.length / batchSize);
  console.log(`\n🧾 WRITE su Sheet in ${batches} batch (size=${batchSize}) a partire da riga ${startRow}...`);

  let cur = startRow;

  for (let i = 0; i < batches; i++) {
    const slice = rows.slice(i * batchSize, (i + 1) * batchSize);
    const endRow = cur + slice.length - 1;
    const range = sheetRange(cur, endRow);

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

// =====================
// AUTH (storageState) + prime photo.yupoo.com
// =====================
async function tryExtractFirstAlbumUrl(page) {
  return page
    .evaluate(() => {
      const a = document.querySelector('a.album__main[href*="/albums/"]') || document.querySelector('a[href*="/albums/"]');
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
          i.getAttribute("data-src") || i.getAttribute("data-original") || i.getAttribute("data-lazy") || i.getAttribute("src") || "";
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
  console.log("   Se stai usando YUPOO: dobbiamo settare cookie anche su photo.yupoo.com.");

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

  if (sp) ensureDirFor(sp);

  await ctx.storageState({ path: sp });
  await ctx.close();

  console.log("✅ Sessione salvata in:", sp);
  return sp;
}

async function rescueIfRestricted(context, storageAbs, primeUrl) {
  return restrictedRescueMutex.runExclusive(async () => {
    // Se un altro worker ha appena completato una rescue, non apriamo subito
    // un'altra challenge: lasciamo stabilizzare cookie/sessione e riproviamo.
    const sinceLast = Date.now() - lastRestrictedRescueAt;
    if (lastRestrictedRescueAt > 0 && sinceLast < YUPOO_RESCUE_COOLDOWN_MS) {
      const waitMs = Math.max(1200, YUPOO_RESCUE_COOLDOWN_MS - sinceLast);
      console.log(`\n🧊 Rescue già eseguita da poco: aspetto ${(waitMs / 1000).toFixed(1)}s prima del retry...`);
      await sleep(waitMs);
      return;
    }

    console.log("\n🛟 BLOCCO RILEVATO (567/Restricted).");
    console.log("   Metto in pausa gli altri rescue e apro UNA sola pagina per la challenge.");

    let p = null;
    let p2 = null;

    try {
      p = await context.newPage();
      await safeGoto(p, primeUrl, {
        retries: 1,
        timeout: NAV_TIMEOUT,
        allowRestricted: true,
      });
      await p.waitForTimeout(1200);

      console.log("\n➡️  Risolvi la challenge nella finestra del browser.");
      console.log("   Dopo che la pagina Yupoo è tornata normale, aspetta qualche secondo.");
      await waitEnter("✅ Premi INVIO quando hai risolto; stabilizzo cookie/sessione e continuo... ");

      // Non ripartiamo immediatamente dopo INVIO: alcuni cookie/challenge token
      // vengono completati pochi istanti dopo la navigazione manuale.
      await p.waitForTimeout(YUPOO_RESCUE_SETTLE_MS);

      // Solo DOPO la risoluzione proviamo a toccare photo.yupoo.com, così non
      // generiamo una seconda richiesta bloccata mentre la challenge è ancora attiva.
      try {
        const photo = await tryExtractFirstPhotoUrl(p);
        if (photo) {
          p2 = await context.newPage();
          await safeGoto(p2, photo, {
            retries: 1,
            timeout: 45000,
            allowRestricted: true,
          });
          await p2.waitForTimeout(1200);
        }
      } catch (e) {
        console.log("⚠️ Prime photo.yupoo.com non riuscito, continuo con la sessione principale:", firstLine(e?.message || e));
      }

      if (storageAbs) {
        ensureDirFor(storageAbs);
        await context.storageState({ path: storageAbs });
      }

      lastRestrictedRescueAt = Date.now();
      console.log(`✅ Sessione aggiornata. Attendo ${(YUPOO_RESCUE_SETTLE_MS / 1000).toFixed(1)}s prima di riprendere...`);
      await sleep(YUPOO_RESCUE_SETTLE_MS);
    } finally {
      if (p2) {
        try {
          await p2.close();
        } catch {}
      }
      if (p) {
        try {
          await p.close();
        } catch {}
      }
    }
  });
}

// =====================
// YUPOO: paginazione categoria
// =====================
async function detectCategoryTotalPages(page) {
  return page
    .evaluate(() => {
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

      const patterns = [/共\s*(\d+)\s*页/i, /page\s*\d+\s*of\s*(\d+)/i, /page\s*\d+\s*\/\s*(\d+)/i, /of\s*(\d+)\s*pages?/i];
      const patternsNoSpace = [/page\d+of(\d+)/i, /page\d+\/(\d+)/i, /of(\d+)pages?/i, /共(\d+)页/i];

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

      const max = nums.length ? Math.max(...nums) : 1;
      return max > 0 ? max : 1;
    })
    .catch(() => 1);
}

async function getNextPageNumberFromDom(page) {
  return page
    .evaluate(() => {
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
        return cls.includes("disabled") || cls.includes("pagination__disabled") || title.includes("disabled") || ariaDisabled === "true";
      };

      const looksLikeNext = (a) => {
        const title = (a.getAttribute("title") || "").toLowerCase();
        if (title.includes("后一页") || title.includes("next")) return true;
        if (a.querySelector("i.icon_next, .icon_next")) return true;
        return (a.getAttribute("class") || "").toLowerCase().includes("icon_next");
      };

      for (const a of all) {
        if (!looksLikeNext(a) || isDisabled(a)) continue;
        const href = (a.getAttribute("href") || "").trim();
        if (!href) continue;

        const m = href.match(/(?:\?|&)page\s*=\s*(\d+)/i);
        if (m && m[1]) {
          const n = parseInt(m[1], 10);
          return Number.isFinite(n) ? n : 0;
        }
      }

      return 0;
    })
    .catch(() => 0);
}

// =====================
// SCRAPE: CATEGORIA YUPOO
// =====================
async function scrapeCategory(context, categoryUrl, maxPagesCap = 0, storageAbsForRescue = "", primeUrlForRescue = "") {
  const page = await context.newPage();
  const albumUrls = new Set();
  const coverByAlbum = new Map();
  const cardTextByAlbum = new Map();

  let pagesDetected = 1;
  let pagesVisited = 0;
  let stoppedEarly = false;

  const cap = Number(maxPagesCap || 0) > 0 ? Math.floor(Number(maxPagesCap)) : 0;

  function buildCategoryPageUrl(baseUrl, pageNum) {
    const u = new URL(baseUrl);
    if (pageNum <= 1) {
      u.searchParams.delete("page");
      return u.toString();
    }
    u.searchParams.set("page", String(pageNum));
    return u.toString();
  }

  async function collectAlbumCardsFast() {
    const found = await page
      .evaluate(() => {
        const anchors = Array.from(document.querySelectorAll('a.album__main[href*="/albums/"], a[href*="/albums/"]'));

        const pickFromAttrs = (el) => {
          if (!el) return "";
          for (const k of ["src", "data-src", "data-original", "data-lazy", "data-lazy-src"]) {
            const v = (el.getAttribute(k) || "").trim();
            if (!v || v.startsWith("data:") || v === "about:blank") continue;
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

        const hasMoney = (tx) => /(?:¥|￥|元|\$|\bUSD\b|\bCNY\b|\bRMB\b)/i.test(tx);

        const out = [];

        for (const a of anchors) {
          const href = (a.getAttribute("href") || "").trim();
          if (!href.includes("/albums/")) continue;

          const rawImg = pickImgUrlFromAnchor(a);

          // Il prezzo è spesso nel nome della card ("208¥DIPLOMATIC ZIPSET"):
          // conserviamo quel testo come fallback.
          const cardCandidates = [
            a,
            a.closest(".album__listwrap"),
            a.closest(".album__item"),
            a.closest(".showindex__children"),
            a.closest("li"),
            a.closest("article"),
            a.parentElement,
            a.parentElement?.parentElement,
          ].filter(Boolean);

          const texts = [];
          for (const node of cardCandidates) {
            const tx = String(node?.innerText || node?.textContent || "").replace(/\s+/g, " ").trim();
            if (!tx || tx.length > 700) continue;
            if (!texts.includes(tx)) texts.push(tx);
          }

          const cardText =
            texts.filter(hasMoney).sort((x, y) => x.length - y.length)[0] ||
            texts.sort((x, y) => x.length - y.length)[0] ||
            "";

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

          if (hrefAbs) out.push({ hrefAbs, imgAbs, cardText });
        }

        return out;
      })
      .catch(() => []);

    const before = albumUrls.size;
    const hasMoney = (tx) => /(?:¥|￥|元|\$|\bUSD\b|\bCNY\b|\bRMB\b)/i.test(tx);

    for (const it of found) {
      const hrefAbs = String(it?.hrefAbs || "").trim();
      if (!hrefAbs) continue;

      const normAlbum = normalizeAlbumUrl(hrefAbs);
      albumUrls.add(normAlbum);

      const imgAbs = String(it?.imgAbs || "").trim();
      if (imgAbs && !coverByAlbum.has(normAlbum)) coverByAlbum.set(normAlbum, toHttpsUrl(imgAbs));

      const cardText = String(it?.cardText || "").replace(/\s+/g, " ").trim();
      if (!cardText) continue;

      const prev = String(cardTextByAlbum.get(normAlbum) || "");
      const better =
        !prev ||
        (!hasMoney(prev) && hasMoney(cardText)) ||
        (hasMoney(prev) === hasMoney(cardText) && cardText.length > prev.length);

      if (better) cardTextByAlbum.set(normAlbum, cardText);
    }

    return { foundCount: found.length, newCount: albumUrls.size - before };
  }

  async function collectWithRetryIfEmpty() {
    let c = await collectAlbumCardsFast();
    if (c.foundCount > 0) return c;

    await page.waitForTimeout(550);
    await fastScroll(page);
    return collectAlbumCardsFast();
  }

  try {
    const page1Url = buildCategoryPageUrl(categoryUrl, 1);

    console.log(`\n📄 Pagina categoria 1: ${page1Url}`);
    try {
      await safeGoto(page, page1Url, { retries: 2, timeout: NAV_TIMEOUT });
    } catch (e) {
      const msg = String(e?.message || e);
      if (msg.toLowerCase().includes("restricted") && storageAbsForRescue) {
        await rescueIfRestricted(context, storageAbsForRescue, primeUrlForRescue || categoryUrl);
        await safeGoto(page, page1Url, { retries: 1, timeout: NAV_TIMEOUT });
      } else throw e;
    }

    await page.waitForSelector('a[href*="/albums/"]', { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(300);

    pagesDetected = await detectCategoryTotalPages(page);
    console.log(`📚 Pagine totali (best-effort): ${pagesDetected}${cap ? ` | cap maxPages=${cap}` : ""}`);

    pagesVisited = 1;
    let current = 1;

    const c1 = await collectWithRetryIfEmpty();
    console.log(`📦 Album trovati finora: ${albumUrls.size} (page1 found=${c1.foundCount}, new=${c1.newCount})`);

    let safety = 0;

    while (true) {
      if (cap && current >= cap) break;

      const detHere = await detectCategoryTotalPages(page);
      pagesDetected = Math.max(pagesDetected, detHere, current);

      const nextPage = await getNextPageNumberFromDom(page);
      if (!nextPage || nextPage <= current) break;

      const nextUrl = buildCategoryPageUrl(categoryUrl, nextPage);
      console.log(`\n📄 Pagina categoria ${nextPage}: ${nextUrl}`);

      try {
        await safeGoto(page, nextUrl, { retries: 2, timeout: NAV_TIMEOUT });
      } catch (e) {
        const msg = String(e?.message || e);
        if (msg.toLowerCase().includes("restricted") && storageAbsForRescue) {
          await rescueIfRestricted(context, storageAbsForRescue, primeUrlForRescue || categoryUrl);
          await safeGoto(page, nextUrl, { retries: 1, timeout: NAV_TIMEOUT });
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

      if (++safety > 300) {
        stoppedEarly = true;
        console.log("🛑 STOP: safety limit (300 pagine) raggiunto.");
        break;
      }
    }

    const detEnd = await detectCategoryTotalPages(page);
    pagesDetected = Math.max(pagesDetected, detEnd, pagesVisited);

    console.log(
      `\n📌 CATEGORY DONE | pagesVisited=${pagesVisited} | pagesDetected(best)=${pagesDetected}${stoppedEarly ? " | STOP-EARLY" : ""}`
    );
  } finally {
    try {
      await page.close();
    } catch {}
  }

  return { albumUrls: Array.from(albumUrls), coverByAlbum, cardTextByAlbum, pagesDetected, pagesVisited, stoppedEarly };
}

// =====================
// 1688: paginazione shop
// =====================
async function detect1688TotalPages(page) {
  return page
    .evaluate(() => {
      const nums = [];
      const add = (x) => {
        const n = parseInt(String(x || ""), 10);
        if (Number.isFinite(n) && n > 0) nums.push(n);
      };

      document.querySelectorAll('a[href*="pageNum="]').forEach((a) => {
        const m = (a.getAttribute("href") || "").match(/pageNum\s*=\s*(\d+)/i);
        if (m && m[1]) add(m[1]);
        const t = (a.textContent || "").trim();
        if (t) add(t);
      });

      const txt = (document.body?.innerText || "").replace(/\s+/g, " ").trim();

      const m1 = txt.match(/共\s*(\d+)\s*页/i);
      if (m1 && m1[1]) add(m1[1]);

      const m2 = txt.match(/(\d+)\s*\/\s*(\d+)/);
      if (m2 && m2[2]) add(m2[2]);

      return nums.length ? Math.max(...nums) : 1;
    })
    .catch(() => 1);
}

async function getNext1688PageNumberFromDom(page) {
  return page
    .evaluate(() => {
      const anchors = Array.from(document.querySelectorAll("a[href]"));

      const looksNext = (a) => {
        const t = (a.textContent || "").trim().toLowerCase();
        const cls = (a.getAttribute("class") || "").toLowerCase();
        return t.includes("下一页") || t.includes("next") || cls.includes("next");
      };

      for (const a of anchors) {
        if (!looksNext(a)) continue;
        const m = (a.getAttribute("href") || "").match(/pageNum\s*=\s*(\d+)/i);
        if (m && m[1]) return parseInt(m[1], 10) || 0;
      }

      let max = 0;
      for (const a of anchors) {
        const m = (a.getAttribute("href") || "").match(/pageNum\s*=\s*(\d+)/i);
        if (m && m[1]) {
          const n = parseInt(m[1], 10);
          if (Number.isFinite(n)) max = Math.max(max, n);
        }
      }
      return max || 0;
    })
    .catch(() => 0);
}

async function scrape1688ShopOfferList(context, listUrl, maxPagesCap = 0) {
  const page = await context.newPage();
  const offerUrls = new Set();
  const coverByOffer = new Map();

  let pagesVisited = 0;
  let pagesDetected = 1;
  let stoppedEarly = false;

  const cap = Number(maxPagesCap || 0) > 0 ? Math.floor(Number(maxPagesCap)) : 0;

  async function collectOffersOnPage() {
    const items = await page
      .evaluate(() => {
        const attrs = ["data-src", "data-lazy", "data-original", "data-lazy-src", "src"];

        const pickImg = (a) => {
          const img = a.querySelector("img");
          if (!img) return "";
          for (const k of attrs) {
            const v = (img.getAttribute(k) || "").trim();
            if (!v || v.startsWith("data:") || v === "about:blank") continue;
            return v;
          }
          return "";
        };

        const out = [];
        const anchors = Array.from(document.querySelectorAll('a[href*="/offer/"], a[href*="detail.1688.com/offer"]'));

        for (const a of anchors) {
          const href = (a.getAttribute("href") || "").trim();
          if (!href) continue;

          let hrefAbs = "";
          try {
            hrefAbs = new URL(href, location.href).toString();
          } catch {}
          if (!hrefAbs) continue;

          const imgRaw = pickImg(a);
          let imgAbs = "";
          if (imgRaw) {
            try {
              imgAbs = new URL(imgRaw, location.href).toString();
            } catch {}
          }

          out.push({ hrefAbs, imgAbs });
        }

        return out;
      })
      .catch(() => []);

    const before = offerUrls.size;

    for (const it of items) {
      const hrefAbs = String(it?.hrefAbs || "").trim();
      if (!hrefAbs || !/\/offer\/\d+\.html/i.test(hrefAbs)) continue;

      const canon = canonicalize1688OfferUrl(hrefAbs);
      offerUrls.add(canon);

      const imgAbs = toBigAlicdnUrl(toHttpsMaybe(it?.imgAbs || ""));
      if (imgAbs && !coverByOffer.has(canon)) coverByOffer.set(canon, imgAbs);
    }

    return { found: items.length, newCount: offerUrls.size - before };
  }

  try {
    const u1 = new URL(listUrl);
    if (!u1.searchParams.get("pageNum")) u1.searchParams.set("pageNum", "1");

    console.log(`\n📄 1688SHOP list page 1: ${u1.toString()}`);
    await safeGoto(page, u1.toString(), { retries: 2, timeout: NAV_TIMEOUT });
    await page.waitForTimeout(450);

    pagesDetected = await detect1688TotalPages(page);
    console.log(`📚 1688 pagesDetected(best-effort): ${pagesDetected}${cap ? ` | cap maxPages=${cap}` : ""}`);

    pagesVisited = 1;

    const c1 = await collectOffersOnPage();
    console.log(`📦 Offer trovate finora: ${offerUrls.size} (found=${c1.found}, new=${c1.newCount})`);

    let safety = 0;
    let current = 1;

    while (true) {
      if (cap && current >= cap) break;

      const nextPage = await getNext1688PageNumberFromDom(page);
      if (!nextPage || nextPage <= current) break;

      const u = new URL(listUrl);
      u.searchParams.set("pageNum", String(nextPage));

      console.log(`\n📄 1688SHOP list page ${nextPage}: ${u.toString()}`);
      await safeGoto(page, u.toString(), { retries: 2, timeout: NAV_TIMEOUT });
      await page.waitForTimeout(380);

      current = nextPage;
      pagesVisited = current;

      const c = await collectOffersOnPage();
      console.log(`📦 Offer trovate finora: ${offerUrls.size} (found=${c.found}, new=${c.newCount})`);

      if (c.found === 0) {
        stoppedEarly = true;
        console.log(`🛑 STOP: nessun offer trovato a pageNum=${current}`);
        break;
      }

      if (++safety > 300) {
        stoppedEarly = true;
        console.log("🛑 STOP: safety limit (300 pagine) raggiunto.");
        break;
      }
    }

    pagesDetected = Math.max(pagesDetected, pagesVisited);
    console.log(
      `\n📌 1688SHOP DONE | pagesVisited=${pagesVisited} | pagesDetected(best)=${pagesDetected}${stoppedEarly ? " | STOP-EARLY" : ""}`
    );
  } finally {
    try {
      await page.close();
    } catch {}
  }

  return {
    albumUrls: Array.from(offerUrls),
    coverByAlbum: coverByOffer,
    cardTextByAlbum: new Map(),
    pagesDetected,
    pagesVisited,
    stoppedEarly,
  };
}

// =====================
// TITOLO ALBUM YUPOO
// =====================
async function getAlbumTitle(page) {
  await page
    .waitForFunction(
      () => {
        const el = document.querySelector(".showalbumheader__gallerytitle");
        if (!el) return false;
        return (el.getAttribute("data-name") || el.textContent || "").trim().length > 0;
      },
      { timeout: 12000 }
    )
    .catch(() => {});

  const title = await page
    .evaluate(() => {
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
    })
    .catch(() => "");

  return String(title || "").replace(/\s+/g, " ").trim();
}

// =====================
// IDENTITÀ PRODOTTO (brand + categoria + titolo)
// =====================
/**
 * Logica condivisa fra Yupoo e 1688: prima era duplicata nelle due funzioni di
 * scraping e le due copie avevano divergato (su 1688 l'AI brand girava su ogni
 * singola offerta).
 *
 * Regole:
 * - categoria: SOLO keyword. L'AI non la decide mai.
 * - brand: AI solo se richiesto AUTO e le keyword non hanno riconosciuto nulla.
 * - titolo: FORCE / ALBUM / AUTO come da jobOptions.
 */
async function resolveProductIdentity({
  context,
  itemUrl,
  itemLabel,
  titleRaw,
  bodyText,
  crumbText = "",
  categoryCardText = "",
  brandRaw,
  catRaw,
  img1Final,
  titleMode,
  titleForced,
  aiEnabled,
  shoeNameEnabled,
}) {
  const wantsAutoBrand = !brandRaw || brandRaw.toUpperCase() === "AUTO";
  const wantsAutoCat = !catRaw || catRaw.toUpperCase() === "AUTO";

  const detectedType = detectProductTypeFromSignals(titleRaw, crumbText, bodyText, categoryCardText);

  // L'AI brand costa una chiamata vision: la usiamo solo quando i testi non
  // hanno riconosciuto nemmeno la categoria, cioè quando la card è muta.
  const shouldAiBrand = wantsAutoBrand && detectedType === "OTHER" && !!img1Final;

  let aiBrand = "";
  if (aiEnabled && shouldAiBrand) {
    try {
      aiBrand = await aiDetectBrandFromCover(context, img1Final, titleRaw, bodyText, itemUrl, { aiEnabled });
    } catch (e) {
      logAiDebug("brand detect wrapper failed", firstLine(e?.message || e));
    }
  }

  let finalCategory;
  if (!wantsAutoCat && catRaw) {
    const forced = canonicalizeCategory(catRaw);
    finalCategory = ALLOWED_TYPES.has(forced) ? forced : "OTHER";
  } else {
    finalCategory = ALLOWED_TYPES.has(detectedType) ? detectedType : "OTHER";
  }

  if (wantsAutoCat) {
    console.log(`🏷️ CATEGORY AUTO | item=${itemLabel || "?"} | ${finalCategory}`);
  }

  const finalBrand = !wantsAutoBrand && brandRaw ? brandRaw : shouldAiBrand ? aiBrand : "";
  const brandHint = (String(finalBrand || "").trim() || String(brandRaw || "").trim()).trim();

  let titleBase = "";

  if (titleMode === "FORCE") {
    titleBase = maybePrefixBrand(titleForced, brandHint);
    if (!titleBase) titleBase = buildDisplayName(titleRaw, finalBrand, finalCategory);
  } else if (titleMode === "ALBUM") {
    titleBase = String(titleRaw || "").trim() || buildDisplayName(titleRaw, finalBrand, finalCategory);
  } else if (FOOTWEAR_TYPES.has(finalCategory)) {
    const tryShoeNameAi = shoeNameEnabled && shouldTryShoeNameAi(titleRaw, crumbText, bodyText);

    const shoeNameRaw = tryShoeNameAi
      ? await aiDetectFootwearNameFromCover(context, img1Final, brandHint, titleRaw, bodyText, itemUrl, {
          aiEnabled,
          shoeNameEnabled,
        })
      : "";

    const shoeName = removeRedundantBrandPrefix(shoeNameRaw, brandHint);

    if (shoeName) {
      const hasBrandAlready = brandHint && normalizeBrandForCompare(shoeName).includes(normalizeBrandForCompare(brandHint));
      titleBase = hasBrandAlready || !brandHint ? shoeName.trim() : `${brandHint.toUpperCase()} ${shoeName}`.trim();
    } else {
      titleBase = buildDisplayName(titleRaw, finalBrand, finalCategory);
    }
  } else {
    titleBase = buildDisplayName(titleRaw, finalBrand, finalCategory);
  }

  // Ultimo passaggio sul nome:
  // - sempre: rimuove il prezzo
  // - solo titleMode=AUTO: rimuove cinese e contenuto fra parentesi tonde
  // - mantiene numeri e modelli (B30, B22, Sabrina 3, Jordan 4, 2.0, 990 v6)
  titleBase = finalizeProductTitle(titleBase, titleRaw, titleMode);

  return { finalBrand: String(finalBrand || "").trim(), finalCategory: finalCategory || "OTHER", titleBase };
}

// =====================
// SCRAPE: OFFERTA 1688
// =====================
async function scrape1688OfferOnPage(page, context, offerUrl, opts) {
  const { categoryOverride, seller, brand, img1Pick, coverUrlFromList, jobOptions } = opts;

  const normUrl = canonicalize1688OfferUrl(offerUrl);
  const itemLabel = extract1688OfferId(normUrl) || normUrl;

  const titleForced = String(jobOptions.title || "").trim();
  const titleMode = normalizeTitleMode(jobOptions.titleMode, titleForced);
  const aiEnabled = isAiEnabledForJob(jobOptions.ai);
  const shoeNameEnabled = isShoeNameEnabledForJob(jobOptions.shoeName, aiEnabled);

  await safeGoto(page, normUrl, { retries: 2, timeout: NAV_TIMEOUT });
  await page.waitForTimeout(550);

  const bodyText = await page.evaluate(() => document.body?.innerText || "").catch(() => "");
  const html = await page.content().catch(() => "");

  const titleRaw = await page
    .evaluate(() => {
      const og = document.querySelector('meta[property="og:title"]')?.getAttribute("content") || "";
      if (og) return og.trim();
      const h1 = document.querySelector("h1")?.textContent || "";
      if (h1) return h1.trim();
      return (document.title || "").trim();
    })
    .catch(() => "");

  const domImages = await page
    .evaluate(() => {
      const attrs = ["data-src", "data-lazy", "data-original", "data-lazy-src", "src"];
      const out = [];

      const add = (raw) => {
        const r = String(raw || "").trim();
        if (!r || r.startsWith("data:") || r === "about:blank") return;
        out.push(r.startsWith("//") ? `https:${r}` : r);
      };

      document.querySelectorAll("img").forEach((img) => {
        for (const k of attrs) add(img.getAttribute(k) || "");
      });

      document.querySelectorAll('[style*="background-image"]').forEach((el) => {
        const m = (el.getAttribute("style") || "").match(/background-image\s*:\s*url\(["']?([^"')]+)["']?\)/i);
        if (m && m[1]) add(m[1]);
      });

      return out;
    })
    .catch(() => []);

  let images = dedupePreserveOrder(
    [...domImages, ...extractImageUrlsFromHtml(html)]
      .map(toHttpsMaybe)
      .map(toBigAlicdnUrl)
      .filter(Boolean)
      .filter((u) => u.includes("alicdn.com") || u.includes("aliimg") || u.includes("1688"))
  );

  const coverSmart = toBigAlicdnUrl(toHttpsMaybe(coverUrlFromList)) || images[0] || "";
  if (coverSmart && !images.includes(coverSmart)) images = [coverSmart, ...images];

  const orderedImages = dedupePreserveOrder(buildOrderedImages(images, img1Pick, coverSmart));
  const img1Final = orderedImages[0] || "";

  // Niente breadcrumb Yupoo su una pagina 1688: i selettori non esistono e la
  // vecchia versione finiva per leggere link a caso.
  const identity = await resolveProductIdentity({
    context,
    itemUrl: normUrl,
    itemLabel,
    titleRaw,
    bodyText,
    crumbText: "",
    categoryCardText: "",
    brandRaw: String(brand || "").trim(),
    catRaw: String(categoryOverride || "").trim(),
    img1Final,
    titleMode,
    titleForced,
    aiEnabled,
    shoeNameEnabled,
  });

  // Prezzo: prima il JSON incorporato nella pagina, che su 1688 è affidabile.
  let priceInfo = null;
  const htmlCny = parseCnyFrom1688Html(html);

  if (htmlCny) {
    priceInfo = { amount: htmlCny, currency: "CNY", cny: roundPrice(htmlCny), rate: 1, raw: String(htmlCny), source: "1688-html" };
  } else {
    priceInfo = await resolvePriceInfo(page, {
      titleRaw,
      categoryCardText: "",
      bodyText,
      labels: { title: "1688-title", dom: "1688-dom", body: "1688-body" },
    });
  }

  logPriceResult(normUrl, priceInfo);

  const sellerName = seller || "";

  return buildSheetRow({
    id: buildStableId(sellerName, normUrl),
    slug: buildUniqueSlug(identity.titleBase || titleRaw || "item", sellerName, normUrl),
    title: identity.titleBase,
    brand: identity.finalBrand,
    category: identity.finalCategory,
    seller: sellerName,
    images: orderedImages,
    status: "ok",
    sourceUrl: normUrl,
    buyUrl: "",
    priceInfo,
  });
}

// =====================
// SCRAPE: ALBUM YUPOO (o dispatch verso 1688)
// =====================
async function scrapeAlbumOnPage(page, context, albumUrl, opts) {
  const {
    categoryOverride,
    seller,
    brand,
    img1Pick,
    coverUrlFromCategory,
    storageAbsForRescue = "",
    primeUrlForRescue = "",
    jobOptions = {},
  } = opts;

  const normUrl = normalizeItemUrl(albumUrl);

  // Le offerte 1688 hanno un percorso dedicato.
  if (is1688OfferUrl(normUrl)) {
    return scrape1688OfferOnPage(page, context, normUrl, {
      categoryOverride,
      seller,
      brand,
      img1Pick,
      coverUrlFromList: coverUrlFromCategory,
      jobOptions,
    });
  }

  const itemLabel = extractAlbumId(normUrl) || normUrl;

  const titleForced = String(jobOptions.title || "").trim();
  const titleMode = normalizeTitleMode(jobOptions.titleMode, titleForced);
  const aiEnabled = isAiEnabledForJob(jobOptions.ai);
  const shoeNameEnabled = isShoeNameEnabledForJob(jobOptions.shoeName, aiEnabled);
  const categoryCardText = String(jobOptions.categoryCardText || "").replace(/\s+/g, " ").trim();
  const sourcePreference = normalizeSourcePreference(jobOptions.source);

  async function extractAlbumPhotosRaw() {
    return page
      .evaluate(() => {
        const attrs = ["data-src", "data-origin-src", "data-original", "data-lazy", "data-lazy-src", "src"];

        const normalize = (raw) => {
          const r = String(raw || "").trim();
          if (!r || r === "about:blank" || r.startsWith("data:")) return "";
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
          if (!u || !u.includes("photo.yupoo.com") || seen.has(u)) return;
          seen.add(u);
          out.push(u);
        };

        add(document.querySelector('meta[property="og:image"]')?.getAttribute("content") || "");

        for (const img of Array.from(document.querySelectorAll("img"))) {
          for (const k of attrs) add(img.getAttribute(k) || "");
          const p = (img.getAttribute("data-path") || "").trim();
          if (p) add(p);
        }

        return out;
      })
      .catch(() => []);
  }

  try {
    await safeGoto(page, normUrl, { retries: 2, timeout: NAV_TIMEOUT });
  } catch (e) {
    const msg = String(e?.message || e);
    if (msg.toLowerCase().includes("restricted") && storageAbsForRescue) {
      await rescueIfRestricted(context, storageAbsForRescue, primeUrlForRescue || normUrl);
      await safeGoto(page, normUrl, { retries: 1, timeout: NAV_TIMEOUT });
    } else throw e;
  }

  await page.waitForTimeout(250);

  const headerCoverRaw = await getAlbumHeaderCoverRaw(page);

  const withHeaderCover = (list) => {
    if (!headerCoverRaw) return list;
    const hc = toHttpsUrl(headerCoverRaw);
    return hc && hc.includes("photo.yupoo.com") ? [hc, ...list] : list;
  };

  let imagesRaw = dedupePreserveOrder(withHeaderCover(await extractAlbumPhotosRaw()).map(toHttpsUrl).map(fixPhotoDoubleHost));
  let imagesBig = dedupePreserveOrder(imagesRaw.map(toBigYupooPhotoUrl).map(fixPhotoDoubleHost));

  if (imagesBig.length < 6) {
    await fastScroll(page);
    imagesRaw = dedupePreserveOrder(withHeaderCover(await extractAlbumPhotosRaw()).map(toHttpsUrl).map(fixPhotoDoubleHost));
    imagesBig = dedupePreserveOrder(imagesRaw.map(toBigYupooPhotoUrl).map(fixPhotoDoubleHost));
  }

  const bodyText = await page.evaluate(() => document.body?.innerText || "").catch(() => "");
  const titleRaw = await getAlbumTitle(page);
  const crumbText = await getYupooBreadcrumbText(page);

  const internal = pickBestInternalCoverBig(imagesBig, headerCoverRaw);
  const coverSmart = internal.picked || pickCoverFromCategory(coverUrlFromCategory) || imagesBig[0] || "";

  if (DEBUG_COVER && Number(img1Pick || 0) <= 0) {
    console.log(`🖼️ COVER DEBUG | album=${itemLabel} | matched=${internal.matched ? "YES" : "NO"} | picked=${coverSmart || "-"}`);
  }

  if (coverSmart) {
    const cKey = yupooImageKey(coverSmart);
    const hasCover = imagesBig.some((u) => u === coverSmart || (cKey && yupooImageKey(u) === cKey));
    if (!hasCover) imagesBig = dedupePreserveOrder([coverSmart, ...imagesBig]);
  }

  const orderedImages = dedupePreserveOrder(buildOrderedImages(imagesBig, img1Pick, coverSmart));
  const img1Final = orderedImages[0] || "";

  const identity = await resolveProductIdentity({
    context,
    itemUrl: normUrl,
    itemLabel,
    titleRaw,
    bodyText,
    crumbText,
    categoryCardText,
    brandRaw: String(brand || "").trim(),
    catRaw: String(categoryOverride || "").trim(),
    img1Final,
    titleMode,
    titleForced,
    aiEnabled,
    shoeNameEnabled,
  });

  // SOURCE LINK
  const rawLinks = await page
    .evaluate(() =>
      Array.from(document.querySelectorAll("a[href]"))
        .map((a) => a.getAttribute("href"))
        .filter(Boolean)
        .map((h) => {
          try {
            return new URL(h, location.href).toString();
          } catch {
            return null;
          }
        })
        .filter(Boolean)
    )
    .catch(() => []);

  let cleanedSource = decodeYupooExternalUrl(String((await pickPreferredSourceUrl(context, rawLinks, sourcePreference)) || "").trim());

  if (cleanedSource && isShortRedirectUrl(cleanedSource)) {
    cleanedSource = (await resolveFinalUrl(context, cleanedSource)) || cleanedSource;
  }

  cleanedSource = canonicalize1688OfferUrl(canonicalizeWeidianItemUrl(cleanedSource));

  const selectedPlatform = detectSourcePlatform(cleanedSource);
  console.log(
    `🔀 SOURCE | item=${itemLabel} | requested=${sourcePreference} | selected=${selectedPlatform || "NONE"}${
      cleanedSource ? ` | ${cleanedSource}` : ""
    }`
  );

  // Weidian -> short link VigorBuy con inviteCode.
  // Taobao/1688 o fallimento shortener -> resta il source originale.
  const buyUrl = (await convertExternalSourceToVigorBuy(cleanedSource)) || cleanedSource || "";

  const priceInfo = await resolvePriceInfo(page, { titleRaw, categoryCardText, bodyText });
  logPriceResult(normUrl, priceInfo);

  const sellerName = seller || "";

  return buildSheetRow({
    id: buildStableId(sellerName, normUrl),
    slug: buildUniqueSlug(identity.titleBase || titleRaw || "item", sellerName, normUrl),
    title: identity.titleBase,
    brand: identity.finalBrand,
    category: identity.finalCategory,
    seller: sellerName,
    images: orderedImages,
    status: "ok",
    sourceUrl: normUrl,
    buyUrl,
    priceInfo,
  });
}

// =====================
// JOBS PARSER
// =====================
function normalizeJob(raw) {
  const job = {
    url: String(raw?.url || "").trim(),
    brand: String(raw?.brand || "").trim(),
    seller: String(raw?.seller || "").trim(),
    maxPages: Number(raw?.maxPages || 0) || 0,
    category: String(raw?.category || "").trim(),
    img1: Number(raw?.img1 || 0) || 0,
    title: String(raw?.title || "").trim(),
    titleMode: "",
    ai: normTriState(raw?.ai),
    shoeName: normTriState(raw?.shoeName),
    source: normalizeSourcePreference(raw?.source),
  };

  job.titleMode = normalizeTitleMode(raw?.titleMode, job.title);
  return job;
}

function parseJobLine(line) {
  const raw = String(line || "").trim();
  if (!raw || raw.startsWith("#")) return null;

  const parts = raw.split("|").map((p) => p.trim()).filter(Boolean);
  if (!parts.length) return null;

  const job = { url: parts[0] };

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
    else if (k === "source") job.source = v;
  }

  return normalizeJob(job);
}

function loadJobsFromFile(filePath) {
  const abs = absPathFromRoot(filePath);
  if (!fs.existsSync(abs)) {
    console.error("❌ Jobs file non trovato:", abs);
    process.exit(1);
  }

  const jobs = [];
  for (const line of fs.readFileSync(abs, "utf-8").split(/\r?\n/)) {
    const job = parseJobLine(line);
    if (job) jobs.push(job);
  }
  return jobs;
}

// =====================
// CLI
// =====================
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
    source: "auto",
    dryRun: false,
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
    else if (a === "--source") args.source = String(list[++i] || "auto");
    else if (a === "--dry-run" || a === "--dryRun") args.dryRun = true;
  }

  args.ai = normTriState(args.ai);
  args.shoeName = normTriState(args.shoeName);
  args.source = normalizeSourcePreference(args.source);
  args.titleMode = normalizeTitleMode(args.titleMode, args.title);

  return args;
}

function printUsage() {
  console.log("\n❌ Uso:");
  console.log(`node ./scraper/scrape_yupoo_to_sheet.mjs "<url>" --brand "X" --seller "Y" [--source weidian] [--dry-run]`);
  console.log(`node ./scraper/scrape_yupoo_to_sheet.mjs --file ./scraper/yupoo_jobs.txt`);
  console.log(`node ./scraper/scrape_yupoo_to_sheet.mjs --auth --storage ./scraper/yupoo_state.json`);
  console.log("\nFlag disponibili:");
  console.log("  --file <path>       file di job (una riga per url, campi separati da |)");
  console.log("  --seller <name>     obbligatorio");
  console.log("  --brand <name>      brand fisso, oppure AUTO");
  console.log("  --category <cat>    categoria forzata, oppure AUTO (keyword strict)");
  console.log("  --source <auto|weidian|taobao>");
  console.log("  --titleMode <AUTO|ALBUM|FORCE>");
  console.log("  --title <text>      implica titleMode=FORCE");
  console.log("  --img1 <n>          usa l'ennesima immagine come copertina");
  console.log("  --maxPages <n>      cap sulle pagine di categoria");
  console.log("  --ai <0|1|auto>     abilita/disabilita l'AI per questo run");
  console.log("  --shoeName <0|1|auto>");
  console.log("  --headful           browser visibile");
  console.log("  --auth              salva solo la sessione");
  console.log("  --storage <path>    percorso storageState");
  console.log("  --dry-run           nessuna scrittura sul Sheet, output su file JSONL");
}

// =====================
// MAIN
// =====================
async function main() {
  const args = parseArgs(process.argv);
  const jobs = args.file ? loadJobsFromFile(args.file) : null;

  if (!jobs && !args.url && !args.auth) {
    printUsage();
    process.exit(0);
  }

  const DRY_RUN = !!args.dryRun;
  if (DRY_RUN) {
    console.log("\n🧪 DRY-RUN attivo: nessuna scrittura sul Google Sheet.");
    console.log("   Output righe:", absPathFromRoot(SCRAPER_DRYRUN_FILE));
    console.log("   Il checkpoint NON viene aggiornato, così il run reale rifà tutto.\n");
  }

  const storagePath = args.storage || envStr("YUPOO_STORAGE_STATE") || "./scraper/yupoo_state.json";
  const storageAbs = absPathFromRoot(storagePath);
  const jobPrimeUrl = (jobs?.[0]?.url || args.url || "https://www.yupoo.com/").trim();
  const headless = !args.headful;

  const sheets = getSheetsClient();
  const { existingSlugs, nameCounters, byKey, nextAppendRow: nextAppendRowInit } = await loadExistingIndex(sheets);
  let nextAppendRow = nextAppendRowInit;

  const browser = await chromium.launch({ headless });
  let context = null;

  const stats = {
    jobs: 0,
    itemsExtracted: 0,
    itemsOk: 0,
    itemsFail: 0,
    sheetAppend: 0,
    sheetUpdate: 0,
    skippedExisting: 0,
    skippedCheckpoint: 0,
    pagesRecycled: 0,
  };

  const sheetLock = createMutex();
  const indexLock = createMutex();
  const backoff = createBackoff();

  let pendingAppends = []; // { key, row, doneKey }
  let pendingUpdates = []; // { key, range, values, doneKey }
  const pendingByKey = new Map();
  let flushScheduled = false;

  function writeDryRunRows(items) {
    const abs = absPathFromRoot(SCRAPER_DRYRUN_FILE);
    if (!abs || !items.length) return;
    try {
      ensureDirFor(abs);
      const payload = items.map((it) => JSON.stringify({ kind: it.kind, key: it.key, row: it.row })).join("\n") + "\n";
      fs.appendFileSync(abs, payload, "utf-8");
    } catch (e) {
      console.log("⚠️ dry-run write failed:", firstLine(e?.message || e));
    }
  }

  async function flushToSheet(force = false) {
    return sheetLock.runExclusive(async () => {
      if (!force && pendingAppends.length + pendingUpdates.length < SCRAPER_FLUSH_EVERY) return;
      if (!pendingAppends.length && !pendingUpdates.length) return;

      const upd = pendingUpdates.splice(0, pendingUpdates.length);
      const app = pendingAppends.splice(0, pendingAppends.length);

      if (DRY_RUN) {
        writeDryRunRows([
          ...upd.map((x) => ({ kind: "update", key: x.key, row: x.values[0] })),
          ...app.map((x) => ({ kind: "append", key: x.key, row: x.row })),
        ]);

        for (const it of [...upd, ...app]) if (it?.key) pendingByKey.delete(it.key);
        console.log(`🧪 DRY-RUN FLUSH | updates=${upd.length} appends=${app.length}`);
        return;
      }

      const doneKeys = [...upd, ...app].map((x) => x?.doneKey).filter(Boolean);

      try {
        if (upd.length) {
          await batchUpdateRows(sheets, upd.map((x) => ({ range: x.range, values: x.values })), 50);
        }

        if (app.length) {
          const startRow = nextAppendRow;
          nextAppendRow = await writeRowsByExplicitRow(sheets, app.map((x) => x.row), startRow, 50);

          await indexLock.runExclusive(async () => {
            for (let i = 0; i < app.length; i++) {
              const it = app[i];
              if (!it?.key) continue;
              byKey.set(it.key, { rowNumber: startRow + i, rowValues: padToLen(it.row) });
            }
          });
        }

        for (const k of doneKeys) checkpointStore.set(k, 1);
        checkpointStore.flush(true);

        for (const it of [...upd, ...app]) if (it?.key) pendingByKey.delete(it.key);

        console.log(`✅ FLUSH OK | updates=${upd.length} appends=${app.length} | nextAppendRow=${nextAppendRow}`);
        backoff.onOk();
      } catch (e) {
        // Rimettiamo in coda: il flush successivo riprova.
        for (const x of upd) pendingUpdates.push(x);
        for (const x of app) pendingAppends.push(x);

        const msg = String(e?.message || e);
        console.log("❌ FLUSH FAILED:", firstLine(msg));
        await backoff.onFail(msg.toLowerCase().includes("quota") ? "net" : "fail");
      }
    });
  }

  async function maybeScheduleFlush() {
    if (pendingAppends.length + pendingUpdates.length < SCRAPER_FLUSH_EVERY) return;
    if (flushScheduled) return;

    flushScheduled = true;
    try {
      await flushToSheet(false);
    } finally {
      flushScheduled = false;
    }
  }

  // =====================
  // SHUTDOWN PULITO
  // =====================
  let shuttingDown = false;

  async function gracefulExit(reason, code = 0) {
    if (shuttingDown) return;
    shuttingDown = true;

    console.log(`\n🛑 STOP (${reason}) -> flush + save checkpoint/cache...`);

    try {
      await flushToSheet(true);
    } catch {}
    try {
      checkpointStore.flush(true);
    } catch {}
    try {
      aiStore.flush(true);
    } catch {}

    // Senza questi close restavano processi Chromium orfani.
    try {
      if (context) await context.close();
    } catch {}
    try {
      await browser.close();
    } catch {}

    console.log("✅ Stato salvato. Esco.");
    process.exit(code);
  }

  process.on("SIGINT", () => void gracefulExit("SIGINT", 130));
  process.on("SIGTERM", () => void gracefulExit("SIGTERM", 143));
  process.on("uncaughtException", (e) => {
    console.error("❌ uncaughtException:", e);
    void gracefulExit("uncaughtException", 1);
  });
  process.on("unhandledRejection", (e) => {
    console.error("❌ unhandledRejection:", e);
    void gracefulExit("unhandledRejection", 1);
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

    // Blocchiamo asset pesanti, ma lasciamo passare le immagini di navigazione
    // (servono al fallback page.goto della vision).
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
          normalizeJob({
            url: args.url,
            brand: args.brand,
            seller: args.seller,
            maxPages: args.maxPages,
            category: args.category,
            img1: args.img1,
            title: args.title,
            titleMode: args.titleMode,
            ai: args.ai,
            shoeName: args.shoeName,
            source: args.source,
          }),
        ];

    console.log(`\n🧩 Jobs caricati: ${jobList.length}`);
    if (args.file) console.log(`📄 File jobs: ${args.file}`);
    console.log("🔐 storageState:", storageAbs);

    for (let j = 0; j < jobList.length; j++) {
      stats.jobs += 1;

      const job = jobList[j];
      const url = String(job.url || "").trim();

      const mode = isCategoryUrl(url)
        ? "CATEGORY_YUPOO"
        : isAlbumUrl(url)
        ? "ALBUM_YUPOO"
        : is1688ShopOfferListUrl(url)
        ? "CATEGORY_1688"
        : is1688OfferUrl(url)
        ? "ALBUM_1688"
        : "UNKNOWN";

      if (mode === "UNKNOWN") {
        console.log(`\n⚠️ Job ${j + 1}/${jobList.length} URL non valido, skip: ${url}`);
        continue;
      }

      const { brand, seller, maxPages, category: categoryOverride, img1: img1Pick } = job;

      const jobOpts = {
        title: job.title,
        titleMode: job.titleMode,
        ai: job.ai,
        shoeName: job.shoeName,
        source: job.source,
      };

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
      console.log(
        "🔀 Source preference:",
        jobOpts.source.toUpperCase(),
        jobOpts.source === "auto" ? "(WEIDIAN > TAOBAO > 1688)" : "(FORZATO, nessun ripiego)"
      );
      console.log("------------------------------------");

      let itemUrls = [];
      let coverByItem = new Map();
      let cardTextByItem = new Map();

      if (mode === "CATEGORY_YUPOO") {
        const res = await scrapeCategory(context, url, maxPages, storageAbs, url);
        itemUrls = Array.from(new Set(res.albumUrls.map(normalizeItemUrl)));
        coverByItem = res.coverByAlbum;
        cardTextByItem = res.cardTextByAlbum || new Map();
      } else if (mode === "CATEGORY_1688") {
        const res = await scrape1688ShopOfferList(context, url, maxPages);
        itemUrls = Array.from(new Set(res.albumUrls.map(normalizeItemUrl)));
        coverByItem = res.coverByAlbum;
      } else {
        itemUrls = [normalizeItemUrl(url)];
      }

      stats.itemsExtracted += itemUrls.length;

      // Pool di pagine riusate dai worker.
      // Yupoo viene serializzato di default (1 worker) per ridurre i 567/Restricted.
      // 1688 e gli altri flussi continuano a usare SCRAPER_CONCURRENCY.
      const isYupooMode = mode === "CATEGORY_YUPOO" || mode === "ALBUM_YUPOO";
      const workerConcurrency = isYupooMode
        ? Math.max(1, Math.min(SCRAPER_CONCURRENCY, YUPOO_CONCURRENCY))
        : SCRAPER_CONCURRENCY;
      const interItemSleep = isYupooMode ? YUPOO_BETWEEN_ALBUMS_SLEEP : BETWEEN_ALBUMS_SLEEP;

      console.log(`🧵 Worker effettivi per questo job: ${workerConcurrency}${isYupooMode ? " (YUPOO safe mode)" : ""}`);

      const pages = [];
      for (let k = 0; k < workerConcurrency; k++) pages.push(await context.newPage());

      let nextIndex = 0;

      async function worker(workerId) {
        while (true) {
          const idx = nextIndex++;
          if (idx >= itemUrls.length) break;

          const normUrl = normalizeItemUrl(itemUrls[idx]);
          const doneKey = makeDoneKey(seller, normUrl);

          if (SCRAPER_RESUME && checkpointStore.has(doneKey)) {
            stats.skippedCheckpoint += 1;
            continue;
          }

          const sellerLower = String(seller).trim().toLowerCase();
          const key = `${sellerLower}||${normUrl}`;

          if (SCRAPER_SKIP_EXISTING && byKey.has(key)) {
            stats.skippedExisting += 1;
            continue;
          }

          const scrapeOpts = {
            categoryOverride,
            seller,
            brand,
            img1Pick,
            coverUrlFromCategory: coverByItem.get(normUrl) || "",
            storageAbsForRescue: storageAbs,
            primeUrlForRescue: url,
            jobOptions: { ...jobOpts, categoryCardText: cardTextByItem.get(normUrl) || "" },
          };

          let row = null;
          let lastErr = null;

          // Retry per singolo item: prima un fallimento perdeva l'item per sempre.
          for (let attempt = 1; attempt <= SCRAPER_ITEM_RETRIES; attempt++) {
            try {
              row = await scrapeAlbumOnPage(pages[workerId], context, normUrl, scrapeOpts);
              lastErr = null;
              break;
            } catch (err) {
              lastErr = err;
              const msg = String(err?.message || err);

              console.log(`❌ FAIL item (${attempt}/${SCRAPER_ITEM_RETRIES}): ${normUrl}`);
              console.log(`   -> ${firstLine(msg)}`);

              // Se la pagina è morta ("Target closed"), il worker restava zombie:
              // ora la ricreiamo e proseguiamo.
              if (pages[workerId].isClosed() || /target closed|browser has been closed/i.test(msg)) {
                try {
                  await pages[workerId].close();
                } catch {}
                try {
                  pages[workerId] = await context.newPage();
                  stats.pagesRecycled += 1;
                } catch {}
              }

              await backoff.onFail(msg.toLowerCase().includes("restricted") ? "restricted" : "fail");
            }
          }

          if (!row) {
            stats.itemsFail += 1;
            recordFailedItem({ seller, url: normUrl, job: url, error: firstLine(lastErr?.message || lastErr) });
            continue;
          }

          stats.itemsOk += 1;
          backoff.onOk();

          await indexLock.runExclusive(async () => {
            const dk = makeDoneKey(seller, String(row[COL.SOURCE_URL] || "").trim() || normUrl);
            const existing = byKey.get(key);

            if (existing && existing.rowNumber >= 2) {
              // Riga già presente nel foglio: preserviamo id e slug storici.
              const prev = padToLen(existing.rowValues);
              const next = padToLen(row);

              if (String(prev[COL.ID] || "").trim()) next[COL.ID] = prev[COL.ID];
              if (String(prev[COL.SLUG] || "").trim()) next[COL.SLUG] = prev[COL.SLUG];

              const updItem = {
                key,
                range: sheetRange(existing.rowNumber, existing.rowNumber),
                values: [next],
                doneKey: dk,
              };

              pendingUpdates.push(updItem);
              pendingByKey.set(key, { kind: "update", itemRef: updItem });
              byKey.set(key, { rowNumber: existing.rowNumber, rowValues: next });
              stats.sheetUpdate += 1;
              return;
            }

            if (existing && existing.rowNumber < 2) {
              // Duplicato nello stesso run: aggiorniamo la riga già in coda.
              const entry = pendingByKey.get(key);

              if (entry?.kind === "append" && entry.itemRef?.row) {
                const prevQueued = padToLen(entry.itemRef.row);
                const next = padToLen(row);

                next[COL.ID] = prevQueued[COL.ID];
                next[COL.SLUG] = prevQueued[COL.SLUG];
                if (String(prevQueued[COL.TITLE] || "").trim()) next[COL.TITLE] = prevQueued[COL.TITLE];

                entry.itemRef.row = next;
                byKey.set(key, { rowNumber: -1, rowValues: next });
              } else {
                console.log(`⚠️ Duplicato nello stesso run ma riga in coda non trovata. Skip: ${key}`);
              }
              return;
            }

            // Nuova riga.
            const next = padToLen(row);

            const uniqueSlug = makeUniqueSlug(String(next[COL.SLUG] || "").trim(), String(next[COL.ID] || "").trim(), existingSlugs);
            next[COL.SLUG] = uniqueSlug;
            existingSlugs.add(uniqueSlug);

            next[COL.TITLE] = makeUniqueNameForSeller(next[COL.TITLE], seller, nameCounters);

            const appItem = { key, row: next, doneKey: dk };
            pendingAppends.push(appItem);
            pendingByKey.set(key, { kind: "append", itemRef: appItem });
            byKey.set(key, { rowNumber: -1, rowValues: next });
            stats.sheetAppend += 1;
          });

          await maybeScheduleFlush();
          if (interItemSleep > 0) await sleep(interItemSleep);
        }
      }

      await Promise.all(pages.map((_, w) => worker(w)));

      for (const p of pages) {
        try {
          await p.close();
        } catch {}
      }

      await flushToSheet(true);

      console.log("\n================ JOB DONE ================");
      console.log(`Seller: ${seller}`);
      console.log(`URL   : ${url}`);
      console.log(`Item totali: ${itemUrls.length}`);
      console.log("=========================================\n");
    }

    await flushToSheet(true);
    aiStore.flush(true);
    checkpointStore.flush(true);

    console.log("\n✅ FINITO!");
    console.log("\n================ GLOBAL SUMMARY ================");
    console.log(`Jobs totali             : ${stats.jobs}`);
    console.log(`Item estratti           : ${stats.itemsExtracted}`);
    console.log(`Item processati         : ok=${stats.itemsOk} | fail=${stats.itemsFail}`);
    console.log(`Sheet                   : append=${stats.sheetAppend} | update=${stats.sheetUpdate}${DRY_RUN ? " (DRY-RUN)" : ""}`);
    console.log(
      `VigorBuy                : ok=${vigorbuyStats.ok} | cache=${vigorbuyStats.cacheHit} | fail=${vigorbuyStats.fail} (verify=${vigorbuyStats.verifyFail}) | nonWeidian=${vigorbuyStats.skippedNonWeidian}${
        vigorbuyStats.authError ? " | TOKEN SCADUTO: aggiorna VIGORBUY_TOKEN in .env.local" : vigorbuyStats.disabled ? " | BREAKER OPEN" : ""
      }`
    );
    if (vigorbuyStats.firstError) console.log(`VigorBuy primo errore   : ${vigorbuyStats.firstError}`);
    console.log(`Skip existing(pre-open) : ${stats.skippedExisting}`);
    console.log(`Skip checkpoint(resume) : ${stats.skippedCheckpoint}`);
    console.log(`Pagine ricreate         : ${stats.pagesRecycled}`);
    if (stats.itemsFail > 0) console.log(`Dead letter             : ${absPathFromRoot(SCRAPER_FAILED_FILE)}`);
    console.log("===============================================");
  } catch (err) {
    console.error("❌ ERRORE FATALE:", err);
    process.exitCode = 1;
  } finally {
    try {
      await flushToSheet(true);
    } catch {}
    try {
      aiStore.flush(true);
    } catch {}
    try {
      checkpointStore.flush(true);
    } catch {}
    try {
      if (context) await context.close();
    } catch {}
    try {
      await browser.close();
    } catch {}
  }
}

main();