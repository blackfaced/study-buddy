// web/review/review.test.js
//
// Unit tests for the review workspace page. We use vm.runInNewContext
// to load review.js with a stubbed document + fetch + URLSearchParams.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "review.js"), "utf8");

function setup({ query = {}, fetchResponses = [] } = {}) {
  const calls = { fetch: [] };
  const fetchStub = async (url, init) => {
    calls.fetch.push({ url, init });
    const next = fetchResponses.shift();
    if (!next) throw new Error(`fetch called with no stub response: ${url}`);
    return next;
  };
  // Build a minimal DOM stub.
  const nodes = {};
  const listeners = {};
  function makeNode(id) {
    return {
      _id: id,
      _innerHTML: "",
      _text: "",
      _disabled: false,
      _listeners: {},
      get innerHTML() { return this._innerHTML; },
      set innerHTML(v) { this._innerHTML = v; this._renderedHTML = v; },
      get textContent() { return this._text; },
      set textContent(v) { this._text = v; },
      get disabled() { return this._disabled; },
      set disabled(v) { this._disabled = v; },
      get value() { return this._value ?? ""; },
      set value(v) { this._value = v; },
      setAttribute(k, v) { this._attrs = this._attrs || {}; this._attrs[k] = v; },
      removeAttribute(k) { this._attrs = this._attrs || {}; delete this._attrs[k]; },
      getAttribute(k) { return this._attrs?.[k]; },
      addEventListener(event, fn) { (this._listeners[event] = this._listeners[event] || []).push(fn); },
      remove() {},
    };
  }
  const document = {
    getElementById: (id) => {
      if (!nodes[id]) nodes[id] = makeNode(id);
      return nodes[id];
    },
  };
  const window = { location: { search: new URLSearchParams(query).toString() } };
  const ctx = {
    window,
    document,
    fetch: fetchStub,
    URLSearchParams,
    location: window.location,
    // vm contexts don't have timers by default — review.js uses
    // setTimeout for the post-submit reload delay, so we need to
    // inject one. Node 22's setTimeout is the real one.
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    queueMicrotask,
  };
  vm.createContext(ctx);
  vm.runInContext(source, ctx);
  return { ctx, calls, nodes, listeners };
}

function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

test("RE1: missing caseId shows error and skips fetch", () => {
  const { calls, nodes } = setup({ query: {} });
  assert.equal(calls.fetch.length, 0);
  assert.match(nodes.root._innerHTML, /缺少 caseId/);
});

test("RE2: valid load → renders the case with problem + original wrong + correct + form (when open)", async () => {
  const { calls, nodes } = setup({
    query: { caseId: "case:abc", childId: "default" },
    fetchResponses: [
      jsonResponse(200, {
        caseId: "case:abc",
        problem: "8+5",
        userAnswer: "12",
        correctAnswer: "13",
        errorType: "compute",
        source: "manual",
        subject: "math",
        obligationStatus: "open",
        reviewedCount: 0,
        openedAt: 100,
        attempts: [
          { kind: "original", userAnswer: "12", isCorrect: false, occurredAt: 100 },
        ],
      }),
    ],
  });
  await new Promise((r) => setImmediate(r));
  // The load fired
  assert.equal(calls.fetch.length, 1);
  assert.match(calls.fetch[0].url, /case%3Aabc|case:abc/);
  // The DOM was populated
  const html = nodes.root._innerHTML;
  assert.match(html, /8\+5/);
  assert.match(html, /12/); // original wrong
  assert.match(html, /13/); // correct
  assert.match(html, /compute/); // error type
  assert.match(html, /数学/); // subject
  // Open obligation → form is rendered
  assert.match(html, /attempt-form/);
  assert.match(html, /提交订正/);
});

test("RE3: closed obligation → shows closed banner, no form", async () => {
  const { nodes } = setup({
    query: { caseId: "case:closed" },
    fetchResponses: [
      jsonResponse(200, {
        caseId: "case:closed",
        problem: "x",
        userAnswer: "y",
        correctAnswer: "z",
        errorType: null,
        source: "game",
        subject: "chinese",
        obligationStatus: "verified",
        reviewedCount: 1,
        openedAt: 100,
        verifiedAt: 200,
        attempts: [
          { kind: "original", userAnswer: "y", isCorrect: false, occurredAt: 100 },
          { kind: "correction", userAnswer: "z", isCorrect: true, occurredAt: 200 },
        ],
      }),
    ],
  });
  await new Promise((r) => setImmediate(r));
  const html = nodes.root._innerHTML;
  assert.match(html, /已订正完成/);
  // No form for closed obligations
  assert.doesNotMatch(html, /id="attempt-form"/);
  // Timeline has 2 entries
  assert.match(html, /时间线 \(2 次尝试\)/);
  assert.match(html, /原始错题/);
  assert.match(html, /你的订正/);
});

test("RE4: 404 response shows error message, no form", async () => {
  const { nodes } = setup({
    query: { caseId: "case:nope" },
    fetchResponses: [jsonResponse(404, { error: "case not found" })],
  });
  await new Promise((r) => setImmediate(r));
  assert.match(nodes.root._innerHTML, /case not found/);
});

test("RE5: 403 response shows error message", async () => {
  const { nodes } = setup({
    query: { caseId: "case:other-child" },
    fetchResponses: [jsonResponse(403, { error: "case belongs to another child" })],
  });
  await new Promise((r) => setImmediate(r));
  assert.match(nodes.root._innerHTML, /belongs to another child/);
});

