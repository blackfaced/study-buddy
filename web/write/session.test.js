// web/write/session.test.js
//
// Tests for the write-session state machine extracted from client.js
// (PR 7 of the refactor series). The module encapsulates the
// "5 chars per session" + current-item-pointer logic. The rest
// of client.js (kid-input, startWord, etc.) reads from it via
// get currentItem() and calls next() to advance.
//
// Public API:
//   - createWriteSession({ initialLibrary })
//     .library       — live list of available chars
//     .session       — current 5-item session
//     .sessionIdx    — index of the current item
//     .currentItem   — shortcut for session[sessionIdx]
//     .isDone        — true when sessionIdx >= session.length
//     .start()       — populate session from library (5 items,
//                       wraps if library has < 5)
//     .next()        — advance sessionIdx
//     .retry()       — keep sessionIdx, clear current item strokes
import { test } from "node:test";
import assert from "node:assert/strict";
import { createWriteSession } from "./session.js";

const lib = (chars) => chars.map((c) => ({ char: c, attemptCount: 0 }));

// --- start() populates the session from the library -----------------

test("write-session: start() picks the first 5 chars from a 5+ library", () => {
  const s = createWriteSession({ initialLibrary: lib(["一", "二", "三", "四", "五", "六"]) });
  s.start();
  assert.equal(s.session.length, 5);
  assert.deepEqual(s.session.map((it) => it.char), ["一", "二", "三", "四", "五"]);
});

test("write-session: start() wraps the library if it has < 5 chars", () => {
  // Real-world: most kids only have 2-3 chars in the library at
  // first. We still want a 5-item session so the flow has
  // something to walk through. We wrap (round-robin).
  const s = createWriteSession({ initialLibrary: lib(["一", "二"]) });
  s.start();
  assert.equal(s.session.length, 5);
  assert.deepEqual(s.session.map((it) => it.char), ["一", "二", "一", "二", "一"]);
});

// --- currentItem / isDone / next() ---------------------------------

test("write-session: currentItem returns the item at sessionIdx", () => {
  const s = createWriteSession({ initialLibrary: lib(["一", "二", "三"]) });
  s.start();
  assert.equal(s.currentItem.char, "一");
  s.next();
  assert.equal(s.currentItem.char, "二");
  s.next();
  assert.equal(s.currentItem.char, "三");
});

test("write-session: isDone is true after walking past the last item", () => {
  // Use a 5-char library so session has exactly 5 items (no wrap).
  const s = createWriteSession({ initialLibrary: lib(["一", "二", "三", "四", "五"]) });
  s.start();
  assert.equal(s.isDone, false);
  s.next();
  assert.equal(s.isDone, false);
  s.next();
  s.next();
  s.next();
  assert.equal(s.isDone, false);
  s.next();
  assert.equal(s.isDone, true);
});

test("write-session: isDone becomes true after the wrap-around completes", () => {
  // Library has 2 items → session wraps to 5 items, all visited
  // via 5 next() calls.
  const s = createWriteSession({ initialLibrary: lib(["一", "二"]) });
  s.start();
  for (let i = 0; i < 5; i++) {
    assert.equal(s.isDone, false, `should not be done at step ${i}`);
    s.next();
  }
  assert.equal(s.isDone, true);
});

test("write-session: isDone is true when session is empty (never started)", () => {
  const s = createWriteSession({ initialLibrary: lib(["一"]) });
  assert.equal(s.isDone, true);
});

// --- retry() doesn't advance ---------------------------------------

test("write-session: retry() keeps the same item (no advancement)", () => {
  const s = createWriteSession({ initialLibrary: lib(["一", "二", "三"]) });
  s.start();
  const firstItem = s.currentItem;
  s.retry();
  assert.equal(s.currentItem, firstItem);
  assert.equal(s.sessionIdx, 0);
});

test("write-session: retry() clears the strokes on the current item", () => {
  const s = createWriteSession({ initialLibrary: lib(["一"]) });
  s.start();
  // Mutate the current item as the kid would: draw a stroke.
  s.currentItem.strokes.push({ d: "M 1 1 L 2 2" });
  s.retry();
  assert.deepEqual(s.currentItem.strokes, []);
});

// --- library can be replaced (e.g. after a POST /api/write/words) -

test("write-session: library setter replaces the available chars", () => {
  const s = createWriteSession({ initialLibrary: lib(["一"]) });
  s.library = lib(["天", "地", "人"]);
  s.start();
  assert.deepEqual(s.session.map((it) => it.char), ["天", "地", "人", "天", "地"]);
});

// --- next() past the end is a no-op (defensive) ------------------

test("write-session: next() past the end stays at isDone (no throw)", () => {
  // Library of 5 → session of 5 → 5 nexts gets to isDone.
  const s = createWriteSession({ initialLibrary: lib(["一", "二", "三", "四", "五"]) });
  s.start();
  for (let i = 0; i < 5; i++) s.next();
  // 6th next() is past the end; shouldn't throw.
  assert.doesNotThrow(() => s.next());
  assert.equal(s.isDone, true);
  assert.equal(s.sessionIdx, 5);
});

// --- prev() / canGoPrev (issue #85: 上一字 button) --------------

test("write-session: prev() at sessionIdx 0 is a no-op (stays at 0)", () => {
  const s = createWriteSession({ initialLibrary: lib(["一", "二", "三"]) });
  s.start();
  assert.equal(s.sessionIdx, 0);
  assert.equal(s.canGoPrev, false);
  assert.doesNotThrow(() => s.prev());
  assert.equal(s.sessionIdx, 0);
});

test("write-session: prev() decrements sessionIdx, canGoPrev tracks position", () => {
  const s = createWriteSession({ initialLibrary: lib(["一", "二", "三"]) });
  s.start();
  s.next(); s.next();  // now at idx 2, char "三"
  assert.equal(s.currentItem.char, "三");
  assert.equal(s.canGoPrev, true);
  s.prev();
  assert.equal(s.sessionIdx, 1);
  assert.equal(s.currentItem.char, "二");
  assert.equal(s.canGoPrev, true);
  s.prev();
  assert.equal(s.sessionIdx, 0);
  assert.equal(s.currentItem.char, "一");
  assert.equal(s.canGoPrev, false);
});

test("write-session: prev() does NOT clear strokes (kid can review)", () => {
  // The whole point of #85: kid can re-view what they wrote.
  const s = createWriteSession({ initialLibrary: lib(["一", "二"]) });
  s.start();
  // Draw 2 strokes on char 一 (idx 0)
  s.currentItem.strokes.push({ d: "M 1 1" }, { d: "M 2 2" });
  s.next();
  // Now at 二. Go back to 一.
  s.prev();
  assert.equal(s.currentItem.char, "一");
  assert.equal(s.currentItem.strokes.length, 2);  // preserved
});

test("write-session: prev() past the start stays at 0 (no throw)", () => {
  const s = createWriteSession({ initialLibrary: lib(["一", "二"]) });
  s.start();
  s.next();
  s.prev();
  s.prev();
  s.prev();  // past start, no throw
  assert.equal(s.sessionIdx, 0);
});
