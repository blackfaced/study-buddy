// web/capture/capture.test.js
//
// Unit tests for the manual-mistake capture page. Verifies the
// client-side validation, API call shape, and inbox rendering without
// requiring a real server (we use vm.runInNewContext + a stubbed
// fetch + a stubbed FormData inside the vm context).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "capture.js"), "utf8");

function setup({ fetchResponses = [], formValues = {} } = {}) {
  const calls = { fetch: [] };
  const fetchStub = async (url, init) => {
    calls.fetch.push({ url, init });
    const next = fetchResponses.shift();
    if (!next) {
      throw new Error("fetch called with no stub response");
    }
    return next;
  };
  const formListeners = {};
  const cancelListeners = {};
  const nodes = {
    "manual-form": {
      addEventListener: (event, fn) => { formListeners[event] = fn; },
      reset: () => { /* no-op */ },
    },
    "form-status": {
      _text: "",
      _tone: null,
      set textContent(v) { this._text = v; },
      get textContent() { return this._text; },
      setAttribute(k, v) { this._tone = v; },
      removeAttribute() { this._tone = null; },
      get tone() { return this._tone; },
    },
    "inbox-list": { _html: "", set innerHTML(v) { this._html = v; }, get innerHTML() { return this._html; } },
    "inbox-count": { _text: "", set textContent(v) { this._text = v; }, get textContent() { return this._text; } },
    "submit-btn": { disabled: false },
    "cancel-btn": { addEventListener: (event, fn) => { cancelListeners[event] = fn; } },
  };
  const document = {
    getElementById: (id) => nodes[id],
  };
  // Stub FormData inside the vm context. capture.js calls
  // `new FormData(FORM)` which we'd otherwise need a real <form>.
  class FormDataStub {
    constructor() { this._v = formValues; }
    get(k) { return this._v[k] ?? ""; }
  }
  const window = {};
  const ctx = { window, document, fetch: fetchStub, FormData: FormDataStub };
  vm.createContext(ctx);
  vm.runInContext(source, ctx);
  return { ctx, calls, formListeners, cancelListeners, nodes };
}

test("CAP1: empty problem → status error and no POST", async () => {
  // loadInbox fires at module load → 1 fetch. Submit fails validation
  // → no POST. Total: 1.
  const { calls, formListeners, nodes } = setup({
    formValues: { problem: "", userAnswer: "12", correctAnswer: "13", subject: "math", errorType: "" },
    fetchResponses: [jsonResponse(200, { cases: [] })],
  });
  await new Promise((r) => setImmediate(r));
  calls.fetch.length = 0; // reset the auto-fire count
  await formListeners.submit({ preventDefault() {} });
  assert.equal(calls.fetch.length, 0);
  assert.match(nodes["form-status"]._text, /题目/);
  assert.equal(nodes["form-status"]._tone, "error");
});

test("CAP2: empty userAnswer → status error and no POST", async () => {
  const { calls, formListeners, nodes } = setup({
    formValues: { problem: "8+5", userAnswer: "", correctAnswer: "13", subject: "math", errorType: "" },
    fetchResponses: [jsonResponse(200, { cases: [] })],
  });
  await new Promise((r) => setImmediate(r));
  calls.fetch.length = 0;
  await formListeners.submit({ preventDefault() {} });
  assert.equal(calls.fetch.length, 0);
  assert.match(nodes["form-status"]._text, /你写的答案/);
});

test("CAP3: empty correctAnswer → status error", async () => {
  const { calls, formListeners, nodes } = setup({
    formValues: { problem: "8+5", userAnswer: "12", correctAnswer: "", subject: "math", errorType: "" },
    fetchResponses: [jsonResponse(200, { cases: [] })],
  });
  await new Promise((r) => setImmediate(r));
  calls.fetch.length = 0;
  await formListeners.submit({ preventDefault() {} });
  assert.equal(calls.fetch.length, 0);
  assert.match(nodes["form-status"]._text, /正确答案/);
});

test("CAP4: empty subject → status error", async () => {
  const { calls, formListeners, nodes } = setup({
    formValues: { problem: "8+5", userAnswer: "12", correctAnswer: "13", subject: "", errorType: "" },
    fetchResponses: [jsonResponse(200, { cases: [] })],
  });
  await new Promise((r) => setImmediate(r));
  calls.fetch.length = 0;
  await formListeners.submit({ preventDefault() {} });
  assert.equal(calls.fetch.length, 0);
  assert.match(nodes["form-status"]._text, /学科/);
});

