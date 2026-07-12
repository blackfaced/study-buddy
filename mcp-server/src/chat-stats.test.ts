import { describe, it, expect } from "vitest";
import {
  computeChatStats,
  computeOfftopicRate,
  computeRecoveryRate,
  type ChatTurn,
} from "./chat-stats.js";

const W = "writing" as const;
const F = "freechat" as const;

function turn(overrides: Partial<ChatTurn> = {}): ChatTurn {
  return {
    role: "child",
    topic: "learning",
    redirected: 0,
    state: W,
    ...overrides,
  };
}

describe("computeChatStats", () => {
  it("returns zeros for empty input", () => {
    const stats = computeChatStats([]);
    expect(stats).toEqual({ offtopic: 0, recovered: 0, writingTurns: 0 });
  });

  it("counts only child rows (ignores agent rows)", () => {
    const rows: ChatTurn[] = [
      turn({ role: "agent", topic: "offtopic" }),
      turn({ role: "child", topic: "offtopic" }),
    ];
    expect(computeChatStats(rows).offtopic).toBe(1);
  });

  it("counts offtopic only in writing state (excludes freechat)", () => {
    const rows: ChatTurn[] = [
      turn({ state: W, topic: "offtopic" }),
      turn({ state: F, topic: "offtopic" }),
      turn({ state: F, topic: "offtopic", role: "child" }),
    ];
    const stats = computeChatStats(rows);
    expect(stats.offtopic).toBe(1);
    expect(stats.writingTurns).toBe(1);
  });

  it("treats null state as writing (legacy rows without state column)", () => {
    const rows: ChatTurn[] = [
      turn({ state: null, topic: "offtopic" }),
    ];
    expect(computeChatStats(rows).offtopic).toBe(1);
  });

  it("recovered = offtopic AND redirected=1", () => {
    const rows: ChatTurn[] = [
      turn({ topic: "offtopic", redirected: 1 }),
      turn({ topic: "offtopic", redirected: 0 }),
      turn({ topic: "offtopic", redirected: 1 }),
    ];
    const stats = computeChatStats(rows);
    expect(stats.offtopic).toBe(3);
    expect(stats.recovered).toBe(2);
  });

  it("counts writingTurns as all child messages during writing (any topic)", () => {
    const rows: ChatTurn[] = [
      turn({ state: W, topic: "learning" }),
      turn({ state: W, topic: "offtopic" }),
      turn({ state: W, topic: "emotion" }),
      turn({ state: F, topic: "offtopic" }), // excluded
    ];
    expect(computeChatStats(rows).writingTurns).toBe(3);
  });
});

describe("computeOfftopicRate", () => {
  it("returns 0 when no turns", () => {
    expect(computeOfftopicRate({ offtopic: 0, recovered: 0, writingTurns: 0 })).toBe(0);
  });

  it("returns 0 when no offtopic", () => {
    const stats = { offtopic: 0, recovered: 0, writingTurns: 10 };
    expect(computeOfftopicRate(stats)).toBe(0);
  });

  // Regression: original code computed offtopic / (offtopic + recovered), double-counting.
  // With offtopic=2, recovered=1, writingTurns=10, the correct rate is 2/10 = 20%,
  // not 2/3 = 67% (the broken formula).
  it("computes offtopic / writingTurns (does NOT add recovered to denominator)", () => {
    const stats = { offtopic: 2, recovered: 1, writingTurns: 10 };
    expect(computeOfftopicRate(stats)).toBe(20);
  });

  it("reproduces the report's real scenario: 8 offtopic out of 14 child messages", () => {
    const stats = { offtopic: 8, recovered: 6, writingTurns: 14 };
    // 8/14 ≈ 57.14 → 57, NOT 8/(8+6) = 57 (same number for this case,
    // but for asymmetric cases the formula differs — see test above).
    expect(computeOfftopicRate(stats)).toBe(57);
  });
});

describe("computeRecoveryRate", () => {
  it("returns 100 when no offtopic (vacuous truth)", () => {
    expect(computeRecoveryRate({ offtopic: 0, recovered: 0, writingTurns: 5 })).toBe(100);
  });

  it("returns recovered/offtopic as percentage", () => {
    expect(computeRecoveryRate({ offtopic: 8, recovered: 6, writingTurns: 14 })).toBe(75);
  });

  it("returns 0 when nothing recovered", () => {
    expect(computeRecoveryRate({ offtopic: 3, recovered: 0, writingTurns: 10 })).toBe(0);
  });
});
