// web/buddy/photo-items.test.js
//
// Tests for the multi-item 拍错题 review UI helpers in photo-items.js:
// the server splits every wrong spot in the photo into its own item
// ({problem, userAnswer, correctAnswer, subject, errorType, reasoning}),
// the overlay renders one card per item, and the parent confirms each
// item separately (POST /confirm {itemIndex}) or asks the LLM to revise
// one item (POST /items/:index/revise {instruction}). Pure helpers are
// tested here via vm; DOM wiring is manual-tested on the iPad.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "photo-items.js"), "utf8");

function loadModule() {
  const window = {};
  vm.runInNewContext(source, vm.createContext({ window }));
  return window.BuddyPhotoItems;
}

// Real scenario: the vision model splits 两处错误 into two items and the
// overlay must show both — a single-problem fallback would silently drop
// one mistake from the ledger.
test("extractItems returns every item from a multi-item draft", () => {
  const PI = loadModule();
  const items = PI.extractItems({
    draftId: "d1",
    problemText: "8+5=?",
    items: [
      { problem: "8+5=?", userAnswer: "12", correctAnswer: "13", subject: "math", errorType: "进位错误", reasoning: "个位满十未进位" },
      { problem: "春天的诗", userAnswer: "", correctAnswer: "", subject: "chinese", errorType: "", reasoning: "" },
    ],
  });
  assert.equal(items.length, 2);
  assert.equal(items[0].problem, "8+5=?");
  assert.equal(items[0].reasoning, "个位满十未进位");
  assert.equal(items[1].subject, "chinese");
});

test("extractItems falls back to [{problem: problemText}] for legacy drafts without items", () => {
  const PI = loadModule();
  const items = PI.extractItems({ draftId: "d1", problemText: "2 + 2" });
  assert.equal(items.length, 1);
  assert.equal(items[0].problem, "2 + 2");
  assert.equal(items[0].subject, "");
});

test("extractItems falls back when items is empty or not an array", () => {
  const PI = loadModule();
  assert.equal(PI.extractItems({ problemText: "1+1", items: [] }).length, 1);
  assert.equal(PI.extractItems({ problemText: "1+1", items: "nope" })[0].problem, "1+1");
});

test("extractItems normalizes items: coerces non-strings, drops unknown subjects", () => {
  const PI = loadModule();
  const items = PI.extractItems({
    items: [{ problem: 42, userAnswer: null, subject: "science", reasoning: {} }],
  });
  const item = items[0];
  assert.equal(item.problem, "42");
  assert.equal(item.userAnswer, "");
  assert.equal(item.subject, "");
  assert.equal(item.reasoning, "");
});

// --- renderItemCard ---
// One card per item in the review overlay. item carries the normalized
// fields plus transient flags: confirmed / confirming / revising / error.

test("renderItemCard renders problem, subject select and filled answer rows", () => {
  const PI = loadModule();
  const html = PI.renderItemCard({
    problem: "8+5=?", userAnswer: "12", correctAnswer: "13",
    subject: "math", errorType: "", reasoning: "个位满十未进位",
  }, 0);
  assert.ok(html.includes("8+5=?"));
  assert.ok(html.includes("12"));
  assert.ok(html.includes("13"));
  assert.ok(html.includes("个位满十未进位"), "reasoning row must render (issue #219: parent sees why)");
  // subject select: 数学 pre-selected
  assert.ok(html.includes('<option value="math" selected>'), "math option should be selected");
  assert.ok(html.includes("数学") && html.includes("语文") && html.includes("英语"));
});

test("renderItemCard skips rows for empty fields", () => {
  const PI = loadModule();
  const html = PI.renderItemCard({
    problem: "1+1=?", userAnswer: "", correctAnswer: "", subject: "", errorType: "", reasoning: "",
  }, 1);
  assert.ok(!html.includes("孩子答案"), "empty userAnswer row must not render");
  assert.ok(!html.includes("参考答案"), "empty correctAnswer row must not render");
  assert.ok(!html.includes("解析"), "empty reasoning row must not render");
});

test("renderItemCard escapes HTML in every item field (XSS)", () => {
  const PI = loadModule();
  const html = PI.renderItemCard({
    problem: "<script>alert(1)</script>",
    userAnswer: "<img src=x onerror=alert(1)>",
    correctAnswer: '"><b>',
    subject: "math", errorType: "", reasoning: "<svg onload=alert(1)>",
  }, 0);
  assert.ok(!html.includes("<script>alert"), html);
  assert.ok(!html.includes("<img src=x"), html);
  assert.ok(!html.includes("<svg onload"), html);
  assert.ok(html.includes("&lt;script&gt;"));
});

