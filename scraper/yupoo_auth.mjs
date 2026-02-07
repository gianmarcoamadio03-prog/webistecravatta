import { chromium } from "playwright";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const STATE_PATH = path.join(__dirname, "yupoo_state.json");
const START_URL = process.argv[2] || "https://elephant-factory.x.yupoo.com/categories/4564614";

(async () => {
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({
    locale: "it-IT",
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
  });

  const page = await context.newPage();
  await page.goto(START_URL, { waitUntil: "domcontentloaded", timeout: 90000 });

  console.log("\n✅ Ora fai TUTTO manualmente nella finestra:");
  console.log("- se compare captcha/challenge, risolvilo");
  console.log("- naviga 1-2 album e apri qualche immagine");
  console.log("\nQuando hai finito, torna qui e premi INVIO per salvare i cookie...\n");

  process.stdin.resume();
  await new Promise((r) => process.stdin.once("data", r));

  await context.storageState({ path: STATE_PATH });
  console.log("💾 Salvato:", STATE_PATH);

  await browser.close();
})();
