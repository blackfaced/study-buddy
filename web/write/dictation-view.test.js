// web/write/dictation-view.test.js
//
// DOM-level behavior tests for dictation mode (issue #196 + #197
// outcome confirmation), with stub elements (same pattern as
// web/buddy/photo-only.test.js).
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
  const classes = new Set();
  return {
    style: {},
    textContent: "",
    innerHTML: "",
    disabled: false,
    children: [],
    appendChild(c) { this.children.push(c); },
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c),
    },
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
    outcomeRow: stubEl(),
    outcomeCorrect: stubEl(),
    outcomeWrong: stubEl(),
    outcomePinyin: stubEl(),
    outcomePoor: stubEl(),
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

test("answering phase shows 重听/撤销/提交, hides practice-only buttons and the outcome row", () => {
  const dom = stubDom();
  const s = createDictationSession({ set: SET });
  s.start();
  renderDictation({ dom, session: s, createNode: stubCreateNode() });
  assert.notEqual(dom.replayBtn.style.display, "none");
  assert.notEqual(dom.submitBtn.style.display, "none");
  assert.equal(dom.againBtn.style.display, "none");  // 笔顺重放 is practice-only
  assert.equal(dom.retryBtn.style.display, "none");
  assert.equal(dom.nextBtn.style.display, "none");
  assert.equal(dom.outcomeRow.style.display, "none");
});

test("AC3: after submit the reveal shows the target char by char", () => {
  const dom = stubDom();
  const createNode = stubCreateNode();
  const s = createDictationSession({ set: SET });
  s.start();
  s.submit([]);
  renderDictation({ dom, session: s, createNode });
  assert.notEqual(dom.reveal.style.display, "none");
  const chars = dom.reveal.children.map((c) => c.textContent);
  assert.deepEqual(chars, ["苹", "果"]); // 逐字
  assert.equal(dom.submitBtn.style.display, "none");
  assert.equal(dom.replayBtn.style.display, "none");
});

test("#197: revealed phase shows outcome buttons; 下一题 stays disabled until language confirmed", () => {
  const dom = stubDom();
  const createNode = stubCreateNode();
  const s = createDictationSession({ set: SET });
  s.start();
  s.submit([]);
  renderDictation({ dom, session: s, createNode });
  assert.notEqual(dom.outcomeRow.style.display, "none");
  assert.notEqual(dom.nextBtn.style.display, "none");
  assert.equal(dom.nextBtn.disabled, true); // 未确认不能翻页

  s.setOutcome({ language: "wrong", handwriting: "poor" });
  renderDictation({ dom, session: s, createNode });
  assert.equal(dom.nextBtn.disabled, false);
  assert.ok(dom.outcomeWrong.classList.contains("selected"));
  assert.ok(dom.outcomePoor.classList.contains("selected"));
  assert.ok(!dom.outcomeCorrect.classList.contains("selected"));
});

test("#197 done phase: 提交结果 appears only when every item is confirmed", () => {
  const dom = stubDom();
  const s = createDictationSession({ set: SET });
  s.start();
  s.submit([]); // no outcome → not confirmed
  s.next();
  s.submit([]);
  s.setOutcome({ language: "correct" });
  s.next();
  assert.equal(s.phase, "done");
  renderDictation({ dom, session: s, createNode: stubCreateNode() });
  assert.equal(dom.submitBtn.style.display, "none"); // 还有 1 项没确认
  assert.equal(dom.nextBtn.style.display, "none");
});

test("#197 done phase: all confirmed → 提交结果 visible, status asks to submit", () => {
  const dom = stubDom();
  const s = createDictationSession({ set: SET });
  s.start();
  s.submit([]);
  s.setOutcome({ language: "wrong" });
  s.next();
  s.submit([]);
  s.setOutcome({ language: "correct" });
  s.next();
  renderDictation({ dom, session: s, createNode: stubCreateNode() });
  assert.notEqual(dom.submitBtn.style.display, "none");
  assert.match(dom.submitBtn.textContent, /提交结果/);
  assert.match(dom.status.textContent, /提交/);
});
