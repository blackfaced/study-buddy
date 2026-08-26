// server/src/review-schedule.ts
//
// T08: pure helper for computing the delayed-review schedule after
// a kid successfully consolidates a mistake (T07). 1 / 3 / 7 day
// intervals. Returns 3 scheduled_at epoch-ms values + a wave index
// (0 = first, 1 = second, 2 = third).
//
// v0.1 砍半: server-local time. Timezone-aware scheduling lives in
// a follow-up slice (T08 hardens the edge cases but doesn't block
// the 1/3/7 cadence from being useful in production).

const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const REVIEW_WAVE_DAYS: ReadonlyArray<number> = [1, 3, 7];

export interface ScheduledReview {
  waveIndex: number;
  daysAfter: number;
  scheduledAt: number;
}

export function scheduleReview(
  completedAt: number,
  now: () => number = Date.now,
): ScheduledReview[] {
  const base = completedAt > 0 ? completedAt : now();
  return REVIEW_WAVE_DAYS.map((days, i) => ({
    waveIndex: i,
    daysAfter: days,
    scheduledAt: base + days * ONE_DAY_MS,
  }));
}
