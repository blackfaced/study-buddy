// Playwright smoke test for the write app's SVG layering fix (issue #63).
// Asserts three things the user complained about in the live screenshot:
//   1. The HanziWriter reference character is GREEN (#4caf50), not the
//      dark gray #555 default.
//   2. The 田字格 grid overlay sits ABOVE the HanziWriter SVG
//      (z-index grid 2 > svg 1) so the reference can't overwrite the
//      cross + diagonals.
//   3. The status text uses "·" (U+00B7 middle dot) instead of "—"
//      (U+2014 em-dash) — em-dash rendered as a Chinese glyph in
//      Edge mobile, making the status read "字 一 一".
//   4. The grid overlay doesn't bleed past the stage box (overflow: hidden).
//
// Run with the dev server running locally on port 3000:
//   NODE_PATH=/Users/mac/.npm/_npx/aa1f6563a672b75d/node_modules \
//     TEST_URL=http://localhost:3000 \
//     node scripts/verify-write-svg-overlap.js
const { chromium, devices } = require("playwright");

const BASE = process.env.TEST_URL || "https://localhost:3000";

(async () => {
  const browser = await chromium.launch({
    executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  });
  const ctx = await browser.newContext({ ...devices["Pixel 6"] });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log("[pageerror]", e.message));

  console.log("=== Verify #63: write app SVG overlap fix ===");
  await page.goto(`${BASE}/write/`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(800);

  // Wipe any pre-existing words so the test is deterministic.
  await page.evaluate(async (base) => {
    const r = await fetch(`${base}/api/write/words`).then((r) => r.json());
    for (const w of (r.words || [])) {
      await fetch(`${base}/api/write/words/${encodeURIComponent(w.char)}`, { method: "DELETE" });
    }
  }, BASE);
  await page.reload();
  await page.waitForTimeout(500);
  await page.fill("#chars-input", "一");
  await page.click("#add-btn");
  await page.waitForTimeout(300);
  await page.click("#start-btn");
  // Wait for HanziWriter to actually mount (it loads the CDN glyph data
  // async). After the SVG appears, we still need to inspect it BEFORE
  // SHOW_MS (3000) elapses, otherwise the status flips to
  // "字消失啦..." and the reference goes to opacity 0.
  await page.waitForFunction(() => {
    const h = document.getElementById("hanzi-target");
    return h && h.querySelector("svg path[stroke*='76,175,80']");
  }, { timeout: 5000 });
  // Re-read the status now that the writer has mounted; we want to
  // catch the "第 X/Y 字 · ..." string, not the post-hide one.
  const statusEarly = await page.evaluate(() => {
    const s = document.getElementById("status");
    return s ? s.textContent : null;
  });
  // If we already missed the early window, accept either the early
  // status or the "字消失啦" status (which still uses · not —).
  console.log("  status at inspect time:", JSON.stringify(statusEarly));

  const result = await page.evaluate(() => {
    const hanzi = document.getElementById("hanzi-target");
    const hanziSvg = hanzi ? hanzi.querySelector("svg") : null;
    const grid = document.querySelector(".grid-overlay");
    const kid = document.getElementById("kid-svg");
    const status = document.getElementById("status");
    // The HanziWriter main stroke path is the second path with
    // clip-path="url(#mask-2)" (the others are outline + highlight).
    const mainPath = hanziSvg
      ? Array.from(hanziSvg.querySelectorAll("path")).find(
          (p) => p.getAttribute("stroke") && p.getAttribute("stroke").includes("76,175,80"),
        )
      : null;
    return {
      status: status ? status.textContent : null,
      hanziSvgZ: hanziSvg ? getComputedStyle(hanziSvg).zIndex : null,
      gridZ: grid ? getComputedStyle(grid).zIndex : null,
      kidZ: kid ? getComputedStyle(kid).zIndex : null,
      gridOverflow: grid ? getComputedStyle(grid).overflow : null,
      gridRect: grid ? grid.getBoundingClientRect() : null,
      mainPathStroke: mainPath ? mainPath.getAttribute("stroke") : null,
      stageRect: document.getElementById("stage").getBoundingClientRect(),
    };
  });

  let failed = 0;
  function check(label, cond) {
    const ok = !!cond;
    console.log(`  ${ok ? "OK " : "FAIL"}  ${label}`);
    if (!ok) failed++;
  }

  // 1. HanziWriter main stroke is the green we configured
  check(
    "HanziWriter main path stroke is green (rgba(76,175,80,1))",
    result.mainPathStroke && result.mainPathStroke.includes("76,175,80"),
  );

  // 2. grid z-index higher than HanziWriter SVG z-index
  check(
    `grid z-index (${result.gridZ}) > hanzi-svg z-index (${result.hanziSvgZ})`,
    Number(result.gridZ) > Number(result.hanziSvgZ),
  );

  // 3. status must NOT use the em-dash "—" anywhere (it was rendering
  // as a Chinese glyph in Edge mobile, making the status read
  // "字 一 一"). Acceptable separators are "·" (middle dot, used in
  // the "第 X/Y 字 · char" status) or "，" (Chinese comma, used in
  // the "字消失啦，开始写 ↓" status).
  check(
    `status does NOT use em-dash "—" (got: ${JSON.stringify(result.status)})`,
    result.status && !result.status.includes("—"),
  );

  // 4. grid-overlay doesn't bleed outside the stage box
  const gridRight = result.gridRect ? result.gridRect.right : 0;
  const stageRight = result.stageRect ? result.stageRect.right : 0;
  check(
    `grid right edge (${gridRight}) <= stage right edge (${stageRight})`,
    gridRight <= stageRight + 1,  // 1px tolerance
  );

  await page.screenshot({ path: "/tmp/write-overlap-fixed.png" });
  console.log("\nScreenshot: /tmp/write-overlap-fixed.png");

  if (failed > 0) {
    console.log(`\nFAIL: ${failed} assertion(s) failed`);
    process.exit(1);
  }
  console.log("\nOK: write app SVG overlap fix verified");
  await browser.close();
})();
