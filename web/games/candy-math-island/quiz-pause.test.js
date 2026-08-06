// web/games/candy-math-island/quiz-pause.test.js
//
// TDD for the candy quiz pause feature (issue #83). The renderer's
// tick handler should skip decrementing remainingMs when paused.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

async function load() {
  const url = pathToFileURL(path.resolve(__dirname, "quiz-pause.js")).href;
  return await import(url);
}

test("shouldTick: false when state.paused is true", async () => {
  const { shouldTick } = await load();
  assert.equal(shouldTick({ paused: true }), false);
});

test("shouldTick: true when state.paused is false", async () => {
  const { shouldTick } = await load();
  assert.equal(shouldTick({ paused: false }), true);
  assert.equal(shouldTick({ paused: undefined }), true);  // default = not paused
});

test("togglePause: false → true (does not mutate input)", async () => {
  const { togglePause } = await load();
  const before = { paused: false };
  const after = togglePause(before);
  assert.equal(after.paused, true);
  assert.equal(before.paused, false, "input must not be mutated");
});

test("togglePause: true → false (does not mutate input)", async () => {
  const { togglePause } = await load();
  const before = { paused: true };
  const after = togglePause(before);
  assert.equal(after.paused, false);
  assert.equal(before.paused, true);
});

test("pauseButtonText: '继续' when paused, '暂停' otherwise", async () => {
  const { pauseButtonText } = await load();
  assert.equal(pauseButtonText({ paused: true }), "继续");
  assert.equal(pauseButtonText({ paused: false }), "暂停");
  assert.equal(pauseButtonText({}), "暂停");  // default
});

test("isInputDisabled: true only when paused", async () => {
  const { isInputDisabled } = await load();
  assert.equal(isInputDisabled({ paused: true }), true);
  assert.equal(isInputDisabled({ paused: false }), false);
  assert.equal(isInputDisabled({}), false);
});