test("CAP5: valid form → POST /api/capture/manual with the right JSON body", async () => {
  // loadInbox (auto) + POST + loadInbox (after success) = 3 fetches.
  const { calls, formListeners, nodes } = setup({
    formValues: { problem: "8+5", userAnswer: "12", correctAnswer: "13", subject: "math", errorType: "compute" },
    fetchResponses: [
      jsonResponse(200, { cases: [] }), // initial loadInbox
      jsonResponse(201, { id: 42, caseId: "case:abc", created: true }), // POST
      jsonResponse(200, { cases: [] }), // post-POST loadInbox
    ],
  });
  await new Promise((r) => setImmediate(r));
  await formListeners.submit({ preventDefault() {} });
  // 3 fetches: 1 initial inbox, 1 POST, 1 post-POST inbox
  assert.equal(calls.fetch.length, 3);
  // The POST is the second fetch
  const postCall = calls.fetch[1];
  assert.equal(postCall.url, "/api/capture/manual");
  assert.equal(postCall.init.method, "POST");
  const body = JSON.parse(postCall.init.body);
  assert.deepEqual(body, {
    problem: "8+5", userAnswer: "12", correctAnswer: "13",
    subject: "math", errorType: "compute",
  });
  // Status is success
  assert.equal(nodes["form-status"]._tone, "success");
  assert.match(nodes["form-status"]._text, /已录入/);
});

test("CAP6: blank errorType is normalized to null (not the empty string)", async () => {
  const { calls, formListeners } = setup({
    formValues: { problem: "1+1", userAnswer: "2", correctAnswer: "2", subject: "math", errorType: "  " },
    fetchResponses: [
      jsonResponse(200, { cases: [] }),
      jsonResponse(201, { id: 1, caseId: "case:x", created: true }),
      jsonResponse(200, { cases: [] }),
    ],
  });
  await new Promise((r) => setImmediate(r));
  await formListeners.submit({ preventDefault() {} });
  const body = JSON.parse(calls.fetch[1].init.body);
  assert.equal(body.errorType, null);
});

test("CAP7: server 400 → status error with server message, no post-POST reload", async () => {
  // Initial loadInbox (consumes first response) + POST (consumes second) = 2.
  const { calls, formListeners, nodes } = setup({
    formValues: { problem: "1+1", userAnswer: "2", correctAnswer: "2", subject: "math", errorType: "" },
    fetchResponses: [
      jsonResponse(200, { cases: [] }), // initial loadInbox
      jsonResponse(400, { error: "subject is required" }), // POST returns 400
    ],
  });
  await new Promise((r) => setImmediate(r));
  await formListeners.submit({ preventDefault() {} });
  // No post-POST loadInbox because the POST failed
  assert.equal(calls.fetch.length, 2);
  assert.equal(nodes["form-status"]._tone, "error");
  assert.match(nodes["form-status"]._text, /subject is required/);
});

test("CAP8: cancel button → form reset, no extra fetch, status cleared", async () => {
  const { calls, cancelListeners, nodes } = setup({
    fetchResponses: [jsonResponse(200, { cases: [] })],
  });
  await new Promise((r) => setImmediate(r));
  calls.fetch.length = 0;
  cancelListeners.click();
  assert.equal(calls.fetch.length, 0);
  assert.equal(nodes["form-status"]._text, "");
  assert.equal(nodes["form-status"]._tone, null);
});

test("CAP9: loadInbox with empty list → empty message + count 0", async () => {
  const { nodes } = setup({
    fetchResponses: [
      jsonResponse(200, { cases: [] }),
    ],
  });
  // loadInbox runs at module load
  await new Promise((r) => setImmediate(r));
  assert.match(nodes["inbox-list"]._html, /今天还没有待订正的错题/);
  assert.equal(nodes["inbox-count"]._text, "0");
});

test("CAP10: loadInbox with cases → renders each entry with subject label and source pill", async () => {
  const { nodes } = setup({
    fetchResponses: [
      jsonResponse(200, {
        cases: [
          { caseId: "case:1", mistakeId: 1, problem: "8+5", userAnswer: "12", correctAnswer: "13",
            errorType: "compute", source: "manual", subject: "math", status: "open", openedAt: 100 },
          { caseId: "case:2", mistakeId: 2, problem: "汉字", userAnswer: "x", correctAnswer: "y",
            errorType: null, source: "game", subject: "chinese", status: "open", openedAt: 50 },
        ],
      }),
    ],
  });
  await new Promise((r) => setImmediate(r));
  const html = nodes["inbox-list"]._html;
  assert.match(html, /8\+5/);
  assert.match(html, /数学/);
  assert.match(html, /汉字/);
  assert.match(html, /语文/);
  // No 订正 N/3 badge — reviewed_count was a dead counter that never
  // moved; the concept is deleted (obligation status is the signal).
  assert.doesNotMatch(html, /订正 \d+\/3/);
  assert.match(html, /data-source="manual"/);
  assert.match(html, /data-source="game"/);
  assert.equal(nodes["inbox-count"]._text, "2");
});

test("CAP11: loadInbox with fetch error → 加载失败 message", async () => {
  const { nodes } = setup({
    fetchResponses: [
      { ok: false, status: 500, json: async () => ({}) },
    ],
  });
  await new Promise((r) => setImmediate(r));
  assert.match(nodes["inbox-list"]._html, /加载失败/);
});

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}
