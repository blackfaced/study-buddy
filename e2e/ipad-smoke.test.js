// e2e/ipad-smoke.test.js
//
// Playwright smoke test with a real browser engine — WebKit in an iPad
// profile, the closest we can get to the kid's iPad Safari without a
// device. Covers the acceptance paths where DOM-fake unit tests have
// blind spots (real HTMLCollection, real script load order).
//
// Defaults to the 3002 TEST instance (separate STUDY_DB) so e2e runs
// never touch production data. Override with E2E_BASE_URL.
//
// Run: node --test e2e/ipad-smoke.test.js
// Deps: npm i -D playwright && npx playwright install webkit chromium
//
// The buddy PIN is read from ../.env (BUDDY_PIN) and never printed.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { webkit, devices } from "playwright";

const BASE = process.env.E2E_BASE_URL || "https://localhost:3002";

function readPin() {
  try {
    const env = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", ".env"), "utf8");
    const m = env.match(/^BUDDY_PIN=(\d{4})/m);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

let browser;
before(async () => {
  browser = await webkit.launch();
});
after(async () => {
  if (browser) await browser.close();
});

async function newIpadPage() {
  const ctx = await browser.newContext({
    ...devices["iPad Mini"],
    ignoreHTTPSErrors: true, // local mkcert cert
  });
  return ctx.newPage();
}

test("portal: buddy entry shows the 拍错题 photo-only copy", async () => {
  const page = await newIpadPage();
  await page.goto(BASE + "/", { waitUntil: "networkidle" });
  // portalEntry(chatEnabled=false) swaps the buddy card copy
  await page.waitForSelector("text=拍错题", { timeout: 8000 });
  assert.ok(await page.locator("text=拍错题").first().isVisible());
  await page.close();
});

test("buddy photo-only: PIN gate speaks 拍错题; after unlock no chat UI, only 📷 + 翻转", async () => {
  const page = await newIpadPage();
  await page.goto(BASE + "/buddy/", { waitUntil: "networkidle" });

  const pin = readPin();
  // No PIN → the gate assertions below would be silently skipped and the
  // test would look stronger than it is. Fail loudly instead.
  assert.ok(pin, "BUDDY_PIN missing from .env — buddy e2e needs it");
  {
    // PIN gate copy must already be swapped BEFORE the parent sees it.
    await page.waitForSelector("#pin-overlay", { state: "visible", timeout: 8000 });
    const hint = await page.textContent("#pin-hint");
    assert.ok(hint.includes("拍错题"), `PIN gate hint should say 拍错题, got: ${hint}`);
    assert.ok(!hint.includes("聊天"));
    await page.fill("#pin-input", pin); // 4 digits auto-submit
  }
  // .app becomes visible after unlock (or immediately when PIN unset)
  await page.waitForSelector(".app:not(.hidden)", { timeout: 8000 });

  assert.equal(await page.textContent(".app .name"), "拍错题");
  assert.equal(await page.textContent("#avatar"), "📷");
  // Chat-era controls hidden, capture controls kept
  for (const sel of ["#input", "#send-btn", "#video-toggle", "#end-btn", "#chat"]) {
    assert.ok(!(await page.locator(sel).isVisible()), `${sel} must be hidden in photo-only mode`);
  }
  assert.ok(await page.locator("#photo-btn").isVisible(), "📷 stays");
  assert.ok(await page.locator("#flip-btn").isVisible(), "翻转 stays");
  await page.close();
});

test("write app: select two chars → 开始练 actually starts (real-HTMLCollection regression)", async () => {
  // Seed the TEST library via API (3002 has its own DB).
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
  await ctx.request.post(BASE + "/api/write/words", {
    data: { chars: "春晓", addedBy: "e2e" },
  });

  const page = await newIpadPage();
  await page.goto(BASE + "/write/", { waitUntil: "networkidle" });
  await page.waitForSelector(".word-cell", { timeout: 8000 });

  const boxes = page.locator(".word-cell input[type=checkbox]");
  await boxes.nth(0).check();
  await boxes.nth(1).check();
  await page.locator("#start-btn").click();
  // The dead-button regression: nothing happened because getSelected
  // threw on the real HTMLCollection. Practice view must activate.
  await page.waitForSelector("#practice-view.active", { timeout: 5000 });
  await page.close();
  await ctx.close();
});
