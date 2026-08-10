// pick-gen-mistake-mix.test.js
//
// Tests for the 30% mistake-mix behavior added to pickGenWithBias
// (#34a-2, issue #99). The original pickGenWithBias stayed backwards-
// compatible: callers without `mistakeProvider` behave exactly as before.
// When a `mistakeProvider` is passed, with 30% probability each pick
// returns a mistake (drawn without replacement from the provider's pool)
// and with 70% it falls back to the regular weighted-sampling path.
//
// Run: cd web/games/candy-math-island && node --test pick-gen-mistake-mix.test.js

import { test } from "node:test";
import assert from "node:assert/strict";
import { pickGenWithBias } from "./pick-gen.js";

const fakeQ = (n) => ({ display: `q${n}`, answer: n, errorType: "compute", level: 1 });

const items = [
  { errorType: "compute",  level: 1, gen: () => ({ ...fakeQ(1), errorType: "compute" }) },
  { errorType: "carry",    level: 2, gen: () => ({ ...fakeQ(2), errorType: "carry" }) },
  { errorType: "borrow",   level: 2, gen: () => ({ ...fakeQ(3), errorType: "borrow" }) },
  { errorType: "multiply", level: 3, gen: () => ({ ...fakeQ(4), errorType: "multiply" }) },
];

// Deterministic RNG factory (from pick-gen.test.js).
const seqRng = (vals) => {
  let i = 0;
  return () => vals[i++ % vals.length];
};

// A mistakeProvider is a closure: () => Mistake|null. The picker calls
// it once per pick; if it returns a mistake, that mistake is served
// (and removed from the provider's internal pool). If it returns null
// (pool empty), the picker falls through to the regular weighted path.
function makeProvider(mistakes) {
  const pool = mistakes.slice();
  return () => pool.length > 0 ? pool.shift() : null;
}

test("pickGenWithBias: no mistakeProvider → behaves exactly as before (backwards compat)", () => {
  const pick = pickGenWithBias(items, { carry: 1 }, seqRng([0.1, 0.5, 0.9]));
  for (let i = 0; i < 5; i++) {
    assert.equal(pick().errorType, "carry");
  }
});

test("pickGenWithBias: mistakeProvider is invoked, can return null on empty pool", () => {
  let calls = 0;
  const emptyProvider = () => { calls++; return null; };
  // rng returns 0.5 each time → after the 30% gate (rng() < 0.3 fails),
  // the regular weighted-sampling path runs. Provider is still called
  // when the gate fires — but with rng > 0.3, gate never fires, so calls
  // should remain 0.
  const pick = pickGenWithBias(
    items,
    { carry: 1 },
    seqRng([0.5]),
    { mistakeProvider: emptyProvider },
  );
  for (let i = 0; i < 10; i++) pick();
  assert.equal(calls, 0);
});

test("pickGenWithBias: 100% gate → every pick comes from mistakeProvider (until empty)", () => {
  const mistakes = [
    { id: 1, problem: "7+5", answer: 12, errorType: "compute", fromMistake: true },
    { id: 2, problem: "9-4", answer: 5,  errorType: "compute", fromMistake: true },
    { id: 3, problem: "6*3", answer: 18, errorType: "compute", fromMistake: true },
  ];
  const pick = pickGenWithBias(
    items,
    { carry: 1 }, // would always pick carry without the gate
    seqRng([0.0]),  // 0.0 < 0.3 → gate fires every time
    { mistakeProvider: makeProvider(mistakes), mistakeRate: 0.3 },
  );
  const q1 = pick();
  const q2 = pick();
  const q3 = pick();
  // Picker wraps raw mistake into Question shape: problem → display.
  assert.equal(q1.display, "7+5");
  assert.equal(q2.display, "9-4");
  assert.equal(q3.display, "6*3");
  assert.equal(q1.fromMistake, true);
  assert.equal(q1.mistakeId, 1);
  // 4th pick: pool empty, gate still fires (rng=0.0), provider returns null,
  // picker falls through to the regular path → carry.
  const q4 = pick();
  assert.equal(q4.errorType, "carry");
});

