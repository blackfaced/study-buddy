// Playwright smoke test for candy game weak-topics integration.
// Loads the game, intercepts console, clicks Start, captures the
// first 7 question displays, then exits. Output: a markdown summary.
//
// Run: NODE_PATH=/Users/mac/.npm/_npx/aa1f6563a672b75d/node_modules node scripts/verify-candy-weak-topics.js
const { chromium } = require("playwright");
const path = require("path");

(async () => {
  const browser = await chromium.launch({
    executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  });
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await ctx.newPage();

  const consoleMsgs = [];
  page.on("console", (msg) => consoleMsgs.push(`[${msg.type()}] ${msg.text()}`));
  page.on("pageerror", (err) => consoleMsgs.push(`[pageerror] ${err.message}`));

  // Hook fetch to capture weak-topics request + response.
  let weakTopicsResponse = null;
  page.on("response", async (resp) => {
    if (resp.url().includes("/api/game/weak-topics")) {
      try { weakTopicsResponse = await resp.json(); } catch {}
    }
  });

  await page.goto("https://localhost:3000/games/candy-math-island/");
  await page.waitForSelector("#btn-start", { state: "visible", timeout: 10000 });

  // Click Start. startQuiz() is async (fetches weak-topics) so we wait
  // a beat for the page transition + first question to settle.
  await page.click("#btn-start");
  await page.waitForSelector("#page-quiz.active", { timeout: 5000 });
  await page.waitForTimeout(500);

  // Capture the first 7 question displays by reading the DOM.
  const displays = [];
  for (let i = 0; i < 7; i++) {
    const t = await page.textContent("#q-text");
    displays.push(t);
    // type a dummy answer to advance.
    await page.fill("#answer-input", "999");
    await page.press("#answer-input", "Enter");
    await page.waitForTimeout(350);  // nextQuestion delay
  }

  // Detect errorType from each display (mirror server's detectErrorType).
  const classify = (s) => {
    if (s.includes("×") || s.includes("个")) return "multiply";
    if (s.includes("+")) {
      const m = s.match(/(\d+)\s*\+\s*(\d+)/);
      if (m) {
        const a = +m[1], b = +m[2];
        if ((a % 10) + (b % 10) >= 10) return "carry";
      }
      return "compute";
    }
    if (s.includes("-")) {
      const m = s.match(/(\d+)\s*-\s*(\d+)/);
      if (m) {
        const a = +m[1], b = +m[2];
        if ((a % 10) < (b % 10)) return "borrow";
      }
      return "compute";
    }
    return "compute";
  };
  const types = displays.map(classify);
  const counts = {};
  for (const t of types) counts[t] = (counts[t] || 0) + 1;

  console.log("=== Verify #16: candy weak-topics bias ===");
  console.log("weakTopics response:", JSON.stringify(weakTopicsResponse, null, 2));
  console.log("first 7 question displays:");
  displays.forEach((d, i) => console.log(`  ${i + 1}. ${d}  →  ${types[i]}`));
  console.log("errorType distribution:", counts);

  if (consoleMsgs.length > 0) {
    console.log("--- browser console ---");
    consoleMsgs.forEach((m) => console.log(m));
  }

  await browser.close();
})();
