// bin/friday-weekend-reminder.test.js
//
// Behavior tests for the Friday 20:00 weekend-review reminder
// (issue #195, part of #192). The script reads the bounded parent
// summary, formats an aggregate-only text, and pushes it to the
// Feishu webhook. It only asks — never writes learning state.
//
// Run: node --test bin/friday-weekend-reminder.test.js

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  formatWeekendReminder,
  run,
  ENDING_QUESTION,
} = require("./friday-weekend-reminder.js");

const SUMMARY = {
  childId: "default",
  generatedAt: 1788000000000,
  stats: {
    newMistakes: 5,
    pendingReview: 3,
    alreadyCorrected: 7,
    pendingReplay: 2,
    reopened: 1,
    evidenceGaps: 0,
  },
  recurringErrorObservations: [
    { errorType: "进位加法", count: 3, recentCaseIds: ["mistake:12", "mistake:9"] },
    { errorType: "拼写错误", count: 2, recentCaseIds: ["mistake:4"] },
  ],
};

function stubLogger() {
  const lines = [];
  return {
    lines,
    info: (msg) => lines.push(`info: ${msg}`),
    error: (msg) => lines.push(`error: ${msg}`),
  };
}

test("real scenario: Friday message shows 未订正数 and 待复习数, ends with the one question", () => {
  const text = formatWeekendReminder(SUMMARY);
  assert.match(text, /未订正：3/);
  assert.match(text, /待周末复习：2/);
  assert.match(text, /进位加法 ×3/);
  assert.ok(text.endsWith(ENDING_QUESTION));
});

test("aggregate only: no raw problem text, no case ids, no child identity (AC2)", () => {
  const text = formatWeekendReminder(SUMMARY);
  assert.ok(!text.includes("mistake:12"), "case ids must not leak");
  assert.ok(!text.includes("mistake:9"));
  assert.ok(!text.includes("mistake:4"));
  assert.ok(!text.includes("default"), "childId must not leak");
  assert.ok(!/3\+3/.test(text), "no problem text");
});

test("no recurring observations → no 高频错因 section, question still asked", () => {
  const text = formatWeekendReminder({
    ...SUMMARY,
    recurringErrorObservations: [],
  });
  assert.ok(!text.includes("高频错因"));
  assert.ok(text.endsWith(ENDING_QUESTION));
});

test("webhook URL unset → quiet skip: exit 0, nothing sent, skip logged (AC4)", async () => {
  const logger = stubLogger();
  let sent = 0;
  const code = await run({
    env: {},
    logger,
    send: async () => { sent += 1; return true; },
    fetchJson: async () => SUMMARY,
  });
  assert.equal(code, 0);
  assert.equal(sent, 0);
  assert.ok(logger.lines.some((l) => /skip|未配置/.test(l)), "skip must be logged");
});

test("happy path: summary is fetched and the formatted text is pushed to the webhook", async () => {
  const logger = stubLogger();
  const sentTexts = [];
  const code = await run({
    env: { FEISHU_WEBHOOK_URL: "https://open.feishu.cn/bot/x" },
    logger,
    fetchJson: async (url) => {
      assert.match(url, /\/api\/capture\/parent-summary\?childId=default/);
      return SUMMARY;
    },
    send: async ({ text }) => { sentTexts.push(text); return true; },
  });
  assert.equal(code, 0);
  assert.equal(sentTexts.length, 1);
  assert.ok(sentTexts[0].endsWith(ENDING_QUESTION));
  assert.match(sentTexts[0], /未订正：3/);
});

test("summary fetch failure → exit 1, error logged, nothing sent", async () => {
  const logger = stubLogger();
  let sent = 0;
  const code = await run({
    env: { FEISHU_WEBHOOK_URL: "https://open.feishu.cn/bot/x" },
    logger,
    fetchJson: async () => { throw new Error("connection refused"); },
    send: async () => { sent += 1; return true; },
  });
  assert.equal(code, 1);
  assert.equal(sent, 0);
  assert.ok(logger.lines.some((l) => l.startsWith("error:")));
});
