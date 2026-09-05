// Real WebKit layout tests against this checkout's HTML/modules.
// The loopback fixture server has no database or access to either live instance.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import express from "../server/node_modules/express/index.js";
import { webkit, devices } from "playwright";

const taskSet = {
  id: "layout-fixture",
  words: ["苹果"],
  sentence: "春天来了，我们一起去公园看美丽的花朵。",
  wordPlays: 1,
  sentencePlays: 1,
  status: "active",
};
let browser;
let server;
let base;

before(async () => {
  const app = express();
  app.get("/api/write/words", (_req, res) =>
    res.json({ words: [{ id: "one", char: "一", attemptCount: 0 }] }),
  );
  app.get("/api/dictation/sets", (_req, res) => res.json({ sets: [taskSet] }));
  app.post("/api/dictation/sets/:id/submissions", (_req, res) =>
    res.json({ mistakeCases: [] }),
  );
  app.use(express.static(fileURLToPath(new URL("../web/", import.meta.url))));
  server = await new Promise((resolve) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });
  base = `http://127.0.0.1:${server.address().port}`;
  browser = await webkit.launch();
});

after(async () => {
  await browser?.close();
  await new Promise((resolve) => (server ? server.close(resolve) : resolve()));
});

async function startDictation(t, viewport = { width: 1024, height: 640 }) {
  const context = await browser.newContext({
    ...devices["iPad Mini"],
    viewport,
  });
  t.after(() => context.close());
  const page = await context.newPage();
  await page.goto(base + "/write/");
  await page.locator(".dictation-set-btn").click();
  await page.locator("#practice-view.active").waitFor();
  return page;
}

async function assertOnscreen(page, selector) {
  const bounds = await page.locator(selector).boundingBox();
  const viewport = page.viewportSize();
  assert.ok(
    bounds && bounds.width > 0 && bounds.height > 0,
    `${selector} must be visible`,
  );
  assert.ok(
    bounds.y >= 0 && bounds.y + bounds.height <= viewport.height,
    `${selector} must fit vertically: bottom=${bounds.y + bounds.height}, viewport=${viewport.height}`,
  );
  assert.ok(
    bounds.x >= 0 && bounds.x + bounds.width <= viewport.width,
    `${selector} must fit horizontally`,
  );
}

test("landscape: submit, replay and exit stay onscreen while writing", async (t) => {
  const page = await startDictation(t);
  for (const selector of ["#submit-btn", "#replay-audio-btn", "#exit-btn"]) {
    await assertOnscreen(page, selector);
  }
  await page.locator("#submit-btn").click();
  await page.locator("#dictation-outcome").waitFor();
  for (const selector of [
    "#next-btn",
    "#outcome-correct",
    "#outcome-poor",
    "#exit-btn",
  ]) {
    await assertOnscreen(page, selector);
  }
});

test("two-character dictation provides two square writing cells without revealing the answer", async (t) => {
  const page = await startDictation(t);
  const cells = page.locator("#stage .dictation-cell");
  assert.equal(await cells.count(), 2, "苹果 needs two writing cells");
  for (const cell of await cells.all()) {
    const box = await cell.boundingBox();
    assert.ok(
      box.width >= 120,
      "each cell must remain large enough to write in",
    );
    assert.ok(
      Math.abs(box.width - box.height) < 2,
      "word cells must be square",
    );
  }
  assert.ok(
    !(await page.locator("#practice-view").innerText()).includes("苹果"),
  );
});

test("sentence dictation uses multiple horizontal writing lines, with controls visible", async (t) => {
  const page = await startDictation(t);
  await page.locator("#submit-btn").click();
  await page.locator("#outcome-correct").click();
  await page.locator("#next-btn").click();
  const lines = page.locator("#stage .dictation-line");
  assert.ok(
    (await lines.count()) >= 2,
    "a sentence needs multiple writing lines",
  );
  assert.equal(await page.locator("#stage .dictation-cell").count(), 0);
  for (const line of await lines.all()) {
    const box = await line.boundingBox();
    assert.ok(
      box.width > 300 && box.height < 3,
      "sentence guides must be horizontal",
    );
  }
  assert.match(await page.locator("#status").textContent(), /横线/);
  assert.ok(
    !(await page.locator("#practice-view").innerText()).includes(
      taskSet.sentence,
    ),
  );
  await assertOnscreen(page, "#submit-btn");
  await page.locator("#submit-btn").click();
  await assertOnscreen(page, "#outcome-correct");
  await assertOnscreen(page, "#next-btn");
});

async function drawIn(page, locator) {
  const box = await locator.boundingBox();
  const from = { x: box.x + box.width * 0.3, y: box.y + box.height * 0.4 };
  const to = { x: box.x + box.width * 0.7, y: box.y + box.height * 0.6 };
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 4 });
  await page.mouse.up();
  const ink = await page.locator("#kid-svg path").last().boundingBox();
  assert.ok(
    ink && Math.abs(ink.x - from.x) < 4 && Math.abs(ink.y - from.y) < 4,
    "ink must appear under the pointer, including in the second cell",
  );
}

