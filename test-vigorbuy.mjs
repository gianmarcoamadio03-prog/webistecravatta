/**
 * Prova veloce del convertitore VigorBuy, senza lanciare lo scraper.
 * Il codice qui sotto è copiato pari pari dal blocco VigorBuy di scraper.js.
 *
 * Uso (dalla stessa cartella di scraper.js):
 *   node test-vigorbuy.mjs "https://weidian.com/item.html?itemID=7818027025"
 */
import path from "path";
import dotenv from "dotenv";
import { fileURLToPath } from "url";
import { createHash, randomUUID } from "node:crypto";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Stesso .env.local dello scraper (cartella superiore), con fallback alla cartella corrente.
dotenv.config({ path: path.join(path.resolve(__dirname, ".."), ".env.local"), quiet: true });
dotenv.config({ path: path.join(__dirname, ".env.local"), quiet: true });

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

const REAL_UA =
  envStr("USER_AGENT") ||
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

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

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function firstLine(msg) {
  return String(msg || "").split("\n")[0];
}

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
// MAIN
// =====================
const urls = process.argv.slice(2);
if (!urls.length) {
  console.log('Uso: node test-vigorbuy.mjs "https://weidian.com/item.html?itemID=..." [altri link]');
  process.exit(1);
}

console.log(
  `VIGORBUY: invite=${VIGORBUY_INVITE_CODE} | client-id=${VIGORBUY_CLIENT_ID ? "ok" : "MANCANTE"} | token=${
    VIGORBUY_TOKEN ? `…${VIGORBUY_TOKEN.slice(-4)}` : "MANCANTE"
  } | verify=${VIGORBUY_VERIFY ? "ON" : "OFF"}`
);

let failed = 0;
for (const url of urls) {
  console.log(`\nSOURCE : ${url}`);
  console.log(`LONG   : ${buildVigorBuyLongUrlFromWeidian(url) || "(non è un link Weidian: resta invariato)"}`);
  const out = await convertExternalSourceToVigorBuy(url);
  const converted = isValidVigorBuyShortUrl(out);
  if (!converted && extractWeidianItemId(url)) failed += 1;
  console.log(`BUY_URL: ${out}${converted ? "" : "  (non convertito)"}`);
}
process.exit(failed ? 1 : 0);
