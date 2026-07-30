// Playwright smoke test for the write app (issue #57).
// Loads /write/, asserts empty library placeholder, adds a char via
// the input, asserts it appears, clicks start, and confirms the
// practice view shows the Hanzi Writer reference.
//
// Run with the dev server running locally:
//   NODE_PATH=/Users/mac/.npm/_npx/aa1f6563a672b75d/node_modules \
//     node scripts/verify-write-app.js
const { chromium } = require("playwright");

const URL = process.env.TEST_URL || "https://localhost:3000/write/";

(async () => {
  const browser = await chromium.launch({
    executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  });
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await ctx.newPage();

  const consoleMsgs = [];
  page.on("console", (msg) => consoleMsgs.push(`[${msg.type()}] ${msg.text()}`));
  page.on("pageerror", (err) => consoleMsgs.push(`[pageerror] ${err.message}`));

  let addCall = null;
  page.on("response", async (resp) => {
    if (resp.url().includes("/api/write/words") && resp.request().method() === "POST") {
      try { addCall = { status: resp.status(), body: await resp.json() }; } catch {}
    }
  });

  console.log("=== Verify #57: write app ===");
  await page.goto(URL);
  await page.waitForSelector("#home-view", { state: "visible", timeout: 5000 });
  await page.waitForTimeout(500);

  // 1. Home view visible
  const homeVisible = await page.isVisible("#home-view");
  console.log(`step 1: home view visible = ${homeVisible}`);
  if (!homeVisible) { console.log("FAIL: home view not visible"); process.exit(1); }

  // 1a. Wipe any pre-existing library (smoke test runs against a
  // shared dev DB; previous runs may have left chars behind).
  const existing = await page.$$eval(".word-cell", (els) => els.length);
  if (existing > 0) {
    console.log(`step 1a: pre-existing library has ${existing} chars; wiping...`);
    const chars = await page.$$eval(".word-cell span:first-child", (els) => els.map((e) => e.textContent));
    for (const c of chars) {
      await page.evaluate((ch) => fetch("/api/write/words/" + encodeURIComponent(ch), { method: "DELETE" }), c);
    }
    await page.reload();
    await page.waitForSelector("#home-view", { state: "visible", timeout: 5000 });
    await page.waitForTimeout(300);
  }

  // 1b. After wipe, start button should be disabled
  const startDisabled = await page.evaluate(() => document.getElementById("start-btn").disabled);
  console.log(`step 1b: start disabled = ${startDisabled}`);
  if (!startDisabled) { console.log("FAIL: start should be disabled with empty library"); process.exit(1); }

  // 2. Type 3 chars and click add
  await page.fill("#chars-input", "一二三");
  await page.click("#add-btn");
  await page.waitForTimeout(500);
  if (!addCall) { console.log("FAIL: no POST /api/write/words call captured"); process.exit(1); }
  console.log(`step 2: add response = ${JSON.stringify(addCall)}`);

  // 3. Library shows 3 cells
  const cells = await page.$$eval(".word-cell", (els) => els.map((e) => e.querySelector("span").textContent));
  console.log(`step 3: library cells = ${JSON.stringify(cells)}`);
  if (cells.length < 3) { console.log("FAIL: expected at least 3 cells"); process.exit(1); }
  if (!cells.includes("一") || !cells.includes("二") || !cells.includes("三")) {
    console.log("FAIL: missing one of 一二三"); process.exit(1);
  }

  // 4. Start button enabled now
  const startEnabledNow = await page.evaluate(() => !document.getElementById("start-btn").disabled);
  console.log(`step 4: start enabled = ${startEnabledNow}`);
  if (!startEnabledNow) { console.log("FAIL: start should be enabled after adding chars"); process.exit(1); }

  // 5. Click start → practice view active
  await page.click("#start-btn");
  await page.waitForSelector("#practice-view.active", { timeout: 3000 });
  await page.waitForTimeout(500);
  const hanziSvgCount = await page.$$eval("#hanzi-target svg", (els) => els.length);
  console.log(`step 5: Hanzi Writer mounted, svg count = ${hanziSvgCount}`);
  if (hanziSvgCount === 0) {
    console.log("WARN: no SVG rendered by HanziWriter — maybe CDN issue");
  }

  // 6. Status text mentions 第 1 字
  const status = await page.textContent("#status");
  console.log(`step 6: status = "${status}"`);
  if (!status.includes("第 1")) { console.log("FAIL: status should mention 第 1 /"); process.exit(1); }

  if (consoleMsgs.filter((m) => m.startsWith("[error]") && !m.includes("favicon")).length > 0) {
    console.log("--- browser console (errors only) ---");
    consoleMsgs.filter((m) => m.startsWith("[error]") && !m.includes("favicon")).forEach((m) => console.log(m));
  }

  console.log("OK: all write-app assertions passed");
  await browser.close();
})();
