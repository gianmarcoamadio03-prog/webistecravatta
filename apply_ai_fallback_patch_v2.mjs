#!/usr/bin/env node
"use strict";

import fs from "fs";
import path from "path";

function die(msg) {
  console.error("❌", msg);
  process.exit(1);
}

const targetArg = process.argv[2] || "scraper/scrape_yupoo_to_sheet.mjs";
const abs = path.isAbsolute(targetArg) ? targetArg : path.join(process.cwd(), targetArg);

if (!fs.existsSync(abs)) die(`File target non trovato: ${abs}`);

const src0 = fs.readFileSync(abs, "utf-8");
let src = src0;

// già patchato?
if (src.includes("AI_FALLBACK_V2") && src.includes("SCRAPER_AI_FALLBACK_ONLY")) {
  console.log("✅ Patch v2 già presente. Nessuna modifica fatta.");
  process.exit(0);
}

const backup = abs + ".bak_ai_fallback_v2_" + Date.now();
fs.writeFileSync(backup, src0, "utf-8");
console.log("🧾 Backup creato:", backup);

// =====================
// 1) Inserisci ENV + note
// =====================
const marker = /const\s+SCRAPER_DETECT_SHOE_NAME\s*=\s*String\(process\.env\.SCRAPER_DETECT_SHOE_NAME[^\n]*\n/;
if (!marker.test(src)) die("Marker SCRAPER_DETECT_SHOE_NAME non trovato nel file target (scraper diverso dal previsto).");

const envBlock =
`
/** =========================
 * AI_FALLBACK_V2
 * =========================
 * Se SCRAPER_AI_FALLBACK_ONLY=1:
 * - AI (immagini) si usa SOLO se serve davvero:
 *   - brand = AUTO/empty  -> serve AI (non lo ricavi dal testo)
 *   - category = AUTO/empty -> AI SOLO se il testo (title+body) non dà un type (OTHER)
 *
 * Inoltre: miglioriamo detectProductTypeFromTitle usando anche bodyText (primi N chars)
 */
const SCRAPER_AI_FALLBACK_ONLY =
  String(process.env.SCRAPER_AI_FALLBACK_ONLY || "0").trim() === "1";

const SCRAPER_AI_TYPE_FROM_BODY_CHARS = Math.max(
  0,
  Number(String(process.env.SCRAPER_AI_TYPE_FROM_BODY_CHARS || "1500").trim()) || 1500
);
`.trim() + "\n\n";

src = src.replace(marker, (m) => m + "\n" + envBlock);

// =====================
// 2) Migliora detectedType (usa title + body)
// =====================
const detectedLine = /const\s+detectedType\s*=\s*detectProductTypeFromTitle\(\s*titleRaw\s*\)\s*;\s*\n/g;

let replacedCount = 0;
src = src.replace(detectedLine, () => {
  replacedCount++;
  return (
`const comboText = String(titleRaw || "") + " " + String(bodyText || "").slice(0, SCRAPER_AI_TYPE_FROM_BODY_CHARS);
const detectedType = detectProductTypeFromTitle(comboText);
`
  );
});

if (replacedCount === 0) {
  console.log("⚠️ Non ho trovato la riga detectedType = detectProductTypeFromTitle(titleRaw). Patch parziale.");
} else {
  console.log(\`✅ Patched detectedType lines: \${replacedCount}\`);
}

// =====================
// 3) Gate extra (fallback-only)
// =====================
src = src.replace(
  /if\s*\(\s*aiEnabled\s*&&\s*\(\s*shouldAiBrand\s*\|\|\s*shouldAiCat\s*\)\s*\)\s*\{/g,
  "if (aiEnabled && (shouldAiBrand || shouldAiCat) && (!SCRAPER_AI_FALLBACK_ONLY || shouldAiBrand || shouldAiCat)) {"
);

src = src.replace(
  /if\s*\(\s*aiEnabled\s*&&\s*\(\s*shouldAiBrand\s*\|\|\s*shouldAiCat\s*\)\s*&&\s*img1Final\s*\)\s*\{/g,
  "if (aiEnabled && (shouldAiBrand || shouldAiCat) && img1Final && (!SCRAPER_AI_FALLBACK_ONLY || shouldAiBrand || shouldAiCat)) {"
);

fs.writeFileSync(abs, src, "utf-8");
console.log("✅ Patch v2 applicata con successo a:", abs);
console.log("↩️ Se vuoi ripristinare:", backup);
