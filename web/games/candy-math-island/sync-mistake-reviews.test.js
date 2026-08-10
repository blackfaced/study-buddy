// sync-mistake-reviews.test.js
//
// Tests for the client-side cascade-review queue flusher extracted from
// index.html (issue #100, T3 of #34 split). Covers:
//   - Empty queue → no HTTP call, no error
//   - Non-empty queue → POSTs {childId, results} to the right URL
//   - Server 2xx → queue cleared in place
//   - Server 4xx/5xx/network blip → queue dropped (NOT retried)
//   - Fire-and-forget: caller doesn't await (verifies the function
//     returns a promise that resolves regardless of fetch outcome)
//
// Run: cd web/games/candy-math-island && node --test sync-mistake-reviews.test.js

import { test } from "node:test";
import assert from "node:assert/strict";
import { syncMistakeReviews } from "./sync-mistake-reviews.js";

/** A stub fetch that records calls and returns a controllable response. */
function makeStubFetch(response = { status: 200, body: { reviews: [] } }, opts = {}) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    if (opts.throwBefore) throw new Error(opts.throwBefore);
    if (opts.throwAfter) {
      // Simulate a server that rejects (e.g. 500 with thrown error)
      throw new Error(opts.throwAfter);
    }
    return response;
  };
  return Object.assign(fn, { calls });
}

test("syncMistakeReviews: empty queue is a no-op (no HTTP call, returns immediately)", async () => {
  const fetchStub = makeStubFetch();
  const queue = [];
  await syncMistakeReviews(queue, { fetchFn: fetchStub, apiBase: "" });
  assert.equal(fetchStub.calls.length, 0, "fetch should not be called for empty queue");
});

test("syncMistakeReviews: non-empty queue → POST {childId, results} to /api/game/mistake-review", async () => {
  const fetchStub = makeStubFetch();
  const queue = [
    { mistakeId: 42, correct: true },
    { mistakeId: 17, correct: false },
  ];
  await syncMistakeReviews(queue, {
    fetchFn: fetchStub,
    apiBase: "https://mac-mini.local:3000",
    childId: "default",
  });
  assert.equal(fetchStub.calls.length, 1);
  assert.equal(fetchStub.calls[0].url, "https://mac-mini.local:3000/api/game/mistake-review");
  assert.equal(fetchStub.calls[0].init.method, "POST");
  assert.deepEqual(fetchStub.calls[0].init.body, {
    childId: "default",
    results: [
      { mistakeId: 42, correct: true },
      { mistakeId: 17, correct: false },
    ],
  });
});

test("syncMistakeReviews: on 2xx response → queue cleared in place (caller's ref stays valid)", async () => {
  const fetchStub = makeStubFetch({ reviews: [] });
  const queue = [
    { mistakeId: 1, correct: true },
    { mistakeId: 2, correct: true },
    { mistakeId: 3, correct: true },
  ];
  const refBefore = queue;
  await syncMistakeReviews(queue, { fetchFn: fetchStub, apiBase: "" });
  assert.equal(queue.length, 0, "queue should be empty after success");
  assert.equal(queue, refBefore, "queue reference should NOT be replaced (in-place clear)");
});

test("syncMistakeReviews: on 4xx → queue dropped (no retry) — best-effort semantic", async () => {
  const fetchStub = makeStubFetch(undefined, { throwAfter: "HTTP 404" });
  const queue = [
    { mistakeId: 99, correct: true },
  ];
  // Must NOT throw — caller relies on fire-and-forget.
  await syncMistakeReviews(queue, { fetchFn: fetchStub, apiBase: "" });
  assert.equal(queue.length, 0, "queue should be dropped after error (no retry)");
});

test("syncMistakeReviews: on network blip → queue dropped (no retry)", async () => {
  const fetchStub = makeStubFetch(undefined, { throwAfter: "ECONNREFUSED" });
  const queue = [
    { mistakeId: 100, correct: true },
  ];
  await syncMistakeReviews(queue, { fetchFn: fetchStub, apiBase: "" });
  assert.equal(queue.length, 0, "queue should be dropped on network blip");
});

test("syncMistakeReviews: on 500 → queue dropped (no retry)", async () => {
  const fetchStub = makeStubFetch(undefined, { throwAfter: "HTTP 500" });
  const queue = [{ mistakeId: 1, correct: true }];
  await syncMistakeReviews(queue, { fetchFn: fetchStub, apiBase: "" });
  assert.equal(queue.length, 0);
});

test("syncMistakeReviews: childId defaults to 'default' when not provided", async () => {
  const fetchStub = makeStubFetch();
  const queue = [{ mistakeId: 1, correct: true }];
  await syncMistakeReviews(queue, { fetchFn: fetchStub, apiBase: "" });
  assert.equal(fetchStub.calls[0].init.body.childId, "default");
});

test("syncMistakeReviews: fire-and-forget — caller does not await, function still completes", async () => {
  // This test models the production call site: syncToServer() does NOT
  // await syncMistakeReviews. We verify the function returns a promise
  // that resolves to undefined, so an unawaited call never causes
  // unhandled rejection.
  const fetchStub = makeStubFetch(undefined, { throwAfter: "server down" });
  const queue = [{ mistakeId: 1, correct: true }];
  const p = syncMistakeReviews(queue, { fetchFn: fetchStub, apiBase: "" });
  assert.ok(p instanceof Promise, "must return a promise");
  await p; // caller CAN await (this is just to make sure the promise resolves)
  assert.equal(queue.length, 0);
});