test("renderItemCard carries the item index on its interactive controls", () => {
  const PI = loadModule();
  const html = PI.renderItemCard({ problem: "1+1", subject: "math" }, 2);
  // 记录这条 / AI 改 / subject select must all know which item they act on.
  assert.ok(html.includes('data-confirm-index="2"'), html);
  assert.ok(html.includes('data-revise-index="2"'), html);
  assert.ok(html.includes('data-subject-index="2"'), html);
});

test("renderItemCard for a confirmed item is greyed, says 已记录 ✓, and has no inputs", () => {
  const PI = loadModule();
  const html = PI.renderItemCard({ problem: "1+1", subject: "math", confirmed: true }, 0);
  assert.ok(html.includes("已记录 ✓"));
  assert.ok(html.includes("ti-photo-item confirmed"), "card must carry the greyed-out class");
  assert.ok(!html.includes("data-confirm-index"), "no confirm button on a recorded card");
  assert.ok(!html.includes("data-revise-index"), "no revise controls on a recorded card");
  assert.ok(!html.includes("<select"), "no subject select on a recorded card");
});

test("renderItemCard shows the per-item error line when revise/confirm failed", () => {
  const PI = loadModule();
  const html = PI.renderItemCard({ problem: "1+1", subject: "math", error: "修改失败，请稍后重试" }, 0);
  assert.ok(html.includes("修改失败，请稍后重试"));
});

// --- buildReviseBody / reviseWithRetry / errorText ---

test("buildReviseBody trims the instruction; empty or >200 chars is rejected", () => {
  const PI = loadModule();
  assert.deepEqual(JSON.parse(JSON.stringify(PI.buildReviseBody(" 学科改成语文 "))), { instruction: "学科改成语文" });
  assert.equal(PI.buildReviseBody("   "), null);
  assert.equal(PI.buildReviseBody(""), null);
  assert.equal(PI.buildReviseBody("x".repeat(200)).instruction.length, 200);
  assert.equal(PI.buildReviseBody("x".repeat(201)), null, "server rejects instructions over 200 chars");
});

test("reviseWithRetry posts to the item revise route with the encoded draftId", async () => {
  const PI = loadModule();
  const calls = [];
  const fetchFn = async (url, opts) => {
    calls.push({ url, opts });
    return { index: 1, item: { problem: "改后的题目" } };
  };
  const out = await PI.reviseWithRetry(fetchFn, "draft a/1", 1, { instruction: "学科改成语文" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "/api/mistake-photo/draft%20a%2F1/items/1/revise");
  assert.equal(calls[0].opts.method, "POST");
  assert.equal(out.item.problem, "改后的题目");
});

test("reviseWithRetry absorbs one transient failure, then succeeds (502-flake like organize)", async () => {
  const PI = loadModule();
  let calls = 0;
  const fetchFn = async () => {
    calls += 1;
    if (calls === 1) throw new Error("502 boom");
    return { index: 0, item: { problem: "ok" } };
  };
  const out = await PI.reviseWithRetry(fetchFn, "d1", 0, { instruction: "改" });
  assert.equal(calls, 2);
  assert.equal(out.item.problem, "ok");
});

test("reviseWithRetry rethrows after the second failure", async () => {
  const PI = loadModule();
  let calls = 0;
  await assert.rejects(
    PI.reviseWithRetry(async () => { calls += 1; throw new Error("still broken"); }, "d1", 0, { instruction: "改" }),
    /still broken/,
  );
  assert.equal(calls, 2);
});

test("errorText surfaces the server's error copy from a JSON error body", () => {
  const PI = loadModule();
  const err = new Error("HTTP 502");
  err.text = JSON.stringify({ error: "修改失败，请稍后重试" });
  assert.equal(PI.errorText(err, "改写失败"), "修改失败，请稍后重试");
  assert.equal(PI.errorText(new Error("network"), "改写失败"), "改写失败");
  const notJson = new Error("x");
  notJson.text = "<html>bad gateway</html>";
  assert.equal(PI.errorText(notJson, "改写失败"), "改写失败");
});

test("renderItemCard disables all controls while the item is revising or confirming (防重复点)", () => {
  const PI = loadModule();
  for (const flag of ["revising", "confirming"]) {
    const html = PI.renderItemCard({ problem: "1+1", subject: "math", [flag]: true }, 0);
    const selects = html.match(/<select[^>]*disabled/g) || [];
    const buttons = html.match(/<button[^>]*disabled/g) || [];
    const inputs = html.match(/<input[^>]*disabled/g) || [];
    assert.equal(selects.length, 1, `${flag}: subject select disabled`);
    assert.equal(buttons.length, 2, `${flag}: AI 改 + 记录这条 both disabled`);
    assert.equal(inputs.length, 1, `${flag}: revise input disabled`);
  }
});
