// Tests for pickGenWithBias — pure weighted-sampling function used by
// the candy math island quiz to bias question generation toward the
// kid's recent weak topics (carry / borrow / multiply / compute).
//
// Run: cd web/games/candy-math-island && node --test pick-gen.test.js
// (also invoked from server/package.json's "test" script)
import { test } from "node:test";
import assert from "node:assert/strict";
import { pickGenWithBias, buildBiasFromWeakTopics } from "./pick-gen.js";

const fakeQ = (n) => ({ display: `q${n}`, answer: n, errorType: "compute", level: 1 });

const items = [
  { errorType: "compute",  level: 1, gen: () => ({ ...fakeQ(1), errorType: "compute" }) },
  { errorType: "carry",    level: 2, gen: () => ({ ...fakeQ(2), errorType: "carry" }) },
  { errorType: "borrow",   level: 2, gen: () => ({ ...fakeQ(3), errorType: "borrow" }) },
  { errorType: "multiply", level: 3, gen: () => ({ ...fakeQ(4), errorType: "multiply" }) },
];

// Deterministic RNG factory: returns a function that yields values from
// the given array in order, looping forever. Useful for asserting
// which item the sampler picks without flakiness.
const seqRng = (vals) => {
  let i = 0;
  return () => vals[i++ % vals.length];
};

test("pickGenWithBias: returns a function that yields a Question", () => {
  const pick = pickGenWithBias(items, { compute: 1 }, seqRng([0]));
  const q = pick();
  assert.equal(typeof q, "object");
  assert.equal(typeof q.display, "string");
  assert.equal(typeof q.answer, "number");
});

test("pickGenWithBias: 100% carry bias always returns carry", () => {
  const pick = pickGenWithBias(items, { carry: 1 }, seqRng([0.1, 0.5, 0.9]));
  for (let i = 0; i < 20; i++) {
    assert.equal(pick().errorType, "carry");
  }
});

test("pickGenWithBias: 60% carry, 40% compute → carry ≥ 50% over 1000 picks", () => {
  const pick = pickGenWithBias(
    items,
    { carry: 0.6, compute: 0.4 },
    // pseudo-random but deterministic 0..1 sequence
    (() => { let s = 1; return () => { s = (s * 9301 + 49297) % 233280; return s / 233280; }; })(),
  );
  let carryCount = 0;
  const N = 1000;
  for (let i = 0; i < N; i++) {
    if (pick().errorType === "carry") carryCount++;
  }
  assert.ok(
    carryCount / N >= 0.5,
    `expected ≥50% carry, got ${(carryCount / N * 100).toFixed(1)}%`,
  );
});

test("pickGenWithBias: deterministic with seqRng — first sample maps to first item", () => {
  // items[0] = compute. rng 0.0 should hit cumulative[0] (compute).
  const pick = pickGenWithBias(items, { compute: 1, carry: 1, borrow: 1, multiply: 1 }, seqRng([0.0]));
  assert.equal(pick().errorType, "compute");
});

test("pickGenWithBias: deterministic with seqRng — second sample maps past compute", () => {
  // With all four types weighted equally, cumulative = [0.25, 0.5, 0.75, 1.0].
  // rng 0.3 → falls in [0.25, 0.5) → items[1] = carry.
  const pick = pickGenWithBias(items, { compute: 1, carry: 1, borrow: 1, multiply: 1 }, seqRng([0.3]));
  assert.equal(pick().errorType, "carry");
});

test("pickGenWithBias: deterministic with seqRng — rng 0.95 → multiply", () => {
  const pick = pickGenWithBias(items, { compute: 1, carry: 1, borrow: 1, multiply: 1 }, seqRng([0.95]));
  assert.equal(pick().errorType, "multiply");
});

test("pickGenWithBias: throws on empty items", () => {
  assert.throws(
    () => pickGenWithBias([], { carry: 1 }),
    /no items/,
  );
});

