#!/usr/bin/env node
/**
 * apply_ai_fallback_patch_v21.mjs
 * Fix patcher (no template-literal ${} bug).
 *
 * Patch "AI solo fallback":
 * - Categoria: usa detectProductTypeFromTitle su (title + breadcrumb + body). AI solo se resta OTHER.
 * - Brand: AI solo se brand è AUTO/empty E la categoria resta OTHER (cioè “non trovo nulla”).
 *
 * Usage:
 *   node apply_ai_fallback_patch_v21.mjs ./scraper/scrape_yupoo_to_sheet.mjs
 */

import fs from "fs";
import path from "path";

const target = process.argv[2] || "./scraper/scrape_yupoo_to_sheet.mjs";
const abs = path.isAbsolute(target) ? target : path.join(process.cwd(), target);

if (!fs.existsSync(abs)) {
  console.error("❌ Target file non trovato:", abs);
  process.exit(1);
}

let src = fs.readFileSync(abs, "utf8");

if (src.includes("AI_FALLBACK_V2_1_APPLIED")) {
  console.log("✅ Patch già presente (AI_FALLBACK_V2_1_APPLIED). Nessuna modifica.");
  process.exit(0);
}

function replaceOnce(re, replacement, label) {
  const before = src;
  src = src.replace(re, replacement);
  if (src === before) {
    console.error("❌ Patch failed (pattern not found):", label);
    process.exit(1);
  }
}

// 1) Inserisci helper breadcrumb + detection signals prima di buildDisplayName
const helperMarker = `// AI_FALLBACK_V2_1_APPLIED`;
const helperBlock = `
${helperMarker}
// AI fallback: prova prima da testo (title + breadcrumb + body), poi (solo se serve) AI immagine.
async function getYupooBreadcrumbText(page) {
  try {
    return await page.evaluate(() => {
      const out = [];
      const push = (s) => {
        const t = String(s || "").replace(/\\s+/g, " ").trim();
        if (t && t.length >= 2) out.push(t);
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
      ];

      for (const sel of selectors) {
        const el = document.querySelector(sel);
        if (el) push(el.textContent || "");
      }

      // best-effort: anche qualche link “categoria” breve
      const linkTexts = Array.from(document.querySelectorAll("a"))
        .map((a) => (a.textContent || "").trim())
        .filter((t) => t && t.length <= 40);

      for (const t of linkTexts.slice(0, 40)) push(t);

      return out.join(" | ");
    });
  } catch {
    return "";
  }
}

function detectProductTypeFromSignals(titleRaw, crumbText, bodyText) {
  const combo =
    String(titleRaw || "") +
    " " +
    String(crumbText || "") +
    " " +
    String(bodyText || "").slice(0, 1500);
  return detectProductTypeFromTitle(combo);
}
`.trim() + "\n\n";

replaceOnce(
  /function buildDisplayName\(/,
  helperBlock + "function buildDisplayName(",
  "insert helpers before buildDisplayName()"
);

// 2) In scrapeAlbumOnPage: dopo titleRaw, aggiungi crumbText
replaceOnce(
  /const titleRaw = await getAlbumTitle\(page\);\s*\n/,
  (m) => m + "    const crumbText = await getYupooBreadcrumbText(page);\n",
  "add crumbText after titleRaw (album)"
);

// 3) In scrapeAlbumOnPage: detectedType usa signals (title+crumb+body)
replaceOnce(
  /const detectedType = detectProductTypeFromTitle\(titleRaw\);\s*\n/,
  "    const detectedType = detectProductTypeFromSignals(titleRaw, crumbText, bodyText);\n",
  "detectedType from signals (album)"
);

// 4) In scrapeAlbumOnPage: shouldAiBrand diventa super-fallback (solo se detectedType OTHER)
replaceOnce(
  /const shouldAiBrand = wantsAutoBrand;\s*\n/,
  "    const shouldAiBrand = wantsAutoBrand && detectedType === \"OTHER\";\n",
  "shouldAiBrand fallback-only (album)"
);

// 5) In scrape1688OfferOnPage: detectedType usa signals (no crumb)
replaceOnce(
  /const detectedType = detectProductTypeFromTitle\(titleRaw\);\s*\n/,
  "  const detectedType = detectProductTypeFromSignals(titleRaw, \"\", bodyText);\n",
  "detectedType from signals (1688)"
);

// 6) In scrape1688OfferOnPage: shouldAiBrand fallback-only
replaceOnce(
  /const shouldAiBrand = wantsAutoBrand;\s*\n/,
  "  const shouldAiBrand = wantsAutoBrand && detectedType === \"OTHER\";\n",
  "shouldAiBrand fallback-only (1688)"
);

// backup + write
const backup = abs + ".bak_ai_fallback_v21_" + Date.now();
fs.writeFileSync(backup, fs.readFileSync(abs));
fs.writeFileSync(abs, src, "utf8");

console.log("✅ Patch applicata!");
console.log("🧾 Backup creato:", backup);
console.log("📌 File patchato  :", abs);

// quick verify
const lines = src.split("\n").length;
console.log("📏 Lines:", lines);
console.log("🔎 Marker check:", src.includes("AI_FALLBACK_V2_1_APPLIED") ? "OK" : "MISSING");