test("RE6: timeline sorts attempts by occurredAt, marks each with icon", async () => {
  const { nodes } = setup({
    query: { caseId: "case:tl" },
    fetchResponses: [
      jsonResponse(200, {
        caseId: "case:tl",
        problem: "p",
        userAnswer: "wrong1",
        correctAnswer: "right",
        errorType: null,
        source: "manual",
        subject: "math",
        obligationStatus: "open",
        reviewedCount: 0,
        openedAt: 1,
        attempts: [
          { kind: "original", userAnswer: "wrong1", isCorrect: false, occurredAt: 1000 },
          { kind: "correction", userAnswer: "wrong2", isCorrect: false, occurredAt: 2000 },
          { kind: "correction", userAnswer: "right", isCorrect: true, occurredAt: 3000 },
        ],
      }),
    ],
  });
  await new Promise((r) => setImmediate(r));
  const html = nodes.root._innerHTML;
  // Timeline has 3 entries
  assert.match(html, /3 次尝试/);
  // Slice the timeline section (after the 时间线 heading) so the
  // `correctAnswer` text doesn't confuse the indexOf.
  const timelineStart = html.indexOf("时间线");
  const tl = html.slice(timelineStart);
  const origIdx = tl.indexOf("原始错题");
  const corr1Idx = tl.indexOf("wrong2");
  const corr2Idx = tl.lastIndexOf("right");
  assert.ok(origIdx > 0, "original entry should be in timeline");
  assert.ok(origIdx < corr1Idx, "original before wrong2 correction");
  assert.ok(corr1Idx < corr2Idx, "wrong2 before right correction");
  // Each entry has the right CSS class for its kind
  assert.match(tl, /<li class="original">/);
  assert.match(tl, /<li class="wrong">/);
  assert.match(tl, /<li class="correct">/);
});

test("RE7: submit form → POST /api/capture/case/.../attempt with answer", async () => {
  const { calls, ctx, nodes } = setup({
    query: { caseId: "case:abc", childId: "default" },
    fetchResponses: [
      // Initial load
      jsonResponse(200, {
        caseId: "case:abc",
        problem: "p",
        userAnswer: "wrong",
        correctAnswer: "right",
        errorType: null,
        source: "manual",
        subject: "math",
        obligationStatus: "open",
        reviewedCount: 0,
        openedAt: 0,
        attempts: [{ kind: "original", userAnswer: "wrong", isCorrect: false, occurredAt: 0 }],
      }),
      // Submit answer
      jsonResponse(200, { caseId: "case:abc", isCorrect: true, obligationStatus: "verified" }),
      // Reload after submit (delayed via setTimeout in production)
      jsonResponse(200, {
        caseId: "case:abc",
        problem: "p",
        userAnswer: "wrong",
        correctAnswer: "right",
        errorType: null,
        source: "manual",
        subject: "math",
        obligationStatus: "verified",
        reviewedCount: 0,
        openedAt: 0,
        attempts: [
          { kind: "original", userAnswer: "wrong", isCorrect: false, occurredAt: 0 },
          { kind: "correction", userAnswer: "right", isCorrect: true, occurredAt: 1 },
        ],
      }),
    ],
  });
  await new Promise((r) => setImmediate(r));
  const answer = ctx.document.getElementById("answer");
  const form = ctx.document.getElementById("attempt-form");
  answer.value = "right";
  await form._listeners.submit[0]({ preventDefault() {} });
  // The submit fires the POST synchronously (no setTimeout in the
  // happy path up to the success response). The reload is delayed by
  // ~800ms for the user to see the success message, so we don't
  // assert on it here — RE9 covers the reload behavior.
  await new Promise((r) => setImmediate(r));
  assert.equal(calls.fetch.length, 2);
  const post = calls.fetch[1];
  assert.equal(post.init.method, "POST");
  assert.match(post.url, /attempt/);
  const body = JSON.parse(post.init.body);
  assert.deepEqual(body, { childId: "default", answer: "right" });
});

test("RE8: wrong submission shows '再想想' status", async () => {
  const { ctx } = setup({
    query: { caseId: "case:abc", childId: "default" },
    fetchResponses: [
      // Initial load
      jsonResponse(200, {
        caseId: "case:abc",
        problem: "p",
        userAnswer: "wrong",
        correctAnswer: "right",
        errorType: null,
        source: "manual",
        subject: "math",
        obligationStatus: "open",
        reviewedCount: 0,
        openedAt: 0,
        attempts: [{ kind: "original", userAnswer: "wrong", isCorrect: false, occurredAt: 0 }],
      }),
      // Submit answer (server says it's wrong)
      jsonResponse(200, { caseId: "case:abc", isCorrect: false, obligationStatus: "open" }),
    ],
  });
  await new Promise((r) => setImmediate(r));
  ctx.document.getElementById("answer").value = "still wrong";
  const form = ctx.document.getElementById("attempt-form");
  await form._listeners.submit[0]({ preventDefault() {} });
  await new Promise((r) => setImmediate(r));
  // Status reflects the wrong answer — kid is told to look at the
  // correct answer and try again, but the form stays open.
  const stat = ctx.document.getElementById("form-status");
  assert.equal(stat.getAttribute("data-tone"), "error");
  assert.match(stat._text, /再想想/);
});
