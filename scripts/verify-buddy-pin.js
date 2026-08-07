// Playwright smoke test for buddy chat PIN gate (issue #55).
// Loads /buddy/, asserts the modal is up and chat UI is hidden,
// types wrong PIN, asserts error + still locked, types correct PIN,
// asserts modal disappears and chat UI becomes visible.
//
// Run with BUDDY_PIN set in the dev server's .env:
//   NODE_PATH=/Users/mac/.npm/_npx/aa1f6563a672b75d/node_modules \
//     node scripts/verify-buddy-pin.js
//
// (The dev server is on port 3000; the live server has BUDDY_PIN
// configured. Without it, the modal never appears — test exits 0
// with a "no PIN set" note instead of failing.)
const { chromium } = require("playwright");

const URL = process.env.TEST_URL || "https://localhost:3000/buddy/";
const CORRECT_PIN = process.env.BUDDY_PIN || "8864";

(async () => {
  const browser = await chromium.launch({
    executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  });
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await ctx.newPage();

  const consoleMsgs = [];
  page.on("console", (msg) => consoleMsgs.push(`[${msg.type()}] ${msg.text()}`));

  let unlockRequest = null;
  let unlockResponse = null;
  page.on("request", (req) => {
    if (req.url().includes("/api/buddy/unlock")) {
      unlockRequest = { method: req.method(), body: req.postData() };
    }
  });
  page.on("response", async (resp) => {
    if (resp.url().includes("/api/buddy/unlock")) {
      try { unlockResponse = { status: resp.status(), body: await resp.json() }; } catch {}
    }
  });

  console.log("=== Verify #55: buddy PIN gate ===");
  await page.goto(URL);
  await page.waitForSelector("#pin-overlay", { state: "visible", timeout: 5000 });

  // 1. modal visible, chat UI hidden, cam-preview also hidden while PIN locked (issue #84)
  const pinVisible = await page.isVisible("#pin-overlay");
  const appHidden = await page.evaluate(() => document.querySelector(".app").classList.contains("hidden"));
  const camHidden = await page.evaluate(() => {
    const cam = document.getElementById("cam-preview");
    if (!cam) return true;  // absent counts as hidden
    return getComputedStyle(cam).display === "none";
  });
  console.log(`step 1: pin-overlay visible = ${pinVisible}, .app hidden = ${appHidden}, cam-preview hidden = ${camHidden}`);
  if (!pinVisible) { console.log("FAIL: pin-overlay not visible"); process.exit(1); }
  if (!appHidden) { console.log("FAIL: .app should be hidden before unlock"); process.exit(1); }
  if (!camHidden) { console.log("FAIL: #cam-preview should be hidden while PIN locked (issue #84)"); process.exit(1); }

  // 2. wrong PIN (use type so the input event fires; fill() bypasses it)
  await page.locator("#pin-input").click();
  await page.locator("#pin-input").type("0000", { delay: 30 });
  await page.waitForTimeout(200);  // let the auto-submit-on-4-digits kick in
  await page.waitForTimeout(500);
  const err1 = await page.textContent("#pin-error");
  const stillLocked = await page.isVisible("#pin-overlay");
  console.log(`step 2: wrong PIN → error = "${err1}", still locked = ${stillLocked}`);
  if (!err1.includes("密码不对") && !err1.includes("不对") && !err1.includes("try")) {
    console.log("FAIL: expected wrong-pin error message");
    process.exit(1);
  }
  if (!stillLocked) { console.log("FAIL: should still be locked after wrong PIN"); process.exit(1); }
  if (!unlockRequest) { console.log("FAIL: no /api/buddy/unlock request captured"); process.exit(1); }
  console.log(`   request captured: ${unlockRequest.method} ${JSON.stringify(unlockRequest.body)}`);
  console.log(`   response captured: ${JSON.stringify(unlockResponse)}`);
  if (unlockResponse?.status !== 401) {
    console.log(`FAIL: expected 401 on wrong PIN, got ${unlockResponse?.status}`);
    process.exit(1);
  }

  // 3. correct PIN (again, type not fill so input event fires)
  await page.locator("#pin-input").click();
  await page.locator("#pin-input").type(CORRECT_PIN, { delay: 30 });
  await page.waitForTimeout(200);
  await page.waitForTimeout(1000);
  const modalGone = await page.evaluate(() => document.getElementById("pin-overlay").style.display === "none");
  const appShown = await page.evaluate(() => !document.querySelector(".app").classList.contains("hidden"));
  console.log(`step 3: correct PIN → modal hidden = ${modalGone}, .app visible = ${appShown}`);
  if (!modalGone) { console.log("FAIL: modal should be hidden after correct PIN"); process.exit(1); }
  if (!appShown) { console.log("FAIL: .app should be visible after correct PIN"); process.exit(1); }

  // 4. lockout retry-after (only run if first response was 429)
  if (unlockResponse && unlockResponse.status === 429) {
    const err429 = await page.textContent("#pin-error");
    console.log(`step 4: lockout active, error = "${err429}"`);
  } else {
    console.log("step 4: skipped (no 429 observed in this run)");
  }

  if (consoleMsgs.filter((m) => m.startsWith("[error]") && !m.includes("favicon")).length > 0) {
    console.log("--- browser console (errors only) ---");
    consoleMsgs.filter((m) => m.startsWith("[error]") && !m.includes("favicon")).forEach((m) => console.log(m));
  }

  console.log("OK: all PIN gate assertions passed");
  await browser.close();
})();
