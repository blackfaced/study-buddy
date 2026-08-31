// web/write/dictation-view.test.js
//
// DOM-level behavior tests for dictation mode (issue #196), with
// stub elements (same pattern as web/buddy/photo-only.test.js).
//
// Run: node --test web/write/dictation-view.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { createDictationSession } from "./dictation-mode.js";
import { renderDictation } from "./dictation-view.js";

const SET = {
  id: "set-1",
  words: ["苹果"],
  sentence: "我爱吃水果。",
  wordPlays: 2,
  sentencePlays: 3,
};

function stubEl() {
  return {
    style: {},
    textContent: "",
    innerHTML: "",
    disabled: false,
    children: [],
    appendChild(c) { this.children.push(c); },
  };
}

function stubDom() {
  return {
    progressHeader: stubEl(),
    status: stubEl(),
    reveal: stubEl(),
    hanziTarget: stubEl(),
    replayBtn: stubEl(),
    undoBtn: stubEl(),
    submitBtn: stubEl(),
    nextBtn: stubEl(),
    againBtn: stubEl(),
    retryBtn: stubEl(),
    prevBtn: stubEl(),
  };
}

function stubCreateNode() {
  return () => stubEl();
}

function allText(dom) {
  const walk = (el) =>
    (el.textContent || "") + el.children.map(walk).join("");
  return Object.values(dom).map(walk).join("\n");
}

test("REAL SCENARIO: before submit no DOM element contains the target text (AC1)", () => {
  const dom = stubDom();
  const s = createDictationSession({ set: SET });
  s.start();
  renderDictation({ dom, session: s, createNode: stubCreateNode() });
  assert.ok(!allText(dom).includes("苹果"), "word target must not be in the DOM");
  assert.ok(!allText(dom).includes("我爱吃水果"), "sentence target must not be in the DOM");
  assert.equal(dom.reveal.style.display, "none");
  assert.equal(dom.hanziTarget.style.display, "none"); // no reference char in dictation
  // But the kid still sees where they are.
  assert.match(dom.progressHeader.textContent, /第 1\/2 题/);
});

test("answering phase shows 重听/撤销/提交, hides practice-only buttons", () => {
  const dom = stubDom();
  const s = createDictationSession({ set: SET });
  s.start();
  renderDictation({ dom, session: s, createNode: stubCreateNode() });
  assert.notEqual(dom.replayBtn.style.display, "none");
  assert.notEqual(dom.submitBtn.style.display, "none");
  assert.equal(dom.againBtn.style.display, "none");  // 笔顺重放 is practice-only
  assert.equal(dom.retryBtn.style.display, "none");
  assert.equal(dom.nextBtn.style.display, "none");
});

test("AC3: after submit the reveal shows the target char by char, next appears", () => {
  const dom = stubDom();
  const createNode = stubCreateNode();
  const s = createDictationSession({ set: SET });
  s.start();
  s.submit([]);
  renderDictation({ dom, session: s, createNode });
  assert.notEqual(dom.reveal.style.display, "none");
  const chars = dom.reveal.children.map((c) => c.textContent);
  assert.deepEqual(chars, ["苹", "果"]); // 逐字
  assert.notEqual(dom.nextBtn.style.display, "none");
  assert.equal(dom.submitBtn.style.display, "none");
  assert.equal(dom.replayBtn.style.display, "none");
});

test("done phase: completion status, all controls hidden", () => {
  const dom = stubDom();
  const s = createDictationSession({ set: SET });
  s.start();
  s.submit([]);
  s.next();
  s.submit([]);
  s.next();
  assert.equal(s.phase, "done");
  renderDictation({ dom, session: s, createNode: stubCreateNode() });
  assert.match(dom.status.textContent, /完成/);
  assert.equal(dom.nextBtn.style.display, "none");
  assert.equal(dom.submitBtn.style.display, "none");
});
