// server/src/candidate-promotion.test.ts
//
// T04C-2: buildInsertMistakeInput is a pure shape mapper. It takes a
// candidate + the kid's typed answer and returns the InsertMistakeInput
// that mistake-api expects. Empty problem → null (refuse to promote).

import { describe, it, expect } from "vitest";
import {
  buildInsertMistakeInput,
  type CandidateForPromotion,
} from "./candidate-promotion.js";

function cand(overrides: Partial<CandidateForPromotion> = {}): CandidateForPromotion {
  return {
    id: 1,
    childId: "default",
    subject: "math",
    problem: "3+4=?",
    source: "vision_page",
    errorType: null,
    ...overrides,
  };
}

describe("buildInsertMistakeInput (T04-C PR-C)", () => {
  it("T04C-2a: maps a fully-populated candidate to InsertMistakeInput", () => {
    const out = buildInsertMistakeInput({
      candidate: cand(),
      userAnswer: "7",
      correctAnswer: "7",
    });
    expect(out).toEqual({
      childId: "default",
      problem: "3+4=?",
      userAnswer: "7",
      correctAnswer: "7",
      errorType: null,
      source: "vision_page",
      subject: "math",
    });
  });

  it("T04C-2b: passes through the route-supplied errorType (override beats candidate)", () => {
    const out = buildInsertMistakeInput({
      candidate: cand({ errorType: "compute" }),
      userAnswer: "7",
      correctAnswer: "7",
      errorType: "borrow", // parent manually re-classified
    });
    expect(out?.errorType).toBe("borrow");
  });

  it("T04C-2c: falls back to candidate.errorType when route omits one", () => {
    const out = buildInsertMistakeInput({
      candidate: cand({ errorType: "compute" }),
      userAnswer: "7",
      correctAnswer: "7",
    });
    expect(out?.errorType).toBe("compute");
  });

  it("T04C-2d: returns null when problem is empty (refuse to promote)", () => {
    const out = buildInsertMistakeInput({
      candidate: cand({ problem: "" }),
      userAnswer: "7",
      correctAnswer: "7",
    });
    expect(out).toBeNull();
  });

  it("T04C-2e: returns null when problem is whitespace-only", () => {
    const out = buildInsertMistakeInput({
      candidate: cand({ problem: "   " }),
      userAnswer: "7",
      correctAnswer: "7",
    });
    expect(out).toBeNull();
  });

  it("T04C-2f: preserves null subject (caller can group, picker doesn't filter)", () => {
    const out = buildInsertMistakeInput({
      candidate: cand({ subject: null }),
      userAnswer: "7",
      correctAnswer: "7",
    });
    expect(out?.subject).toBeNull();
  });
});
