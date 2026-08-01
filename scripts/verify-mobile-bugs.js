// Playwright smoke test for the mobile-bug batch (issue #64).
// Three things to verify, all client-side, all easy to assert:
//
//   1. Portal cards stack with a gap between candy + write (the bug
//      was a plain <div id="apps"> with no grid + no gap, so two JS-
//      injected cards glued together).
//   2. Write app no longer auto-advances after a stroke — the next
//      button gets a `.cta` highlight and stays clickable for the kid
//      to tap when ready. The old setTimeout(2500) auto-jump is gone.
//   3. Buddy chat, when loaded over a LAN IP, surfaces the "use
//      mac-mini.local" guidance in the no-device overlay.
//
// Run with the dev server running locally on port 3000:
//   NODE_PATH=/Users/mac/.npm/_npx/aa1f6563a672b75d/node_modules \
//     TEST_URL=http://localhost:3000 \
//     node scripts/verify-mobile-bugs.js
const { chromium, devices } = require("playwright");

const BASE = process.env.TEST_URL || "https://localhost:3000";

(async () => {
  const browser = await chromium.launch({
    executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  });
  const ctx = await browser.newContext({ ...devices["Pixel 6"] });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log("[pageerror]", e.message));

  let failed = 0;
  function check(label, cond) {
    const ok = !!cond;
    console.log(`  ${ok ? "OK " : "FAIL"}  ${label}`);
    if (!ok) failed++;
  }

  // ============================================================
  // 1. Portal cards have gap between candy + write
  // ============================================================
  console.log("=== Portal gap ===");
  await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(800);
  const portalInfo = await page.evaluate(async () => {
    const r = await fetch("/api/apps").then((r) => r.json());
    // Wait for JS to inject the cards
    const container = document.getElementById("apps");
    return new Promise((resolve) => {
      const t = setInterval(() => {
        const cards = container ? container.querySelectorAll(".entry") : [];
        if (cards.length >= (r.apps || []).length) {
          clearInterval(t);
          const rects = Array.from(cards).map((c) => c.getBoundingClientRect());
          const containerStyle = container ? getComputedStyle(container) : null;
          resolve({
            cardCount: cards.length,
            cardRects: rects.map((r) => ({ top: r.top, bottom: r.bottom })),
            containerDisplay: containerStyle ? containerStyle.display : null,
            containerGap: containerStyle ? containerStyle.gap : null,
          });
        }
      }, 100);
      setTimeout(() => { clearInterval(t); resolve({ error: "timeout" }); }, 4000);
    });
  });
  console.log("  portal info:", JSON.stringify(portalInfo));
  if (portalInfo.error) {
    check("portal cards injected", false);
  } else {
    check(`#apps has display:${portalInfo.containerDisplay}`, portalInfo.containerDisplay === "grid");
    check(`#apps has non-zero gap (got: ${portalInfo.containerGap})`,
      portalInfo.containerGap && portalInfo.containerGap !== "normal" && portalInfo.containerGap !== "0px");
    // Check at least 2 cards and that gap between them is non-zero
    if (portalInfo.cardRects.length >= 2) {
      const gap = portalInfo.cardRects[1].top - portalInfo.cardRects[0].bottom;
      check(`gap between card[0] bottom (${portalInfo.cardRects[0].bottom}) and card[1] top (${portalInfo.cardRects[1].top}) is > 4px (got: ${gap})`,
        gap > 4);
    } else {
      check("at least 2 app cards present", false);
    }
  }

  // ============================================================
  // 2. Write app: no auto-advance, next button gets .cta after stroke
  // ============================================================
  console.log("\n=== Write app: no auto-advance ===");
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
  await page.goto(`${BASE}/write/`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(800);
  await page.reload();
  await page.waitForTimeout(500);
  await page.fill("#chars-input", "一");
  await page.click("#add-btn");
  await page.waitForTimeout(300);
  await page.click("#start-btn");
  // Wait for HanziWriter to mount (CDN glyph data is async)
  await page.waitForFunction(() => {
    const h = document.getElementById("hanzi-target");
    return h && h.querySelector("svg path[stroke*='76,175,80']");
  }, { timeout: 5000 });
  // v0.8.2 (issue #68): phase timing is now animation (~2.5s) +
  // 3s "look" = ~5.5s before writing. The v0.8.1 setTimeout(100)
  // bug had it at 3.1s, so this used to wait 3.5s. Bumped to 6s
  // so we land in the writing phase before drawing.
  await page.waitForTimeout(6000);

  // Draw a horizontal line to trigger the compare mode
  const stageBox = await page.locator("#stage").boundingBox();
  const y = stageBox.y + stageBox.height / 2;
  const x0 = stageBox.x + stageBox.width * 0.25;
  const x1 = stageBox.x + stageBox.width * 0.75;
  await page.mouse.move(x0, y);
  await page.mouse.down();
  for (let t = 0; t <= 1; t += 0.05) {
    await page.mouse.move(x0 + (x1 - x0) * t, y);
  }
  await page.mouse.up();
  await page.waitForTimeout(500);
  // v0.8 (issue #65): submit is manual — kid taps "提交" to enter
  // compare mode. v0.7 auto-submitted on stroke end. The mobile-bugs
  // test was written for v0.7's behaviour and didn't click submit.
  // Click it now so the test can verify the no-auto-advance contract.
  await page.click("#submit-btn", { force: true });
  await page.waitForTimeout(1500);  // wait for compare mode to settle

  // v0.8 (issue #65): the .cta highlight is on the "重练" button
  // (the kid-friendly "try again") rather than the destructive
  // "下一题". PR #64 (the original mobile-bugs PR) put .cta on
  // "下一题" — the test was written for that. Update the assertion
  // to match v0.8's UX choice.
  const writeState = await page.evaluate(() => {
    const retryBtn = document.getElementById("retry-btn");
    const nextBtn = document.getElementById("next-btn");
    const status = document.getElementById("status");
    return {
      retryHasCta: retryBtn ? retryBtn.classList.contains("cta") : null,
      nextText: nextBtn ? nextBtn.textContent : null,
      statusText: status ? status.textContent : null,
    };
  });
  console.log("  write state:", JSON.stringify(writeState));
  check(`retry button has .cta class (got: ${writeState.retryHasCta})`, writeState.retryHasCta === true);
  check(`status prompts for retry/next (got: "${writeState.statusText}")`,
    writeState.statusText && writeState.statusText.includes("下一题"));

  // Wait 3 more seconds and verify we did NOT auto-advance
  await page.waitForTimeout(3000);
  const stillThere = await page.evaluate(() => {
    const status = document.getElementById("status");
    return status ? status.textContent : null;
  });
  check(`did NOT auto-advance after 3s wait (status: "${stillThere}")`,
    stillThere && stillThere.includes("下一题"));

  // ============================================================
  // 3. Buddy chat: LAN IP triggers the mac-mini.local guidance
  // ============================================================
  console.log("\n=== Buddy secure-context guidance (LAN IP) ===");
  // Navigate via the LAN IP so location.origin is the real IP. The
  // server is bound to localhost but accepts any Host header, so
  // 127.0.0.1 + Host: 192.168.0.112:3000 still hits the dev server.
  const LAN_BASE = process.env.TEST_URL_LAN || "http://192.168.0.112:3000";
  await page.goto(`${LAN_BASE}/buddy/`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(800);
  // Force the no-device overlay so the hint branch fires.
  await page.evaluate(() => {
    if (!window.Buddy || !window.Buddy.chat) return;
    window.Buddy.chat.showNoDevice({
      hasVideo: false, hasAudio: false, apiAvailable: false, devices: [],
      error: "mediaDevices API 不可用", userAgent: navigator.userAgent,
      isSecureContext: false,
    });
  });
  await page.waitForTimeout(300);
  const hintText = await page.evaluate(() => {
    const el = document.getElementById("no-device-hint");
    return el ? el.innerText : null;
  });
  console.log("  hint text:", JSON.stringify(hintText));
  check(`LAN-IP hint mentions mac-mini.local (got text containing 'mac-mini.local')`,
    hintText && hintText.includes("mac-mini.local"));

  if (failed > 0) {
    console.log(`\nFAIL: ${failed} assertion(s) failed`);
    process.exit(1);
  }
  console.log("\nOK: all 3 mobile-bug fixes verified");
  await browser.close();
})();
