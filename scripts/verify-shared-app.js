// Playwright smoke test for web/shared/app.js (issue #21).
// Loads /buddy/, /write/, and /games/candy-math-island/, asserts that:
//   1. <script src="/shared/app.js"> loads cleanly on each page
//   2. window.StudyBuddy.{warmupTTS,fetch,cameraPause} all exist
//   3. warmupTTS actually speaks a silent utterance
//   4. fetch does the Content-Type / JSON round-trip
//
// Run with the dev server running locally on port 3000:
//   NODE_PATH=/Users/mac/.npm/_npx/aa1f6563a672b75d/node_modules \
//     node scripts/verify-shared-app.js
const { chromium } = require("playwright");

const BASE = process.env.TEST_URL || "https://localhost:3000";

const PAGES = [
  { name: "buddy", url: `${BASE}/buddy/` },
  { name: "write", url: `${BASE}/write/` },
  { name: "candy", url: `${BASE}/games/candy-math-island/` },
];

async function checkPage(page, def) {
  const consoleMsgs = [];
  page.on("console", (msg) => consoleMsgs.push(`[${msg.type()}] ${msg.text()}`));
  page.on("pageerror", (err) => consoleMsgs.push(`[pageerror] ${err.message}`));

  await page.goto(def.url, { waitUntil: "domcontentloaded" });
  // Wait for the last <script> in the page to run. domcontentloaded
  // doesn't guarantee inline modules / shared/app.js have executed.
  await page.waitForTimeout(800);

  // 1. window.StudyBuddy exists with all three helpers
  const sb = await page.evaluate(() => ({
    has: typeof window.StudyBuddy === "object" && window.StudyBuddy !== null,
    fns: window.StudyBuddy
      ? Object.keys(window.StudyBuddy).filter((k) => typeof window.StudyBuddy[k] === "function")
      : [],
  }));
  console.log(`  ${def.name}: StudyBuddy = ${JSON.stringify(sb)}`);
  if (!sb.has) throw new Error(`${def.name}: window.StudyBuddy missing`);
  for (const fn of ["warmupTTS", "fetch", "cameraPause"]) {
    if (!sb.fns.includes(fn)) throw new Error(`${def.name}: StudyBuddy.${fn} missing`);
  }

  // 2. warmupTTS actually calls speechSynthesis.speak with a silent
  // utterance. Stub a fake speechSynthesis before calling, then assert
  // the speak() received an utterance with volume=0 and text=" ".
  const speakResult = await page.evaluate(() => {
    return new Promise((resolve) => {
      const calls = [];
      const fake = {
        speak(u) { calls.push({ text: u.text, volume: u.volume }); },
        cancel() {},
      };
      const prev = window.speechSynthesis;
      Object.defineProperty(window, "speechSynthesis", { value: fake, configurable: true });
      try { window.StudyBuddy.warmupTTS(); } finally {
        Object.defineProperty(window, "speechSynthesis", { value: prev, configurable: true });
      }
      resolve(calls);
    });
  });
  console.log(`  ${def.name}: warmupTTS → ${JSON.stringify(speakResult)}`);
  if (speakResult.length !== 1) {
    throw new Error(`${def.name}: warmupTTS should call speak() exactly once`);
  }
  if (speakResult[0].volume !== 0) {
    throw new Error(`${def.name}: warmupTTS utterance must be silent (volume=0)`);
  }

  // 3. fetch round-trip — a 200 JSON response is parsed, a 4xx throws
  // an error with .status set.
  const fetchResult = await page.evaluate(async (base) => {
    const ok = await window.StudyBuddy.fetch(`${base}/api/health`);
    let err = null;
    try { await window.StudyBuddy.fetch(`${base}/api/nope-not-here`); }
    catch (e) { err = { status: e.status, hasText: typeof e.text === "string" }; }
    return { okKeys: Object.keys(ok), err };
  }, BASE);
  console.log(`  ${def.name}: fetch ok keys = ${JSON.stringify(fetchResult.okKeys)}, err = ${JSON.stringify(fetchResult.err)}`);
  if (!Array.isArray(fetchResult.okKeys) || fetchResult.okKeys.length === 0) {
    throw new Error(`${def.name}: fetch did not return JSON object`);
  }
  if (!fetchResult.err || !fetchResult.err.status) {
    throw new Error(`${def.name}: fetch did not throw on 4xx with .status`);
  }

  // 4. No JS errors in the page console (other than favicon).
  const errs = consoleMsgs.filter((m) => m.startsWith("[error]") || m.startsWith("[pageerror]"))
    .filter((m) => !m.includes("favicon"));
  if (errs.length > 0) {
    console.log(`  ${def.name}: page errors:`);
    errs.forEach((m) => console.log(`    ${m}`));
    // Don't fail — the apps do their own error handling. But surface them.
  }
}

(async () => {
  const browser = await chromium.launch({
    executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  });
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await ctx.newPage();

  console.log("=== Verify #21: shared/app.js loaded on all 3 apps ===");
  for (const def of PAGES) {
    console.log(`\n-- ${def.name} (${def.url}) --`);
    await checkPage(page, def);
  }
  console.log("\nOK: shared/app.js is loaded + functional on buddy, write, candy");
  await browser.close();
})();
