// web/write/dictation-mode.test.js
//
// Behavior tests for the dictation-mode session state machine
// (issue #196 — 写字 app 默写模式). Pure logic, no DOM.
//
// Run: node --test web/write/dictation-mode.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createDictationSession,
  restoreDictationSession,
} from "./dictation-mode.js";

const SET = {
  id: "set-1",
  childId: "default",
  words: ["苹果", "香蕉"],
  sentence: "我爱吃水果。",
  wordPlays: 2,
  sentencePlays: 3,
  status: "active",
};

test("set becomes ordered items: words first (set play counts), sentence last", () => {
  const s = createDictationSession({ set: SET });
  s.start();
  assert.equal(s.items.length, 3);
  assert.deepEqual(
    s.items.map((it) => [it.kind, it.plannedPlays]),
    [["word", 2], ["word", 2], ["sentence", 3]],
  );
  assert.equal(s.phase, "answering");
  assert.equal(s.itemIndex, 0);
});

test("per-set play-count override is respected", () => {
  const s = createDictationSession({ set: { ...SET, wordPlays: 4, sentencePlays: 1 } });
  s.start();
  assert.equal(s.items[0].plannedPlays, 4);
  assert.equal(s.items[2].plannedPlays, 1);
});

test("AC1: target text is not visible before submit (audio only via speakText)", () => {
  const s = createDictationSession({ set: SET });
  s.start();
  assert.equal(s.targetVisible(), false);
  assert.equal(s.visibleText(), null);
  // TTS is the audio channel — allowed before submit.
  assert.equal(s.speakText(), "苹果");
  s.submit([]);
  assert.equal(s.targetVisible(), true);
  assert.equal(s.visibleText(), "苹果");
});

test("AC2: replaying 3 times then submitting is not an error; replays ride along", () => {
  const s = createDictationSession({ set: SET });
  s.start();
  s.replay();
  s.replay();
  s.replay();
  const submission = s.submit(["M 1 1 L 2 2"]);
  assert.equal(s.phase, "revealed");
  assert.equal(submission.replays, 3);
  assert.deepEqual(submission.strokes, ["M 1 1 L 2 2"]);
  // No error flag anywhere: replays are a count, never a failure.
  assert.equal(submission.isError, undefined);
  assert.equal(s.current().replays, 3);
});

test("AC4: paper-and-pencil scenario — submit with zero strokes is allowed", () => {
  const s = createDictationSession({ set: SET });
  s.start();
  const submission = s.submit([]);
  assert.equal(s.phase, "revealed");
  assert.deepEqual(submission.strokes, []);
});

test("replay is only counted while answering, not after reveal", () => {
  const s = createDictationSession({ set: SET });
  s.start();
  s.replay();
  s.submit([]);
  assert.equal(s.replay(), false); // revealed: no more replays
  assert.equal(s.current().replays, 1);
});

test("next walks all items then done; everything visible at done", () => {
  const s = createDictationSession({ set: SET });
  s.start();
  for (let i = 0; i < 3; i += 1) {
    assert.equal(s.phase, "answering");
    s.submit([]);
    assert.equal(s.phase, "revealed");
    s.next();
  }
  assert.equal(s.phase, "done");
  assert.equal(s.targetVisible(), true);
});

test("strokes accumulate and undo drops the last one", () => {
  const s = createDictationSession({ set: SET });
  s.start();
  s.noteStroke("M 0 0 L 1 1");
  s.noteStroke("M 2 2 L 3 3");
  assert.deepEqual(s.current().strokes, ["M 0 0 L 1 1", "M 2 2 L 3 3"]);
  s.undoStroke();
  assert.deepEqual(s.current().strokes, ["M 0 0 L 1 1"]);
});

test("AC5: snapshot/restore round-trips mid-session state (leave and come back)", () => {
  const s = createDictationSession({ set: SET });
  s.start();
  s.noteStroke("M 5 5 L 6 6");
  s.replay();
  s.submit(["M 5 5 L 6 6"]);
  s.next(); // second word, answering
  s.noteStroke("M 7 7 L 8 8");

  const snap = s.snapshot();
  const restored = restoreDictationSession(SET, snap);
  assert.equal(restored.phase, "answering");
  assert.equal(restored.itemIndex, 1);
  assert.deepEqual(restored.current().strokes, ["M 7 7 L 8 8"]);
  // The first item keeps its replay count + revealed state.
  assert.equal(restored.items[0].replays, 1);
  assert.equal(restored.items[0].revealed, true);
  assert.equal(restored.targetVisible(), false); // current item still hidden
});

test("restore rejects a snapshot for a different set", () => {
  const s = createDictationSession({ set: SET });
  s.start();
  const snap = s.snapshot();
  assert.equal(restoreDictationSession({ ...SET, id: "set-2" }, snap), null);
});
