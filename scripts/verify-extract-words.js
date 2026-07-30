// Playwright smoke test for write-app photo-to-library endpoint (issue #59).
// Tests the HTTP boundary of /api/write/extract-words:
//   1. POST without an image → 400
//   2. POST with an image but server has no MINIMAX_API_KEY → 503
//   3. POST with an image + server has key → 200 + { words, model }
//
// Real vision (case 3) is a live test; the smoke test here only asserts
// the failure paths and the endpoint is wired up. Run it against a
// dev server (port 3000) that's intentionally launched without
// MINIMAX_API_KEY so we exercise 503 cleanly:
//
//   NODE_PATH=/Users/mac/.npm/_npx/aa1f6563a672b75d/node_modules \
//     node scripts/verify-extract-words.js
//
// If MINIMAX_API_KEY is set in the dev server's env, the script
// switches to live mode and POSTs a tiny generated PNG; it skips the
// 503 assertion and just confirms 200 with a words array.
const { chromium } = require("playwright");

const BASE = process.env.TEST_URL || "https://localhost:3000";
const HAS_KEY = !!process.env.MINIMAX_API_KEY;

(async () => {
  const browser = await chromium.launch({
    executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  });
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await ctx.newPage();

  const consoleMsgs = [];
  page.on("console", (msg) => consoleMsgs.push(`[${msg.type()}] ${msg.text()}`));
  page.on("pageerror", (err) => consoleMsgs.push(`[pageerror] ${err.message}`));

  // 1×1 red PNG (base64) — minimal valid image, used for the live path
  // when MINIMAX_API_KEY is configured on the dev server.
  const TINY_PNG_B64 =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

  console.log("=== Verify #59: write app photo-to-library ===");
  console.log(`mode: ${HAS_KEY ? "live (MINIMAX_API_KEY detected)" : "smoke (no key, expect 503)"}`);

  // Visit the base URL first so subsequent fetches share the origin
  // (avoids mixed-content / cross-origin "Failed to fetch" errors).
  await page.goto(BASE);
  await page.waitForTimeout(300);

  // ---- 1. No image → 400 (only in live mode — server short-circuits to
  // 503 before reaching the file check when there's no vision key) ----
  if (HAS_KEY) {
    const noImage = await page.evaluate(async (base) => {
      const resp = await fetch(`${base}/api/write/extract-words`, { method: "POST" });
      return { status: resp.status, body: await resp.json().catch(() => null) };
    }, BASE);
    console.log(`step 1: no image (live) → ${JSON.stringify(noImage)}`);
    if (noImage.status !== 400) {
      console.log(`FAIL: live mode expected 400 with no image, got ${noImage.status}`);
      process.exit(1);
    }
  } else {
    console.log("step 1: skipped (smoke mode — server returns 503 before file check)");
  }

  // ---- 2. With image, but no MINIMAX_API_KEY on server → 503 ----
  // We always send a real multipart upload to exercise the upload
  // pipeline. If the server has the key, the response is 200 (and we
  // assert words[] is present); otherwise the server short-circuits to
  // 503 before any vision call.
  const withImage = await page.evaluate(async ({ base, b64 }) => {
    const bin = atob(b64);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    const blob = new Blob([arr], { type: "image/png" });
    const form = new FormData();
    form.append("image", blob, "tiny.png");
    const resp = await fetch(`${base}/api/write/extract-words`, {
      method: "POST",
      body: form,
    });
    let body = null;
    try { body = await resp.json(); } catch {}
    return { status: resp.status, body };
  }, { base: BASE, b64: TINY_PNG_B64 });
  console.log(`step 2: with image → ${JSON.stringify(withImage)}`);

  if (HAS_KEY) {
    if (withImage.status !== 200) {
      console.log(`FAIL: live mode expected 200, got ${withImage.status}: ${JSON.stringify(withImage.body)}`);
      process.exit(1);
    }
    if (!Array.isArray(withImage.body?.words)) {
      console.log(`FAIL: live mode response missing words[]: ${JSON.stringify(withImage.body)}`);
      process.exit(1);
    }
    if (withImage.body.model !== "MiniMax-M3") {
      console.log(`FAIL: live mode model mismatch (expected "MiniMax-M3"): ${withImage.body.model}`);
      process.exit(1);
    }
    console.log(`   live: vision extracted ${withImage.body.words.length} chars from tiny.png`);
  } else {
    if (withImage.status !== 503) {
      console.log(`FAIL: smoke mode expected 503, got ${withImage.status}: ${JSON.stringify(withImage.body)}`);
      process.exit(1);
    }
    if (!String(withImage.body?.error || "").includes("vision not configured")) {
      console.log(`FAIL: 503 body should mention "vision not configured", got: ${JSON.stringify(withImage.body)}`);
      process.exit(1);
    }
  }

  if (consoleMsgs.filter((m) => m.startsWith("[error]") && !m.includes("favicon")).length > 0) {
    console.log("--- browser console (errors only) ---");
    consoleMsgs.filter((m) => m.startsWith("[error]") && !m.includes("favicon")).forEach((m) => console.log(m));
  }

  console.log(`OK: extract-words endpoint smoke (mode=${HAS_KEY ? "live" : "smoke"})`);
  await browser.close();
})();
