#!/usr/bin/env node
import fs from "fs";
import path from "path";

const target = process.argv[2] || "./scraper/scrape_yupoo_to_sheet.mjs";
const abs = path.resolve(process.cwd(), target);

if (!fs.existsSync(abs)) {
  console.error("Target file not found:", abs);
  process.exit(1);
}

let src = fs.readFileSync(abs, "utf8");
const ts = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
const backup = abs + `.bak-vocab-${ts}`;
fs.writeFileSync(backup, src, "utf8");

let changed = false;

// --------------------------
// 1) CATEGORY_ALIASES: add missing keys
// --------------------------
const aliasesStart = src.indexOf("const CATEGORY_ALIASES = {");
const aliasesEndMarker = "\n};\n\nfunction canonicalizeCategory";
const aliasesEnd = aliasesStart >= 0 ? src.indexOf(aliasesEndMarker, aliasesStart) : -1;

if (aliasesStart >= 0 && aliasesEnd > aliasesStart) {
  const block = src.slice(aliasesStart, aliasesEnd);

  const toAdd = [
    `  // --- added (vocab patch) ---`,
    `  SWEATER: "SWEATERS",`,
    `  SWEATERS: "SWEATERS",`,
    `  PULLOVER: "SWEATERS",`,
    `  PULLOVERS: "SWEATERS",`,
    `  JUMPER: "SWEATERS",`,
    `  JUMPERS: "SWEATERS",`,
    `  TURTLENECK: "SWEATERS",`,
    `  TURTLENECKS: "SWEATERS",`,
    `  MOCKNECK: "SWEATERS",`,
    `  MOCKNECKS: "SWEATERS",`,
    `  KNITWEAR: "KNITWEAR",`,
    `  KNITTED: "KNITWEAR",`,
    `  CARDIGAN: "CARDIGANS",`,
    `  CARDIGANS: "CARDIGANS",`,
    `  // common typos seen on yupoo titles`,
    `  LONG_SLEE: "LONGSLEEVES",`,
    `  LONG_SLEEE: "LONGSLEEVES",`,
    `  LONG_SLEEVED: "LONGSLEEVES",`,
  ];

  const missing = toAdd.filter((line) => {
    const key = line.trim().split(":")[0];
    if (!key || key.startsWith("//")) return false;
    return !block.includes(key + ":");
  });

  if (missing.length) {
    const insertAt = aliasesEnd; // right before "};\n\nfunction canonicalizeCategory"
    const injected = "\n" + missing.join("\n") + "\n";
    src = src.slice(0, insertAt) + injected + src.slice(insertAt);
    changed = true;
  }
} else {
  console.warn("WARNING: CATEGORY_ALIASES block not found (skipped alias patch).");
}

// --------------------------
// 2) detectProductTypeFromTitle: improve LONGSLEEVES + add SWEATERS/CARDIGANS/KNITWEAR
// --------------------------
function ensureRule(typeName, ruleLineAfterType, insertAfterType) {
  if (src.includes(`{ type: "${typeName}"`)) return false;

  const reAfter = new RegExp(`(\\{\\s*type:\\s*"${insertAfterType}"[\\s\\S]*?\\},\\s*\\n)`);
  const m = src.match(reAfter);
  if (!m) return false;

  src = src.replace(reAfter, `$1    ${ruleLineAfterType}\n`);
  return true;
}

// Improve LONGSLEEVES regex (catch long-sleee, long-slee*, etc.)
const reLong = /\{\s*type:\s*"LONGSLEEVES"\s*,\s*re:\s*\/[^\/]*\/\s*\}\s*,/g;
if (reLong.test(src)) {
  src = src.replace(
    reLong,
    `{ type: "LONGSLEEVES", re: /\\blong(?:\\s|-)*slee\\w*\\b|\\b长袖\\b/ },`
  );
  changed = true;
}

// Add CARDIGANS / SWEATERS / KNITWEAR rules after SWEATSHIRTS
const addedCardigans = ensureRule(
  "CARDIGANS",
  `{ type: "CARDIGANS", re: /\\bcardigan(s)?\\b|\\b开衫\\b/ },`,
  "SWEATSHIRTS"
);
if (addedCardigans) changed = true;

const addedSweaters = ensureRule(
  "SWEATERS",
  `{ type: "SWEATERS", re: /\\bsweater(s)?\\b|\\bjumper(s)?\\b|\\bpullover(s)?\\b|\\bturtleneck(s)?\\b|\\bmaglione\\b|\\b毛衣\\b/ },`,
  "CARDIGANS"
);
if (addedSweaters) changed = true;

const addedKnitwear = ensureRule(
  "KNITWEAR",
  `{ type: "KNITWEAR", re: /\\bknitwear\\b|\\bknitted\\b|\\b针织\\b|\\b针织衫\\b/ },`,
  "SWEATERS"
);
if (addedKnitwear) changed = true;

// If no change, still keep backup and exit clean
fs.writeFileSync(abs, src, "utf8");

console.log("Backup creato:", backup);
console.log(changed ? "✅ Vocab patch applicata." : "ℹ️ Nessuna modifica necessaria (già patchato o blocchi non trovati).");
console.log("File:", abs);
