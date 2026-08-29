// server/src/parent-summary.ts
//
// T09: pure aggregator for the parent-facing mistake summary. Reads
// the 4 closure-loop tables (mistake_cases, correction_obligations,
// review_schedules, learning_attempts) and returns 6 stats + a list
// of recurring error observations.
//
// v0.1 砍半: all-time scope. A `since` filter is a follow-up slice.

import type Database from "better-sqlite3";

const RECENT_WINDOW_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const RECENT_OBSERVATIONS_PER_ERROR = 3;
const RECURRING_THRESHOLD = 2;

export interface ParentSummary {
  childId: string;
  generatedAt: number;
  stats: {
    newMistakes: number;
    pendingReview: number;
    alreadyCorrected: number;
    pendingReplay: number;
    reopened: number;
    evidenceGaps: number;
  };
  recurringErrorObservations: Array<{
    errorType: string;
    count: number;
    recentCaseIds: string[];
  }>;
}

export function aggregateParentSummary(
  db: Database.Database,
  childId: string,
  now: number = Date.now(),
): ParentSummary {
  const recentCutoff = now - RECENT_WINDOW_MS;

  // newMistakes: cases opened in the last 30 days
  const newMistakes = (db
    .prepare(
      `SELECT count(*) AS n FROM mistake_cases
        WHERE child_id = ? AND opened_at >= ?`,
    )
    .get(childId, recentCutoff) as { n: number }).n;

  // pendingReview: open obligation (still awaiting first independent correct)
  const pendingReview = (db
    .prepare(
      `SELECT count(*) AS n
         FROM mistake_cases mc
         JOIN correction_obligations co ON co.case_id = mc.case_id
        WHERE mc.child_id = ?
          AND co.status = 'open'`,
    )
    .get(childId) as { n: number }).n;

  // alreadyCorrected: verified obligation
  const alreadyCorrected = (db
    .prepare(
      `SELECT count(*) AS n
         FROM mistake_cases mc
         JOIN correction_obligations co ON co.case_id = mc.case_id
        WHERE mc.child_id = ?
          AND co.status = 'verified'`,
    )
    .get(childId) as { n: number }).n;

  // pendingReplay: review schedules not completed AND due (scheduled_at <= now)
  const pendingReplay = (db
    .prepare(
      `SELECT count(*) AS n FROM review_schedules
        WHERE child_id = ? AND completed_at IS NULL AND scheduled_at <= ?`,
    )
    .get(childId, now) as { n: number }).n;

  // reopened: review schedules with reopened_count > 0 (anytime)
  const reopened = (db
    .prepare(
      `SELECT count(*) AS n FROM review_schedules
        WHERE child_id = ? AND reopened_count > 0`,
    )
    .get(childId) as { n: number }).n;

  // evidenceGaps: cases opened in the last 30d with no learning_attempts
  const evidenceGaps = (db
    .prepare(
      `SELECT count(*) AS n
         FROM mistake_cases mc
        WHERE mc.child_id = ?
          AND mc.opened_at >= ?
          AND NOT EXISTS (
            SELECT 1 FROM learning_attempts la WHERE la.case_id = mc.case_id
          )`,
    )
    .get(childId, recentCutoff) as { n: number }).n;

  // Recurring error observations: group by error_type, only those
  // with count >= RECURRING_THRESHOLD. Return the most recent N
  // caseIds for each group (drill-down affordance for the parent).
  const grouped = db
    .prepare(
      `SELECT error_type AS errorType, count(*) AS n
         FROM mistake_cases
        WHERE child_id = ?
          AND error_type IS NOT NULL
          AND error_type != ''
        GROUP BY error_type
        HAVING n >= ?
        ORDER BY n DESC, error_type ASC`,
    )
    .all(childId, RECURRING_THRESHOLD) as Array<{
      errorType: string;
      n: number;
    }>;

  const recurringErrorObservations = grouped.map((g) => {
    const recent = db
      .prepare(
        `SELECT case_id FROM mistake_cases
          WHERE child_id = ? AND error_type = ?
          ORDER BY opened_at DESC, case_id
          LIMIT ?`,
      )
      .all(childId, g.errorType, RECENT_OBSERVATIONS_PER_ERROR) as Array<{
        case_id: string;
      }>;
    return {
      errorType: g.errorType,
      count: g.n,
      recentCaseIds: recent.map((r) => r.case_id),
    };
  });

  return {
    childId,
    generatedAt: now,
    stats: {
      newMistakes,
      pendingReview,
      alreadyCorrected,
      pendingReplay,
      reopened,
      evidenceGaps,
    },
    recurringErrorObservations,
  };
}
