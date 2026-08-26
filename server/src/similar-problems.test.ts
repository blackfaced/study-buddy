// server/src/similar-problems.test.ts
//
// T07-2: generateSimilarProblems is a pure helper. Same input +
// same rng → same output. Returns variants of the original problem
// (not duplicates), never includes the original, and degrades
// gracefully for unsupported problem types.

import { describe, it, expect } from "vitest";
import { generateSimilarProblems } from "./similar-problems.js";

// Tiny LCG so tests are deterministic.
function seededRng(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 2 ** 32;
    return s / 2 ** 32;
  };
}

describe("generateSimilarProblems (T07 PR-C)", () => {
  it("T07-2a: returns 2 add variants with new numbers (compute error → small range)", () => {
    const out = generateSimilarProblems("3+4=?", "compute", 2, seededRng(42));
    expect(out).toHaveLength(2);
    expect(out[0].correctAnswer).toBe(String(Number(out[0].problem.split(" ")[0]) + Number(out[0].problem.split(" ")[2])));
    expect(out[0].problem).not.toBe("3+4=?");
  });

  it("T07-2b: returns 2 subtract variants, all a >= b (borrow error → big range)", () => {
    const out = generateSimilarProblems("12-7=?", "borrow", 2, seededRng(7));
    expect(out).toHaveLength(2);
    for (const sp of out) {
      const [a, , b] = sp.problem.split(" ");
      expect(Number(a)).toBeGreaterThanOrEqual(Number(b));
      expect(sp.correctAnswer).toBe(String(Number(a) - Number(b)));
    }
  });

  it("T07-2c: returns [] for empty problem (downgrade gracefully)", () => {
    expect(generateSimilarProblems("", "compute", 2)).toEqual([]);
  });

  it("returns [] for multi-step word problem (not supported in v0.1)", () => {
    expect(generateSimilarProblems("鸡兔同笼 共35头94脚", "compute", 2)).toEqual([]);
  });

  it("returns [] for 3-operand problem", () => {
    expect(generateSimilarProblems("1+2+3=?", "compute", 2)).toEqual([]);
  });

  it("respects count=1 → exactly 1 problem", () => {
    const out = generateSimilarProblems("3+4=?", "compute", 1, seededRng(1));
    expect(out).toHaveLength(1);
  });

  it("normalized subtraction: '7-12' becomes '12-7' (answer still non-negative)", () => {
    const out = generateSimilarProblems("7-12=?", "borrow", 1, seededRng(2));
    expect(out).toHaveLength(1);
    const [a, , b] = out[0].problem.split(" ");
    expect(Number(a)).toBeGreaterThanOrEqual(Number(b));
  });
});
