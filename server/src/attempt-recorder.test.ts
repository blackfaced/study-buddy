// server/src/attempt-recorder.test.ts
//
// Unit tests for the Attempt module's public surface. Currently the
// answer-comparison seam: answersMatch / normalizeAnswer are THE
// single comparison semantics for both correction attempts
// (routes/capture.ts) and reinforcement attempts
// (reinforcement-workflow.ts).

import { describe, expect, it } from "vitest";
import { answersMatch, normalizeAnswer } from "./attempt-recorder.js";

describe("answersMatch (single answer-comparison semantics)", () => {
  it("strips ALL whitespace, including interior", () => {
    // The kid typed the same answer with different spacing — still correct.
    expect(answersMatch(" 1 + 1 = 2 ", "1+1=2")).toBe(true);
    expect(answersMatch("1+1=2", " 1 + 1 = 2 ")).toBe(true);
  });

  it("folds case", () => {
    expect(answersMatch("THIRTEEN", "thirteen")).toBe(true);
    expect(answersMatch("ThIrTeEn", "thirteen")).toBe(true);
  });

  it("returns false when either side is empty", () => {
    expect(answersMatch("", "8")).toBe(false);
    expect(answersMatch("8", "")).toBe(false);
    // empty==empty must NOT be a match (no empty guard would flip this
    // to true and silently auto-verify cases with a blank canonical).
    expect(answersMatch("", "")).toBe(false);
    // whitespace-only normalizes to empty → same guard applies
    expect(answersMatch("   ", "8")).toBe(false);
    expect(answersMatch("   ", "   ")).toBe(false);
  });

  it("handles nullish input safely (typed callers pass strings, runtime may not)", () => {
    expect(answersMatch(null as unknown as string, "8")).toBe(false);
    expect(answersMatch("8", undefined as unknown as string)).toBe(false);
    expect(normalizeAnswer(null as unknown as string)).toBe("");
  });

  it("does not equate different answers", () => {
    expect(answersMatch("9", "8")).toBe(false);
  });
});

describe("normalizeAnswer", () => {
  it("removes whitespace and lowercases", () => {
    expect(normalizeAnswer("  1 + 1 = 2  ")).toBe("1+1=2");
    expect(normalizeAnswer("THIRTEEN")).toBe("thirteen");
    expect(normalizeAnswer("")).toBe("");
  });
});
