// server/src/review-schedule.test.ts
//
// T08-2: scheduleReview returns 3 scheduled_at times, +1/+3/+7
// days after completedAt. completedAt=0 falls back to Date.now()
// (defensive — caller never passes 0 in practice).

import { describe, it, expect } from "vitest";
import { scheduleReview } from "./review-schedule.js";

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

describe("scheduleReview (T08 PR-C)", () => {
  it("T08-2a: returns 3 reviews at +1, +3, +7 days", () => {
    const base = 1_700_000_000_000; // fixed reference
    const out = scheduleReview(base, () => base);
    expect(out).toHaveLength(3);
    expect(out[0]).toMatchObject({ waveIndex: 0, daysAfter: 1, scheduledAt: base + 1 * ONE_DAY_MS });
    expect(out[1]).toMatchObject({ waveIndex: 1, daysAfter: 3, scheduledAt: base + 3 * ONE_DAY_MS });
    expect(out[2]).toMatchObject({ waveIndex: 2, daysAfter: 7, scheduledAt: base + 7 * ONE_DAY_MS });
  });

  it("T08-2b: completedAt=0 falls back to Date.now() (defensive)", () => {
    const fixedNow = 1_700_000_000_000;
    const out = scheduleReview(0, () => fixedNow);
    expect(out[0].scheduledAt).toBe(fixedNow + 1 * ONE_DAY_MS);
  });
});
