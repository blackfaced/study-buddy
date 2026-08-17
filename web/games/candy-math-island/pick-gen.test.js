// Tests for pickGenWithBias — pure weighted-sampling function used by
// the candy math island quiz to bias question generation toward the
// kid's recent weak topics (carry / borrow / multiply / compute).
//
// Run: cd web/games/candy-math-island && node --test pick-gen.test.js
// (also invoked from server/package.json's "test" script)
import { test } from "node:test";
import assert from "node:assert/strict";
import { pickGenWithBias, buildBiasFromWeakTopics, isNonMathProblem, isMultiQuestionProblem, shouldSkipMistake, isMistakeAtOrBelowLevel } from "./pick-gen.js";

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

// v0.8.16 (candy-math-island start button): VLM photo capture of a whole
// homework page produced mistake records whose `problem` field contains
// MULTIPLE questions glued together ("**第一题：** ... \n\n**第二题：** ...").
// pickGenWithBias was rendering the raw problem text in the quiz, so
// kids saw two questions in one card and could not answer either.
// pickGenWithBias must skip multi-question mistakes and fall through to
// the regular weighted-sampling path. The provider's pool still
// advances past them; they'll be re-eligible once #128 T04 splits
// multi-question mistakes at the VLM capture boundary.

test("pickGenWithBias: multi-question mistake (newline-separated) is skipped → falls through to weighted sampling", () => {
  // Provider returns a multi-question mistake on the first call, a
  // single-question one on the second. Gate is forced open (mistakeRate=1,
  // rng always < 1). The first pick must NOT serve the multi-question
  // mistake — it must fall through to a regular generator question.
  const multiQ = {
    id: 100,
    problem: "**第一题：** 一根铁丝先用去一半，又用去剩下的一半，还剩 3 米。\n\n**第二题：** 小明有 20 块糖，他先吃了一半多 2 块。",
    answer: 12,
    errorType: "multiply",
  };
  const singleQ = {
    id: 101,
    problem: "7 × 8",
    answer: 56,
    errorType: "multiply",
  };
  let calls = 0;
  const provider = () => (calls++ === 0 ? multiQ : singleQ);
  const pick = pickGenWithBias(
    items,
    { compute: 1, carry: 1, borrow: 1, multiply: 1 },
    // Always less than 1 → always hit the mistake gate.
    () => 0.1,
    { mistakeProvider: provider, mistakeRate: 1 },
  );
  const q1 = pick();
  assert.equal(
    q1.fromMistake,
    undefined,
    "first pick must NOT serve the multi-question mistake; should fall through to weighted",
  );
  assert.ok(
    ["carry", "compute", "borrow", "multiply"].includes(q1.errorType),
    "first pick should be a regular generator question",
  );
  // Second pick: provider returns the single-question mistake, which IS served.
  const q2 = pick();
  assert.equal(q2.fromMistake, true, "second pick serves the single-question mistake");
  assert.equal(q2.mistakeId, 101);
  assert.equal(q2.display, "7 × 8");
});

test("pickGenWithBias: multi-question mistake (第一题/第二题 markers, no newline) is skipped", () => {
  // Some VLM outputs use bold markers without inserting a newline.
  const multiQ = {
    id: 200,
    problem: "**第一题：** 2+3=?\n**第二题：** 4+5=?",
    answer: 5,
    errorType: "compute",
  };
  let calls = 0;
  const provider = () => (calls++ === 0 ? multiQ : null);
  const pick = pickGenWithBias(
    items,
    { compute: 1, carry: 1, borrow: 1, multiply: 1 },
    () => 0.1,
    { mistakeProvider: provider, mistakeRate: 1 },
  );
  const q = pick();
  assert.equal(q.fromMistake, undefined, "must skip multi-question mistake without newline separators");
  assert.ok(["carry", "compute", "borrow", "multiply"].includes(q.errorType));
});