test("pickGenWithBias: errorType with 0 bias → that type is never picked", () => {
  // Only compute weighted. Carry/borrow/multiply items are unreachable.
  const pick = pickGenWithBias(items, { compute: 1, carry: 0, borrow: 0, multiply: 0 }, seqRng([0.1, 0.5, 0.9]));
  for (let i = 0; i < 20; i++) {
    assert.equal(pick().errorType, "compute");
  }
});

test("pickGenWithBias: errorType missing from bias → treated as 0", () => {
  // Only carry in bias; borrow/multiply/compute all missing → only carry.
  const pick = pickGenWithBias(items, { carry: 1 }, seqRng([0.1, 0.5, 0.9]));
  for (let i = 0; i < 20; i++) {
    assert.equal(pick().errorType, "carry");
  }
});

test("pickGenWithBias: all-zero bias → throws (cannot sample)", () => {
  assert.throws(
    () => pickGenWithBias(items, { compute: 0, carry: 0, borrow: 0, multiply: 0 }),
    /no positive weight/,
  );
});

test("pickGenWithBias: level filter — only items in given levels can be picked", () => {
  // level=1 only → only compute item is reachable.
  const pick = pickGenWithBias(
    items,
    { compute: 1, carry: 1, borrow: 1, multiply: 1 },
    seqRng([0.1, 0.5, 0.9]),
    { levels: [1] },
  );
  for (let i = 0; i < 20; i++) {
    assert.equal(pick().errorType, "compute");
  }
});

test("pickGenWithBias: level filter — multiple levels allowed", () => {
  // levels=[1,2] → compute + carry + borrow. No multiply.
  const pick = pickGenWithBias(
    items,
    { compute: 1, carry: 1, borrow: 1, multiply: 1 },
    seqRng([0.1, 0.3, 0.6, 0.9]),
    { levels: [1, 2] },
  );
  const seen = new Set();
  for (let i = 0; i < 50; i++) seen.add(pick().errorType);
  assert.ok(!seen.has("multiply"), "multiply should not be pickable in levels [1,2]");
  assert.ok(seen.has("compute"));
});

test("pickGenWithBias: default rng is Math.random (smoke test, runs once)", () => {
  const pick = pickGenWithBias(items, { carry: 1, compute: 1, borrow: 1, multiply: 1 });
  const q = pick();
  assert.ok(["carry", "compute", "borrow", "multiply"].includes(q.errorType));
});

test("buildBiasFromWeakTopics: empty input → balanced default", () => {
  const bias = buildBiasFromWeakTopics([]);
  // Default should sum to 1 and have a sensible compute-heavy floor.
  const sum = Object.values(bias).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sum - 1) < 1e-9, `bias should sum to 1, got ${sum}`);
  assert.ok(bias.compute >= 0.4, "compute should be at least 40% in default bias");
});

test("buildBiasFromWeakTopics: top-1 weak topic gets 60% weight", () => {
  const bias = buildBiasFromWeakTopics([
    { subject: "math", errorType: "carry", count: 5 },
    { subject: "math", errorType: "multiply", count: 2 },
  ]);
  assert.equal(bias.carry, 0.6, "top-1 carry should get 60% weight");
  // Other types get the remaining 40% split.
  const sum = Object.values(bias).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sum - 1) < 1e-9, `bias should sum to 1, got ${sum}`);
});

test("buildBiasFromWeakTopics: only one weak topic — it still gets 60%", () => {
  const bias = buildBiasFromWeakTopics([
    { subject: "math", errorType: "borrow", count: 3 },
  ]);
  assert.equal(bias.borrow, 0.6);
});

test("buildBiasFromWeakTopics: unknown errorType in weak topics is ignored", () => {
  // Server might return an errorType we don't know about. Don't crash.
  const bias = buildBiasFromWeakTopics([
    { subject: "math", errorType: "carry", count: 5 },
    { subject: "math", errorType: "flying", count: 99 },
  ]);
  assert.equal(bias.carry, 0.6);
  // Unknown "flying" should not pollute the bias map.
  assert.equal(bias.flying, undefined);
});