test("pickGenWithBias: 0% gate → never picks from mistakeProvider", () => {
  const mistakes = [
    { id: 1, problem: "7+5", answer: 12, errorType: "compute", fromMistake: true },
  ];
  let providerCalls = 0;
  const provider = () => { providerCalls++; return mistakes.shift() || null; };
  // rng returns 0.5 each time → 0.5 < 0 is false → gate never fires.
  const pick = pickGenWithBias(
    items,
    { carry: 1 },
    seqRng([0.5]),
    { mistakeProvider: provider, mistakeRate: 0 },
  );
  for (let i = 0; i < 10; i++) {
    const q = pick();
    assert.equal(q.errorType, "carry");
  }
  assert.equal(providerCalls, 0, "provider should never be called when gate never fires");
});

test("pickGenWithBias: 30% rate over 1000 picks is within 25-35% (statistical)", () => {
  // Deterministic pseudo-random that yields 0..1, plus a mistake pool
  // large enough that we don't run out mid-test.
  const rng = (() => { let s = 1; return () => { s = (s * 9301 + 49297) % 233280; return s / 233280; }; })();
  const bigPool = [];
  for (let i = 0; i < 2000; i++) {
    bigPool.push({
      id: i,
      problem: `m-${i}`,
      answer: i,
      errorType: "compute",
      fromMistake: true,
    });
  }
  const pick = pickGenWithBias(
    items,
    { carry: 0.6, compute: 0.4 },
    rng,
    { mistakeProvider: makeProvider(bigPool), mistakeRate: 0.3 },
  );
  let mistakeCount = 0;
  const N = 1000;
  for (let i = 0; i < N; i++) {
    if (pick().fromMistake === true) mistakeCount++;
  }
  const rate = mistakeCount / N;
  assert.ok(
    rate >= 0.25 && rate <= 0.35,
    `expected 25-35% mistake rate, got ${(rate * 100).toFixed(1)}% (${mistakeCount}/${N})`,
  );
});

test("pickGenWithBias: mistake.problem is a real question (string), mistake.answer matches", () => {
  const mistakes = [
    { id: 1, problem: "12+8",  answer: 20, errorType: "compute", fromMistake: true },
    { id: 2, problem: "15-7",  answer: 8,  errorType: "compute", fromMistake: true },
  ];
  const pick = pickGenWithBias(
    items,
    { carry: 1 },
    seqRng([0.0, 0.0]),  // gate fires twice
    { mistakeProvider: makeProvider(mistakes), mistakeRate: 0.3 },
  );
  const q1 = pick();
  const q2 = pick();
  // After picker's wrap: problem → display, answer stays as-is.
  assert.equal(typeof q1.display, "string");
  assert.equal(q1.answer, 20);
  assert.equal(typeof q2.display, "string");
  assert.equal(q2.answer, 8);
  // Sanity: the wrapped display (originally mistake.problem) parses
  // to a real number matching the answer.
  for (const q of [q1, q2]) {
    const computed = evaluateProblem(q.display);
    assert.equal(computed, q.answer, `problem '${q.display}' should evaluate to ${q.answer}`);
  }
});

// Tiny shim so the test is self-contained — we can't import the kid's
// problem parser here without dragging in the whole index.html. The
// problems in this test are intentionally simple (single-op arithmetic).
function evaluateProblem(problem) {
  // Match "a+b" or "a-b" (a, b are 1-2 digit ints, no carry/borrow complexity).
  const m = problem.match(/^(\d+)([+\-])(\d+)$/);
  if (!m) return null;
  const [, a, op, b] = m;
  return op === "+" ? Number(a) + Number(b) : Number(a) - Number(b);
}