test("pickGenWithBias: single-question mistake is served normally", () => {
  const singleQ = { id: 1, problem: "5+3", answer: 8, errorType: "carry" };
  const pick = pickGenWithBias(
    items,
    { carry: 1, compute: 1, borrow: 1, multiply: 1 },
    () => 0.1,
    { mistakeProvider: () => singleQ, mistakeRate: 1 },
  );
  const q = pick();
  assert.equal(q.fromMistake, true);
  assert.equal(q.display, "5+3");
  assert.equal(q.answer, 8);
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

// =====================================================================
// v0.8.x: isNonMathProblem + shouldSkipMistake — defence-in-depth at
// the picker boundary. The kid saw "nexus-test-7+5" because old
// test/debug mistake records from my own test runs were still in the
// DB. Cleaned up the DB (#143-era), but we want the picker to refuse
// to render ANY non-math problem text — even if future test scripts
// or VLM misfires pollute the mistake pool.
//
// Detection rules — a problem is "non-math" if ANY of:
//   - empty / non-string
//   - contains a VLM refusal phrase ("题目...", "无法识别", "重新拍", "小书童", "光线", "模糊")
//   - contains a test/debug marker ("test", "nexus", or starts with "live-")
//   - contains no digits at all (real problems always have a number)
// =====================================================================

test("isNonMathProblem: detects VLM refusal phrases", () => {
  assert.equal(isNonMathProblem("题目可以再拍给我看！"), true);
  assert.equal(isNonMathProblem("题目呢~你可以重新拍一下数学题给我看吗？📸"), true);
  assert.equal(isNonMathProblem("无法识别（图片是一本书的封面..."), true);
  assert.equal(isNonMathProblem("题目内容。你可以重新拍一张清晰的照片再发过来吗？"), true);
  assert.equal(isNonMathProblem("小书童学习空间"), true);
  assert.equal(isNonMathProblem("拍糊了，光线太暗"), true);
});

test("isNonMathProblem: detects test/debug markers", () => {
  assert.equal(isNonMathProblem("nexus-test-7+5"), true);
  assert.equal(isNonMathProblem("live-2-7+8"), true);
  assert.equal(isNonMathProblem("live-nexus-3+4"), true);
  assert.equal(isNonMathProblem("live-test-7+5"), true);
  assert.equal(isNonMathProblem("debug-puzzle-9"), true);
});

test("isNonMathProblem: detects empty / non-string / subject-only", () => {
  assert.equal(isNonMathProblem(""), true);
  assert.equal(isNonMathProblem(null), true);
  assert.equal(isNonMathProblem(undefined), true);
  assert.equal(isNonMathProblem(42), true);
  assert.equal(isNonMathProblem("应用题"), true); // subject-only, no digit
  assert.equal(isNonMathProblem("时针分针辨认"), true); // subject-only, no digit
});

test("isNonMathProblem: real math problems pass through (false)", () => {
  // Regular candy-math-island display strings
  assert.equal(isNonMathProblem("4 + 7 = ?"), false);
  assert.equal(isNonMathProblem("45 - 28 = ?"), false);
  assert.equal(isNonMathProblem("7 × 8 = ?"), false);
  // Mistake-review problem text (no "= ?")
  assert.equal(isNonMathProblem("7+5"), false);
  assert.equal(isNonMathProblem("45-28"), false);
  assert.equal(isNonMathProblem("4×4×4"), false);
  // Scenario problem
  assert.equal(isNonMathProblem("3 个 5，一共多少？"), false);
  // Edge: a single digit (rare but valid for early-stage problems)
  assert.equal(isNonMathProblem("5"), false);
});

test("shouldSkipMistake: combines isMultiQuestionProblem + isNonMathProblem", () => {
  // Multi-q
  assert.equal(shouldSkipMistake("**第一题：** 一根铁丝...\n\n**第二题：** 小明有..."), true);
  assert.equal(shouldSkipMistake("第一题：...\n第二题：..."), true);
  // Non-math
  assert.equal(shouldSkipMistake("题目可以再拍给我看！"), true);
  assert.equal(shouldSkipMistake("nexus-test-7+5"), true);
  // Real problem
  assert.equal(shouldSkipMistake("45 - 28 = ?"), false);
  assert.equal(shouldSkipMistake("7+5"), false);
});

test("pickGenWithBias: non-math mistake is skipped, falls through to regular", () => {
  // The user reported a "nexus-test-7+5" mistake rendering in the
  // quiz. Picker should refuse to draw it and fall through to the
  // weighted-sampling path. The provider's pool still advances so
  // the bad record doesn't keep re-surfacing.
  const badMistake = { id: 99, problem: "nexus-test-7+5", answer: 12, errorType: "compute" };
  let calls = 0;
  const provider = () => (calls++ === 0 ? badMistake : null);
  const pick = pickGenWithBias(
    items,
    { compute: 1, carry: 1, borrow: 1, multiply: 1 },
    () => 0.1,
    { mistakeProvider: provider, mistakeRate: 1 },
  );
  const q = pick();
  // Picker must have skipped the bad mistake and returned a regular Q.
  assert.equal(q.fromMistake, undefined, "non-math mistake must be skipped");
  assert.ok(["carry", "compute", "borrow", "multiply"].includes(q.errorType));
});

// =====================================================================
// v0.8.x (candy mistake level cap): the picker previously served any
// mistake regardless of the kid's current level, so a L1 kid got L3
// multiply problems (e.g. "4 × 4 × 4") in the 30% mistake-mix window.
// The user reported: "题库里有 4*4*4 超纲了" (the question bank has
// 4*4*4 which is over the level). Fix: infer the mistake's level
// from errorType + problem text, skip if it's above the kid's level.
//
// Same defence-in-depth pattern as PR #144 (shouldSkipMistake for
// non-math / multi-q) and PR #142 (multi-q). Source-of-truth fix is
// to add a `level` column on mistakes and store it at creation time;
// this picker check is the bridge until that ships.
// =====================================================================

test("isMistakeAtOrBelowLevel: errorType=multiply → L3 (only L3 kids can see)", () => {
  // L3 mistake must NOT appear to L1 or L2 kids
  const m = { problem: "4 × 4 × 4", errorType: "multiply" };
  assert.equal(isMistakeAtOrBelowLevel(m, 1), false, "L3 mistake must not show to L1 kid");
  assert.equal(isMistakeAtOrBelowLevel(m, 2), false, "L3 mistake must not show to L2 kid");
  assert.equal(isMistakeAtOrBelowLevel(m, 3), true, "L3 mistake can show to L3 kid");
});

test("isMistakeAtOrBelowLevel: errorType=carry + small numbers → L1", () => {
  const m = { problem: "5 + 7 = ?", errorType: "carry" };
  assert.equal(isMistakeAtOrBelowLevel(m, 1), true);
  assert.equal(isMistakeAtOrBelowLevel(m, 2), true);
  assert.equal(isMistakeAtOrBelowLevel(m, 3), true);
});

test("isMistakeAtOrBelowLevel: errorType=carry + large numbers → L2", () => {
  const m = { problem: "35 + 27 = ?", errorType: "carry" };
  assert.equal(isMistakeAtOrBelowLevel(m, 1), false, "L2 carry must not show to L1 kid");
  assert.equal(isMistakeAtOrBelowLevel(m, 2), true);
  assert.equal(isMistakeAtOrBelowLevel(m, 3), true);
});

test("isMistakeAtOrBelowLevel: text fallback — problem contains × → L3", () => {
  // VLM caught "4 × 4 × 4" but didn't classify (errorType=vision_pending).
  // We must still detect it's L3 from the text.
  const m = { problem: "4 × 4 × 4", errorType: "vision_pending" };
  assert.equal(isMistakeAtOrBelowLevel(m, 1), false, "the actual user-reported bug");
  assert.equal(isMistakeAtOrBelowLevel(m, 2), false);
  assert.equal(isMistakeAtOrBelowLevel(m, 3), true);
});

test("isMistakeAtOrBelowLevel: text fallback — '个' (counting) → L3", () => {
  const m = { problem: "3 个 5，一共多少？", errorType: null };
  assert.equal(isMistakeAtOrBelowLevel(m, 1), false);
  assert.equal(isMistakeAtOrBelowLevel(m, 2), false);
  assert.equal(isMistakeAtOrBelowLevel(m, 3), true);
});

test("isMistakeAtOrBelowLevel: vision_pending with small numbers → L1", () => {
  const m = { problem: "5 + 3 = ?", errorType: "vision_pending" };
  assert.equal(isMistakeAtOrBelowLevel(m, 1), true);
});

test("pickGenWithBias: L3 mistake does NOT surface to L1 kid (the actual bug)", () => {
  // The exact scenario the user reported: L1 kid, mistake "4 × 4 × 4"
  // is in the pool, picker must skip it and fall through to a regular L1 Q.
  const l3Mistake = { id: 99, problem: "4 × 4 × 4", answer: 64, errorType: "vision_pending" };
  let calls = 0;
  const provider = () => (calls++ === 0 ? l3Mistake : null);
  const pick = pickGenWithBias(
    items,
    { compute: 1, carry: 1, borrow: 1, multiply: 1 },
    () => 0.1,  // mistakeRate gate always hits
    { mistakeProvider: provider, mistakeRate: 1, levels: [1] },  // L1 kid
  );
  const q = pick();
  // L1 kid must NOT get the L3 mistake. Fall-through to a regular L1 item.
  assert.equal(q.fromMistake, undefined, "L3 mistake must be skipped for L1 kid");
  assert.ok(["carry", "compute", "borrow"].includes(q.errorType), "must fall through to L1-eligible gen");
  assert.notEqual(q.errorType, "multiply");
});

test("pickGenWithBias: L3 mistake DOES surface to L3 kid (no over-blocking)", () => {
  const l3Mistake = { id: 99, problem: "4 × 4 × 4", answer: 64, errorType: "multiply" };
  const pick = pickGenWithBias(
    items,
    { compute: 1, carry: 1, borrow: 1, multiply: 1 },
    () => 0.1,
    { mistakeProvider: () => l3Mistake, mistakeRate: 1, levels: [3] },  // L3 kid
  );
  const q = pick();
  assert.equal(q.fromMistake, true, "L3 kid must see the L3 mistake");
  assert.equal(q.display, "4 × 4 × 4");
});
