// web/write/progress-header.test.js
//
// TDD for issue #81: persistent "第 N/M 字 · X" header that stays
// across all phases. Pure renderer — no DOM, no fetch.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

async function load() {
  const url = pathToFileURL(path.resolve(__dirname, "progress-header.js")).href;
  return await import(url);
}

test("renders '第 1/3 字 · 一' for first char", async () => {
  const { renderProgressHeader } = await load();
  const r = renderProgressHeader({ sessionIdx: 0, total: 3, char: "一" });
  assert.equal(r.text, "第 1 / 3 字 · 一");
  assert.equal(r.className, "progress-header");
});

test("renders '第 2/3 字 · 二' for middle char", async () => {
  const { renderProgressHeader } = await load();
  const r = renderProgressHeader({ sessionIdx: 1, total: 3, char: "二" });
  assert.equal(r.text, "第 2 / 3 字 · 二");
});

test("renders '第 5/5 字 · 五' for last char", async () => {
  const { renderProgressHeader } = await load();
  const r = renderProgressHeader({ sessionIdx: 4, total: 5, char: "五" });
  assert.equal(r.text, "第 5 / 5 字 · 五");
});

test("empty total returns empty text (defensive — should not happen in practice)", async () => {
  const { renderProgressHeader } = await load();
  const r = renderProgressHeader({ sessionIdx: 0, total: 0, char: "一" });
  assert.equal(r.text, "");
  assert.equal(r.className, "progress-header empty");
});

test("sessionIdx past end is clamped to last char (defensive)", async () => {
  const { renderProgressHeader } = await load();
  // sessionIdx 5 but total 3 — should render 3/3.
  const r = renderProgressHeader({ sessionIdx: 5, total: 3, char: "三" });
  assert.equal(r.text, "第 3 / 3 字 · 三");
});

test("negative sessionIdx clamped to 0 (defensive)", async () => {
  const { renderProgressHeader } = await load();
  const r = renderProgressHeader({ sessionIdx: -1, total: 3, char: "一" });
  assert.equal(r.text, "第 1 / 3 字 · 一");
});
