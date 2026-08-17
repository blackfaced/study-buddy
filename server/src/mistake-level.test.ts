// server/src/mistake-level.test.ts
// =====================================================================
// Tests for the shared `inferMistakeLevel` helper. Used by:
//   1. db-migrate (one-time backfill of pre-existing rows)
//   2. mistake-api (every new mistake insert)
//
// The picker (candy-math-island) used to do this on the client side as
// a text-based heuristic (PR #146). With the level column populated
// at creation time, the picker can just compare `m.level <= kidLevel`
// and drop the client-side inference entirely. The helper lives here
// as the single source of truth.
// =====================================================================

import { describe, it, expect } from "vitest";
import { inferMistakeLevel } from "./mistake-level.js";

describe("inferMistakeLevel", () => {
  it("errorType='multiply' → L3", () => {
    expect(inferMistakeLevel("3 × 4 = ?", "multiply")).toBe(3);
    expect(inferMistakeLevel("3 × 4", "multiply")).toBe(3);
  });

  it("problem contains × or × → L3 (text fallback)", () => {
    expect(inferMistakeLevel("4 × 4 × 4", "vision_pending")).toBe(3);
    expect(inferMistakeLevel("4 x 4 = ?", "vision_pending")).toBe(3);
  });

  it("problem contains '个' (counting) → L3 (text fallback)", () => {
    expect(inferMistakeLevel("3 个 5，一共多少？", null)).toBe(3);
    expect(inferMistakeLevel("5 个苹果", "vision_pending")).toBe(3);
  });

  it("errorType='carry' or 'borrow' + max number ≥ 20 → L2", () => {
    expect(inferMistakeLevel("35 + 27 = ?", "carry")).toBe(2);
    expect(inferMistakeLevel("51 - 37 = ?", "borrow")).toBe(2);
    expect(inferMistakeLevel("100 + 50 = ?", "carry")).toBe(2);
  });

  it("errorType='carry' or 'borrow' + max number < 20 → L1", () => {
    expect(inferMistakeLevel("5 + 7 = ?", "carry")).toBe(1);
    expect(inferMistakeLevel("13 - 7 = ?", "borrow")).toBe(1);
  });

  it("errorType='compute' or 'vision_pending' with small numbers → L1", () => {
    expect(inferMistakeLevel("5 + 3 = ?", "compute")).toBe(1);
    expect(inferMistakeLevel("8 - 2 = ?", "vision_pending")).toBe(1);
  });

  it("defaults to L1 for empty / weird input (safe)", () => {
    expect(inferMistakeLevel(null, null)).toBe(1);
    expect(inferMistakeLevel("", null)).toBe(1);
    expect(inferMistakeLevel("???", null)).toBe(1);
  });

  it("the user's bug: '4 × 4 × 4' with vision_pending → L3", () => {
    // This is the exact scenario the user reported on 2026-08-17
    // ("题库里有 4*4*4 超纲了"). Pre-migration, the picker would
    // have to guess from text. Post-migration, the row has
    // level=3 stored, so the picker just compares numbers.
    expect(inferMistakeLevel("4 × 4 × 4", "vision_pending")).toBe(3);
  });
});
