// web/games/candy-math-island/home-stats.test.js
//
// TDD cases for renderHomeStrip. Covers the two states, null/undefined
// inputs, and zero-question edge cases (server returns 0/0 for an
// unplayed day, which we should still treat as first-time).

const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

// ESM-only module; load via dynamic import from a CJS test file.
async function load() {
  const url = require("node:url").pathToFileURL(path.resolve(__dirname, "home-stats.js")).href;
  return await import(url);
}

test("null input → first-time warm message", async () => {
  const { renderHomeStrip } = await load();
  const r = renderHomeStrip(null);
  assert.equal(r.className, "first-time");
  assert.match(r.html, /今天还没玩过/);
  assert.match(r.html, /来挑战 60 秒/);
});

test("undefined input → first-time warm message", async () => {
  const { renderHomeStrip } = await load();
  const r = renderHomeStrip(undefined);
  assert.equal(r.className, "first-time");
});

test("today with 0 questions → first-time (kid hasn't started)", async () => {
  const { renderHomeStrip } = await load();
  const r = renderHomeStrip({ totalQuestions: 0, correctRate: 0, sessionCount: 0 });
  assert.equal(r.className, "first-time");
});

test("today with 7 questions 78% 1 session → stats with 3 fields", async () => {
  const { renderHomeStrip } = await load();
  const r = renderHomeStrip({ totalQuestions: 7, correctRate: 78, sessionCount: 1 });
  assert.equal(r.className, "stats");
  assert.match(r.html, /今日 <b>7<\/b> 题/);
  assert.match(r.html, /正确率 <b>78%<\/b>/);
  assert.match(r.html, /连玩 <b>1<\/b> 次/);
});

test("multi-session stats: 2 sessions", async () => {
  const { renderHomeStrip } = await load();
  const r = renderHomeStrip({ totalQuestions: 15, correctRate: 92, sessionCount: 2 });
  assert.equal(r.className, "stats");
  assert.match(r.html, /连玩 <b>2<\/b> 次/);
});

test("HTML escaping: stats with weird numbers (correctRate=100, totalQuestions=20)", async () => {
  const { renderHomeStrip } = await load();
  const r = renderHomeStrip({ totalQuestions: 20, correctRate: 100, sessionCount: 1 });
  assert.equal(r.className, "stats");
  assert.match(r.html, /<b>20<\/b>/);
  assert.match(r.html, /<b>100%<\/b>/);
});

test("first-time text does NOT include '今日 0' (the failing report card)", async () => {
  const { renderHomeStrip } = await load();
  const r = renderHomeStrip(null);
  assert.doesNotMatch(r.html, /今日/);
  assert.doesNotMatch(r.html, /<b>0<\/b>/);
});

