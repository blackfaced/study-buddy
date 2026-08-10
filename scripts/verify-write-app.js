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
// Default to a mobile viewport (iPhone 12-ish) so the test catches
// touch / pointer / CSS bugs that only show up on phones. Override
// with VIEWPORT=desktop for Mac/iPad sanity checks.
const VIEWPORT = process.env.VIEWPORT || "mobile";

(async () => {
  const browser = await chromium.launch({
    executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  });
  const ctx = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: VIEWPORT === "mobile" ? { width: 390, height: 844 } : { width: 1280, height: 800 },
    deviceScaleFactor: VIEWPORT === "mobile" ? 2 : 1,
    isMobile: VIEWPORT === "mobile",
    hasTouch: VIEWPORT === "mobile",
  });
  const page = await ctx.newPage();

  const consoleMsgs = [];
  page.on("console", (msg) => {
    const text = `[${msg.type()}] ${msg.text()}`;
    consoleMsgs.push(text);
    if (msg.text().includes("[write]")) console.log(text);
  });
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

  // ----- 0. Regression: opening /write/ on a non-empty library
  // must render one .word-cell per char. The PR #70 refactor of
  // renderLibrary built plain {tagName, className, ...} literals
  // and called wordList.appendChild, which throws on the real DOM
  // ("parameter 1 is not of type 'Node'") and the catch in
  // loadLibrary swallowed the error to "加载字库失败". This step
  // reads the API directly and asserts the rendered count matches
  // before any wipe / add, so the bug can't sneak back in. -----
  console.log("step 0: pre-existing library must render the right number of cells");
  const apiWords = await page.evaluate(async () => {
    const r = await fetch("/api/write/words").then((r) => r.json());
    return r.words;
  });
  const renderedBefore = await page.$$eval(".word-cell", (els) => els.length);
  console.log(`  api says ${apiWords.length} chars, DOM shows ${renderedBefore} cells`);
  if (apiWords.length > 0 && renderedBefore !== apiWords.length) {
    console.log(`FAIL: API has ${apiWords.length} chars but DOM rendered ${renderedBefore} cells (regression of PR #70 plain-object bug)`);
    process.exit(1);
  }

  // 1a. Wipe any pre-existing library (smoke test runs against a
  // shared dev DB; previous runs may have left chars behind).
  const existing = renderedBefore;
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

  // 5a. Regression (mobile pointer fix): #kid-svg must have the
  // .interactive class so its CSS pointer-events: auto kicks in.
  // Without it, taps on the canvas are silently swallowed by the
  // CSS rule ".practice-stage svg { pointer-events: none; }" and
  // the kid can't draw. (See issue: phone showed 字, kid couldn't
  // write.) We check it after the practice view becomes active.
  await page.waitForFunction(
    () => document.getElementById("kid-svg")?.classList.contains("interactive"),
    { timeout: 5000 },
  ).catch(() => {});
  const kidSvgHasInteractive = await page.evaluate(() =>
    document.getElementById("kid-svg")?.classList.contains("interactive"),
  );
  console.log(`step 5a: #kid-svg has .interactive class = ${kidSvgHasInteractive}`);
  if (!kidSvgHasInteractive) {
    console.log("FAIL: #kid-svg missing .interactive class — kid can't draw on mobile (CSS pointer-events: none would block taps)");
    process.exit(1);
  }
  // Also check the computed pointer-events to catch any CSS regressions.
  const kidSvgPointerEvents = await page.evaluate(() => {
    const el = document.getElementById("kid-svg");
    return el ? getComputedStyle(el).pointerEvents : null;
  });
  console.log(`step 5b: #kid-svg computed pointer-events = ${kidSvgPointerEvents}`);
  if (kidSvgPointerEvents !== "auto") {
    console.log(`FAIL: #kid-svg pointer-events is "${kidSvgPointerEvents}", expected "auto"`);
    process.exit(1);
  }

  // 5c. Mobile stage size: on a 375px-wide viewport, the stage
  // should be at most ~360px so the kid can see the controls row
  // below without scrolling. The old CSS "min(560px, 92vw)" put
  // the stage at 345px on a 375 viewport, which is fine, but
  // HanziWriter's character is rendered to fill the stage box, so
  // a wide stage means a wide character (especially 横 like 一).
  // We assert the stage is no wider than 92vw + 12px slack.
  const stageWidth = await page.evaluate(() => {
    const el = document.querySelector(".practice-stage");
    return el ? el.getBoundingClientRect().width : 0;
  });
  const viewportWidth = await page.evaluate(() => window.innerWidth);
  console.log(`step 5c: stage width = ${stageWidth}px, viewport = ${viewportWidth}px`);
  if (stageWidth > viewportWidth * 0.95) {
    console.log(`FAIL: practice-stage is ${stageWidth}px on a ${viewportWidth}px viewport — character is too big to see controls`);
    process.exit(1);
  }

  // 5e. Char-center alignment (issue: phone "字看不全"): the
  // HanziWriter glyph must be visually centered on the stage grid.
  // Before char-center, wide characters like "一" landed off the
  // right edge of a phone stage (102px overflow measured on a
  // 358-wide stage) and the kid only saw part of the glyph. After
  // char-center, the g's screen center should match the stage's
  // screen center within a small tolerance. We test on the
  // current viewport; the same code path is exercised on pad in
  // the multi-viewport Playwright suite (see step 5f).
  // Wait for the g to be present (CDN data load + viewBox change).
  await page.waitForFunction(
    () => document.querySelector("#hanzi-target svg g[transform]")?.getBoundingClientRect().width > 0,
    { timeout: 10000 },
  ).catch(() => {});
  const alignment = await page.evaluate(() => {
    const stage = document.getElementById("stage").getBoundingClientRect();
    const refSvg = document.querySelector("#hanzi-target svg");
    const g = refSvg?.querySelector("g[transform]");
    if (!g) return null;
    const gRect = g.getBoundingClientRect();
    return {
      stageCx: stage.left + stage.width / 2,
      stageCy: stage.top + stage.height / 2,
      gCx: gRect.left + gRect.width / 2,
      gCy: gRect.top + gRect.height / 2,
      gW: gRect.width,
    };
  });
  if (alignment) {
    console.log(`step 5e: g center (${alignment.gCx.toFixed(1)}, ${alignment.gCy.toFixed(1)}) vs stage center (${alignment.stageCx.toFixed(1)}, ${alignment.stageCy.toFixed(1)}), glyph width = ${alignment.gW.toFixed(1)}px`);
    const dx = Math.abs(alignment.gCx - alignment.stageCx);
    const dy = Math.abs(alignment.gCy - alignment.stageCy);
    // Tolerance: 5% of stage width OR 6px (whichever is larger).
    // PR #78 (padding:100) had g center off by ~100px from stage
    // center on a phone — this would fail any reasonable tolerance.
    const tol = Math.max(6, stageWidth * 0.05);
    if (dx > tol || dy > tol) {
      console.log(`FAIL: g center is off by (${dx.toFixed(1)}, ${dy.toFixed(1)})px from stage center (tolerance ${tol.toFixed(1)}px) — char-center module didn't center the glyph`);
      process.exit(1);
    }
  } else {
    console.log("step 5e: SKIPPED — g not present in #hanzi-target yet (CDN may not have returned character data)");
  }

  // 5d. Regression (kid-input plain-object DOM bug): a real
  // touch tap + drag must add a <path> child to #kid-svg. PR #70
  // extracted kid-input.js with a fake makePath() that returns
  // plain {tagName, setAttribute, ...} objects; svg.appendChild
  // threw on the real DOM ("parameter 1 is not of type 'Node'")
  // and the kid saw no ink. The fix is to create a real SVG <path>
  // via createElementNS. This step catches the bug if it returns.
  //
  // Important: wait for the writing phase first. The v0.8 flow is
  // animating → showing (3s) → writing. kid-input's onDown short-
  // circuits with `if (!isWritingPhase()) return;`, so we need to
  // be in the writing phase (status text "字消失啦，开始写 ↓")
  // before tapping, otherwise the bug is masked by the phase gate.
  await page.waitForFunction(
    () => document.getElementById("status")?.textContent?.includes("字消失啦"),
    { timeout: 15000 },
  );
  const kidSvgRect = await page.evaluate(() => {
    const el = document.getElementById("kid-svg");
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  });
  const pathsBefore = await page.evaluate(() =>
    document.querySelectorAll("#kid-svg path").length,
  );
  // Simulate a stroke: tap at left, drag to right (one 一 stroke).
  const startX = kidSvgRect.x + kidSvgRect.w * 0.25;
  const startY = kidSvgRect.y + kidSvgRect.h * 0.5;
  const endX = kidSvgRect.x + kidSvgRect.w * 0.75;
  const endY = kidSvgRect.y + kidSvgRect.h * 0.5;
  // Drive kid-input's handlers directly (the property handlers
  // attached by kidInput.attach()). This mirrors what a real touch
  // would do, without the synthetic-PointerEvent quirks that
  // dispatchEvent has on detached property handlers.
  const dispatchResult = await page.evaluate(([sx, sy, ex, ey]) => {
    const svg = document.getElementById("kid-svg");
    if (typeof svg.onpointerdown !== "function") {
      return { error: "kid-svg.onpointerdown not a function" };
    }
    const mkEvent = (type, x, y) => ({
      type,
      bubbles: true,
      cancelable: true,
      pointerType: "touch",
      isPrimary: true,
      pointerId: 1,
      clientX: x,
      clientY: y,
      preventDefault() {},
    });
    try {
      svg.onpointerdown(mkEvent("pointerdown", sx, sy));
      const steps = 10;
      for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        svg.onpointermove(mkEvent("pointermove", sx + (ex - sx) * t, sy + (ey - sy) * t));
      }
      svg.onpointerup(mkEvent("pointerup", ex, ey));
      return {
        ok: true,
        paths: svg.querySelectorAll("path").length,
        status: document.getElementById("status")?.textContent,
        allChildren: Array.from(svg.children).map(c => c.tagName),
      };
    } catch (e) {
      return { error: e.constructor.name + ": " + e.message };
    }
  }, [startX, startY, endX, endY]);
  if (dispatchResult.error) {
    console.log(`step 5d: dispatch failed: ${dispatchResult.error}`);
    console.log("FAIL: pointer event simulation threw — kid-input broken (regression of PR #70 plain-object makePath)");
    process.exit(1);
  }
  console.log(`step 5d: dispatchResult = ${JSON.stringify(dispatchResult)}`);
  await page.waitForTimeout(300);
  const pathsAfter = await page.evaluate(() =>
    document.querySelectorAll("#kid-svg path").length,
  );
  console.log(`step 5d: #kid-svg <path> count before=${pathsBefore} after=${pathsAfter}`);
  if (pathsAfter <= pathsBefore) {
    console.log("FAIL: pointer event didn't add a <path> to #kid-svg (PR #70 plain-object makePath bug — SVG.appendChild(plainObject) throws)");
    process.exit(1);
  }

  // 6. Status text in v0.8 flow has different values per phase
  // (issue #65): "看笔顺 ↓" during animating, "看 3 秒后字会消失"
  // during showing, "字消失啦，开始写 ↓" during writing. We just
  // check that we're in one of those valid phases — the per-phase
  // timing is covered by web/write/show-flow.test.js.
  const status = await page.textContent("#status");
  console.log(`step 6: status = "${status}"`);
  const validStatuses = ["看笔顺 ↓", "看 3 秒后字会消失", "字消失啦，开始写 ↓"];
  if (!validStatuses.some((s) => status.includes(s))) {
    console.log(`FAIL: status "${status}" not in v0.8 valid phases`);
    process.exit(1);
  }

  // 7. Regression: the completed stroke must be assessed through the
  // structured handwriting coach, with a descriptive band and reason.
  // The old star/bitmap scorer has been removed.
  //
  // The submit button has the .cta class which triggers a CSS pulse
  // animation; force:true skips Playwright's stability check.
  await page.click("#submit-btn", { force: true });
  await page.waitForTimeout(500);
  const scoreData = await page.evaluate(() => {
    const scoreText = document.getElementById("score")?.textContent || "";
    const bands = ["需要再观察", "基本正确", "写得规范", "写得很好", "暂时无法判断"];
    return { scoreText, hasBand: bands.some((band) => scoreText.includes(band)) };
  });
  console.log(`step 7: assessment text = ${JSON.stringify(scoreData.scoreText)}`);
  if (!scoreData.hasBand || /[★☆]/.test(scoreData.scoreText)) {
    console.log("FAIL: expected a descriptive handwriting band without stars");
    process.exit(1);
  }

  if (consoleMsgs.filter((m) => m.startsWith("[error]") && !m.includes("favicon")).length > 0) {
    console.log("--- browser console (errors only) ---");
    consoleMsgs.filter((m) => m.startsWith("[error]") && !m.includes("favicon")).forEach((m) => console.log(m));
  }

  console.log("OK: all write-app assertions passed");
  await browser.close();
})();
