// Playwright integration test for the v0.8.2 fix (issue #68).
//
// Two regressions from the iPad live test of v0.8.1:
//   Bug 1: 字在动画还没跑完就进 "showing" phase (倒计时错位)
//   Bug 2: 分数都是 0 (HanziWriter path 在 <g transform> 里, raw
//          d-string 不应用 transform → IoU=0)
//
// This script verifies both:
//   A. Phase timing: at t=300ms after clicking start, the practice
//      view should STILL be in the "animating" phase (the v0.8.1
//      bug would have moved to "showing" at 100ms).
//   B. IoU math: a synthetic kid stroke that overlaps the reference
//      "一" should produce a non-zero IoU when run through the same
//      rasterize pipeline client.js uses (parseCTMString + paintPathsToCanvas).
//
// Run with the dev server running locally on port 3000:
//   NODE_PATH=/Users/mac/.npm/_npx/aa1f6563a672b75d/node_modules \
//     TEST_URL=http://localhost:3000 \
//     node scripts/verify-write-v082-fix.js
const { chromium, devices } = require("playwright");
const fs = require("fs");
const path = require("path");

const BASE = process.env.TEST_URL || "http://localhost:3000";

(async () => {
  const browser = await chromium.launch({
    executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  });
  const ctx = await browser.newContext({ ...devices["Pixel 6"] });
  const page = await ctx.newPage();
  page.on("console", (m) => console.log(`[c.${m.type()}]`, m.text()));
  page.on("pageerror", (e) => console.log("[pageerror]", e.message));

  let failed = 0;
  function check(label, cond) {
    const ok = !!cond;
    console.log(`  ${ok ? "OK " : "FAIL"}  ${label}`);
    if (!ok) failed++;
  }

  // ----- Setup: wipe + seed "一" -----
  console.log("=== Setup ===");
  await page.goto(`${BASE}/write/`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(800);
  await page.evaluate(async (base) => {
    const r = await fetch(`${base}/api/write/words`).then((r) => r.json());
    for (const w of (r.words || [])) {
      await fetch(`${base}/api/write/words/${encodeURIComponent(w.char)}`, { method: "DELETE" });
    }
    await fetch(`${base}/api/write/words`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chars: "一", addedBy: "verify" }),
    });
  }, BASE);
  await page.reload();
  await page.waitForTimeout(500);

  // =====================================================================
  // Part A: Phase timing — the fix is "showing" waits for animDone
  // =====================================================================
  console.log("\n=== Part A: phase timing (no early 'showing') ===");
  // HanziWriter's animateCharacter for "一" runs ~1-2s in chromium.
  // If the v0.8.1 setTimeout(100) bug is back, statusEl will read
  // "看 3 秒后字会消失" at the 300ms mark. The fix means status
  // should still read "看笔顺 ↓" at 300ms.
  await page.click("#start-btn");
  // Wait just 300ms — long enough for the buggy 100ms timer to fire,
  // short enough that the animation is still running.
  await page.waitForTimeout(300);
  const earlyStatus = await page.evaluate(() => {
    const s = document.getElementById("status");
    return s ? s.textContent : null;
  });
  console.log(`  status at 300ms: "${earlyStatus}"`);
  check("300ms in, status still says '看笔顺 ↓' (NOT '看 3 秒后字会消失')",
    earlyStatus && earlyStatus.includes("看笔顺") && !earlyStatus.includes("看 3 秒后字会消失"));

  // Now wait through animation + show + transition to writing.
  // Total budget: 2s (anim) + 3s (show) + 0.5s margin = 5.5s
  await page.waitForTimeout(5500);
  const finalStatus = await page.evaluate(() => {
    const s = document.getElementById("status");
    return s ? s.textContent : null;
  });
  console.log(`  status after 5.8s: "${finalStatus}"`);
  check("5.8s in, status is now '字消失啦，开始写 ↓'",
    finalStatus && finalStatus.includes("字消失啦"));

  // =====================================================================
  // Part B: IoU — ref + same-position kid stroke should overlap
  // =====================================================================
  console.log("\n=== Part B: IoU (ref with CTM + same-pos kid stroke > 0) ===");
  // Run the actual rasterize pipeline in-page. We re-import score.js
  // and rasterize.js as ES modules, then feed them a synthetic ref
  // and kid stroke at the same coordinates. If the CTM is correctly
  // applied, the ref lands at the right place; if not (v0.8.1 bug),
  // the ref lands far away and IoU is ~0.
  const iouResult = await page.evaluate(async () => {
    // Inline minimal copies of the two pure functions we need:
    //   - parseCTMString (from rasterize.js)
    //   - scoreStrokes  (from score.js)
    // We import the actual source files via dynamic import.
    const base = location.origin;
    const scoreMod = await import("/write/score.js");
    const rastMod = await import("/write/rasterize.js");

    // Build a 100x100 canvas.
    const SIZE = 100;
    const c = document.createElement("canvas");
    c.width = SIZE;
    c.height = SIZE;
    const ctx = c.getContext("2d");
    ctx.imageSmoothingEnabled = false;
    const scale = SIZE / 600;

    // Synthetic "ref": the HanziWriter transform that the iPad
    // emits (verified by hand on the live device). Without this
    // transform, the d-string would land at "M 25 421" — far
    // outside the visible area.
    const refTransform = "translate(5, 523.5546875) scale(0.576171875, -0.576171875)";
    const refCtm = rastMod.parseCTMString(refTransform);

    // Synthetic ref d-string: a horizontal line that maps to a
    // horizontal stripe in the 600x600 viewBox (a "一" stroke).
    // After the CTM, raw (25, 421) → viewBox (19.4, 281.0) and
    // raw (920, 401) → viewBox (535.0, 292.5). Both are well
    // inside the 600x600 viewBox.
    const refD = "M 25 421 L 920 401";

    // Paint the ref with its CTM. The bitmap lands at canvas
    // pixels (~3-89, ~47-49) after scale 1/6.
    ctx.save();
    ctx.scale(scale, scale);
    ctx.strokeStyle = "#000";
    ctx.lineWidth = 6;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    rastMod.paintPathsToCanvas(ctx, [refD], refCtm, 6);
    ctx.restore();
    const refPixels = ctx.getImageData(0, 0, SIZE, SIZE).data;
    const refBitmap = new Uint8Array(SIZE * SIZE);
    for (let i = 0, j = 0; i < refPixels.length; i += 4, j++) {
      refBitmap[j] = refPixels[i + 3] > 0 ? 1 : 0;
    }

    // Kid stroke: a horizontal line at the SAME visual position
    // as the ref. The kid draws into the kid-svg viewBox (600x600,
    // no transform), so the d-string IS in visual coordinates. We
    // pick a line at viewBox (50, 290) → (550, 290), which lands
    // at canvas pixels (~8-92, ~48) — fully overlapping the ref.
    // Without the v0.8.2 fix, the ref bitmap would be empty (the
    // d-string lives outside the viewBox when read as raw coords)
    // and IoU would be 0. With the fix, both bitmaps have the
    // horizontal stripe and IoU ≈ 1.
    ctx.clearRect(0, 0, SIZE, SIZE);
    ctx.save();
    ctx.scale(scale, scale);
    ctx.lineWidth = 6;
    rastMod.paintPathsToCanvas(ctx, ["M 50 290 L 550 290"], null, 6);
    ctx.restore();
    const kidPixels = ctx.getImageData(0, 0, SIZE, SIZE).data;
    const kidBitmap = new Uint8Array(SIZE * SIZE);
    for (let i = 0, j = 0; i < kidPixels.length; i += 4, j++) {
      kidBitmap[j] = kidPixels[i + 3] > 0 ? 1 : 0;
    }

    const { stars, breakdown } = scoreMod.scoreStrokes({
      kidStrokes: 1,
      refStrokes: 1,
      kidBitmap,
      refBitmap,
      size: SIZE,
    });
    return { stars, breakdown, refNonZero: refBitmap.some((p) => p === 1), kidNonZero: kidBitmap.some((p) => p === 1) };
  });
  console.log("  IoU result:", JSON.stringify(iouResult));
  check("ref bitmap is non-empty (CTM was applied, d-string landed in viewBox)",
    iouResult.refNonZero === true);
  check("kid bitmap is non-empty (kid stroke painted)", iouResult.kidNonZero === true);
  check(`IoU > 0.5 (same stroke should fully overlap): got ${iouResult.breakdown?.iou?.toFixed(3)}`,
    iouResult.breakdown && iouResult.breakdown.iou > 0.5);
  check(`stars === 3 for perfect overlap: got ${iouResult.stars}`,
    iouResult.stars === 3);

  if (failed > 0) {
    console.log(`\nFAIL: ${failed} assertion(s) failed`);
    process.exit(1);
  }
  console.log("\nOK: v0.8.2 fix verified (phase timing + IoU)");
  await browser.close();
})();
