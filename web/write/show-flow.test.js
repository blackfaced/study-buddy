// web/write/show-flow.test.js
//
// Unit tests for the practice-view state-machine flow in the write
// app. v0.8.2 (issue #68): the v0.8.1 inline timing had a setTimeout(100)
// that triggered "showing" 100ms after `writer.animateCharacter()` was
// called — regardless of whether the animation had finished. On the
// iPad the user saw "the character isn't fully shown before it
// disappears" because the animation (≈2.5s) was still drawing when
// the state machine started the 3s show window, and the character
// appeared to flicker.
//
// These tests pin the contract: phase transitions are driven by the
// `animDone` promise, not by an arbitrary 100ms delay.
//
// Cases below (all user-actual scenarios):
//   1. showing fires AFTER animDone resolves, not after 100ms
//   2. show-window length is showMs, measured from showing→writing
//   3. animation duration doesn't shorten the show window
//   4. cancel prevents the writing phase from firing
//   5. writer.hideCharacter() is called when writing starts
//
// We don't touch the DOM or canvas here — `runShowFlow` is a pure
// function that takes callbacks. This is why we can unit-test it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { runShowFlow } from "./show-flow.js";

/** Build a controllable animDone promise + a fake writer. */
function makeFixtures() {
  let resolveAnim;
  const animDone = new Promise((r) => {
    resolveAnim = r;
  });
  const writer = { hideCharacterCalls: 0 };
  writer.hideCharacter = function () {
    writer.hideCharacterCalls += 1;
  };
  return { animDone, resolveAnim, writer };
}

/** Track all phase + opacity callbacks in a single array. */
function makeTrackers() {
  const calls = [];
  return {
    calls,
    onPhase: (p) => calls.push({ kind: "phase", p, at: Date.now() }),
    onOpacity: (o) => calls.push({ kind: "opacity", o, at: Date.now() }),
  };
}

/** Wait for `ms` milliseconds. */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- Test 1: showing fires AFTER animDone, not after 100ms ----------
//
// Regression pin for issue #68: v0.8.1 client.js had a setTimeout(100)
// that triggered "showing" 100ms after startWord was called, regardless
// of animation progress. On the iPad the user saw the character flicker
// (the show window started while animateCharacter was still drawing).
// The fix is to wait for `animDone` to resolve.

test("runShowFlow: 'showing' phase fires only after animDone resolves (regression pin for #68)", async () => {
  const { animDone, resolveAnim, writer } = makeFixtures();
  const { calls, onPhase, onOpacity } = makeTrackers();

  const cancel = runShowFlow({
    writer,
    animDone,
    level: 1.0,
    showMs: 500,
    onPhase,
    onOpacity,
  });

  // Bug check: 50ms in, the only phase fired is "animating".
  await sleep(50);
  const phasesAt50 = calls.filter((c) => c.kind === "phase").map((c) => c.p);
  assert.deepEqual(
    phasesAt50,
    ["animating"],
    "at 50ms only 'animating' should be in the log (the v0.8.1 bug would have 'showing' here)"
  );

  // Animation completes at 200ms.
  await sleep(150);
  resolveAnim();
  await sleep(10);
  const phasesAfter = calls.filter((c) => c.kind === "phase").map((c) => c.p);
  assert.ok(phasesAfter.includes("showing"), "'showing' should fire after animDone");
  assert.ok(
    !phasesAfter.includes("writing"),
    "'writing' should NOT have fired yet (show window 500ms not elapsed)"
  );

  cancel();
  await sleep(600);
});

// --- Test 2: show window length is showMs, independent of anim duration ----