test("word ink stays in its cell across rotation, reload, reveal and undo", async (t) => {
  const page = await startDictation(t);
  const cells = page.locator("#stage .dictation-cell");
  await drawIn(page, cells.nth(0));
  await drawIn(page, cells.nth(1));
  const paths = await page
    .locator("#kid-svg path")
    .evaluateAll((els) => els.map((el) => el.getAttribute("d")));
  await page.setViewportSize({ width: 768, height: 1024 });
  await page.reload();
  await page.locator("#practice-view.active").waitFor();
  assert.deepEqual(
    await page
      .locator("#kid-svg path")
      .evaluateAll((els) => els.map((el) => el.getAttribute("d"))),
    paths,
  );
  const second = await cells.nth(1).boundingBox();
  const ink = await page.locator("#kid-svg path").nth(1).boundingBox();
  assert.ok(ink.x > second.x && ink.x + ink.width < second.x + second.width);
  await page.locator("#undo-btn").click();
  assert.equal(await page.locator("#kid-svg path").count(), 1);
  await page.locator("#submit-btn").click();
  assert.equal(
    await cells.count(),
    2,
    "the comparison must keep the original paper geometry",
  );
  assert.equal(await page.locator("#kid-svg path").count(), 1);
  await page.setViewportSize({ width: 1024, height: 640 });
  await assertOnscreen(page, "#next-btn");
  await assertOnscreen(page, "#outcome-correct");
});

test("finishing dictation restores a square single-character practice area in landscape", async (t) => {
  const page = await startDictation(t);
  // Supply deterministic external glyph data; the actual Hanzi Writer runs.
  await page.route("https://cdn.jsdelivr.net/**", (route) =>
    route.fulfill({
      json: {
        strokes: ["M 100 500 L 900 500 L 900 550 L 100 550 Z"],
        medians: [
          [
            [100, 525],
            [900, 525],
          ],
        ],
      },
    }),
  );
  for (let item = 0; item < 2; item += 1) {
    await page.locator("#submit-btn").click();
    await page.locator("#outcome-correct").click();
    await page.locator("#next-btn").click();
  }
  await page.locator("#submit-btn").click();
  await page.locator("#home-view:not(.hidden)").waitFor();
  await page.locator(".word-cell input[type=checkbox]").check();
  await page.locator("#start-btn").click();
  await page.locator("#hanzi-target svg").waitFor();
  const stage = await page.locator("#stage").boundingBox();
  assert.ok(
    Math.abs(stage.width - stage.height) < 2,
    "single-character practice must be square again",
  );
  assert.equal(await page.locator("#dictation-guides").isVisible(), false);
  assert.equal(await page.locator("#stage .grid-overlay").isVisible(), true);
  await assertOnscreen(page, "#again-btn");
  await assertOnscreen(page, "#exit-btn");
});

test("long sentences keep usable line spacing and scroll inside the writing area", async (t) => {
  const context = await browser.newContext({
    ...devices["iPad Mini"],
    viewport: { width: 1024, height: 640 },
  });
  t.after(() => context.close());
  const page = await context.newPage();
  await page.route("**/api/dictation/sets", (route) =>
    route.fulfill({
      json: {
        sets: [{ ...taskSet, sentence: "我们一起去公园看花。".repeat(10) }],
      },
    }),
  );
  await page.goto(base + "/write/");
  await page.locator(".dictation-set-btn").click();
  await page.locator("#submit-btn").click();
  await page.locator("#outcome-correct").click();
  await page.locator("#next-btn").click();
  const lines = page.locator(".dictation-line");
  const first = await lines.nth(0).boundingBox();
  const second = await lines.nth(1).boundingBox();
  assert.ok(
    second.y - first.y >= 60,
    "a long sentence must not shrink the handwriting rows",
  );
  await lines.last().scrollIntoViewIfNeeded();
  await assertOnscreen(page, ".dictation-line:last-child");
  await assertOnscreen(page, "#submit-btn");
  await assertOnscreen(page, "#exit-btn");
  await page.locator("#submit-btn").click();
  await assertOnscreen(page, "#outcome-correct");
  await assertOnscreen(page, "#next-btn");
});

test("rectangular word sheets keep the same pen thickness horizontally and vertically", async (t) => {
  const page = await startDictation(t);
  const cell = await page.locator(".dictation-cell").first().boundingBox();
  const x = cell.x + cell.width / 3;
  const y = cell.y + cell.height / 3;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 60, y, { steps: 3 });
  await page.mouse.up();
  await page.mouse.move(x, y + 30);
  await page.mouse.down();
  await page.mouse.move(x, y + 90, { steps: 3 });
  await page.mouse.up();
  const horizontal = await page.locator("#kid-svg path").nth(0).boundingBox();
  const vertical = await page.locator("#kid-svg path").nth(1).boundingBox();
  assert.ok(
    horizontal.height > 0 && vertical.width > 0,
    "strokes must be visible",
  );
  assert.ok(
    Math.abs(horizontal.height - vertical.width) < 0.5,
    `pen thickness must not stretch with the sheet: horizontal=${horizontal.height}, vertical=${vertical.width}`,
  );
});