test("runShowFlow: show window is showMs regardless of anim duration", async () => {
  // User scenario: 笔顺动画 2.5s + 倒计时 3s. Total = 5.5s. The
  // show window must be 3s MEASURED FROM showing, not 3s from
  // animation start. If we accidentally measure from t=0, the kid
  // gets less than 3s of seeing the static character.
  const { animDone, resolveAnim, writer } = makeFixtures();
  const { calls, onPhase, onOpacity } = makeTrackers();

  const SHOW_MS = 100;
  const cancel = runShowFlow({
    writer,
    animDone,
    level: 1.0,
    showMs: SHOW_MS,
    onPhase,
    onOpacity,
  });

  // Wait for animation to "complete" after a long delay (simulates
  // 2.5s animation).
  await sleep(80);
  resolveAnim();
  await sleep(10);

  const showingIdx = calls.findIndex((c) => c.kind === "phase" && c.p === "showing");
  const showingAt = calls[showingIdx].at;
  assert.ok(showingIdx >= 0, "'showing' phase should be in the log");

  // Now wait a bit less than SHOW_MS — writing should NOT have fired.
  await sleep(SHOW_MS - 30);
  const phases = calls.filter((c) => c.kind === "phase").map((c) => c.p);
  assert.ok(!phases.includes("writing"), `'writing' should not fire before showMs (got ${phases})`);

  // Wait the rest. Writing should now have fired.
  await sleep(60);
  const phases2 = calls.filter((c) => c.kind === "phase").map((c) => c.p);
  assert.ok(phases2.includes("writing"), `'writing' should fire ~showMs after 'showing' (got ${phases2})`);

  // writer.hideCharacter was called exactly once, at the writing transition.
  assert.equal(writer.hideCharacterCalls, 1);

  cancel();
});

// --- Test 3: cancel stops the writing transition ----

test("runShowFlow: cancel() before showMs elapses prevents 'writing' from firing", async () => {
  // User scenario: 倒计时进行中, kid 点了「重练」. 旧 client.js 用
  // clearPendingTimers 显式清掉 setTimeout, 但 v0.8.1 的 setTimeout(100)
  // 已经在 pendingTimers 里 — 取消它能 work. 新的 runShowFlow 应该
  // 用 cancel() API 直接清掉两个 timer (anim 完成后那个, showing
  // 完成后那个).
  const { animDone, resolveAnim, writer } = makeFixtures();
  const { calls, onPhase, onOpacity } = makeTrackers();

  const cancel = runShowFlow({
    writer,
    animDone,
    level: 1.0,
    showMs: 100,
    onPhase,
    onOpacity,
  });

  await sleep(50);
  resolveAnim();
  await sleep(10);
  // Now we're in 'showing' phase, with a pending setTimeout for 'writing'.
  cancel();

  await sleep(200);
  const phases = calls.filter((c) => c.kind === "phase").map((c) => c.p);
  assert.deepEqual(phases, ["animating", "showing"], "cancel should prevent 'writing'");
  assert.equal(writer.hideCharacterCalls, 0, "cancel should prevent hideCharacter");
});

// --- Test 4: writer.hideCharacter is called when writing starts ----

test("runShowFlow: writer.hideCharacter() fires once, on the showing→writing transition", async () => {
  const { animDone, resolveAnim, writer } = makeFixtures();
  const { calls, onPhase, onOpacity } = makeTrackers();

  const cancel = runShowFlow({
    writer,
    animDone,
    level: 1.0,
    showMs: 30,
    onPhase,
    onOpacity,
  });

  await sleep(10);
  resolveAnim();
  await sleep(60);  // generous wait — showMs is 30ms

  assert.equal(writer.hideCharacterCalls, 1, "hideCharacter should be called exactly once");

  cancel();
});

// --- Test 5: opacity callback fires with the requested level ----

test("runShowFlow: onOpacity(level) is called when the animation finishes", async () => {
  const { animDone, resolveAnim, writer } = makeFixtures();
  const { calls, onPhase, onOpacity } = makeTrackers();

  const cancel = runShowFlow({
    writer,
    animDone,
    level: 0.7,
    showMs: 50,
    onPhase,
    onOpacity,
  });

  await sleep(20);
  resolveAnim();
  await sleep(10);

  const opacities = calls.filter((c) => c.kind === "opacity").map((c) => c.o);
  assert.deepEqual(opacities, [0.7], `onOpacity(0.7) should be called once (got ${opacities})`);

  cancel();
});
