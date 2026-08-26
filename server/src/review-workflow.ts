// server/src/review-workflow.ts
//
// T08: workflow for delayed review schedules.
//
//   createReviewSchedule(caseId, childId, completedAt) → 3 rows
//     (idempotent: deletes any existing pending schedules for the
//     case first, so re-巩固 doesn't stack 3+3 schedules)
//
//   completeReviewAttempt(scheduleId, isCorrect) → updated row
//     (writes completed_at + is_correct). On is_correct=false,
//     bumped reopened_count. The actual re-opening of the case's
//     teaching state is handled by the route layer / future T09.

import type Database from "better-sqlite3";
import { scheduleReview } from "./review-schedule.js";

export class ReviewNotFoundError extends Error {
  constructor(public readonly scheduleId: number) {
    super(`review schedule ${scheduleId} not found`);
    this.name = "ReviewNotFoundError";
  }
}

export class ReviewAlreadyCompletedError extends Error {
  constructor(public readonly scheduleId: number) {
    super(`review schedule ${scheduleId} already completed`);
    this.name = "ReviewAlreadyCompletedError";
  }
}

export interface ReviewScheduleRow {
  id: number;
  caseId: string;
  childId: string;
  scheduledAt: number;
  notifiedAt: number | null;
  completedAt: number | null;
  completedIsCorrect: number | null;
  reopenedCount: number;
  createdAt: number;
}

export function createReviewSchedule(
  db: Database.Database,
  caseId: string,
  childId: string,
  completedAt: number,
  now: () => number = Date.now,
): ReviewScheduleRow[] {
  const t = now();
  // Idempotent: drop any existing pending schedules for this case
  // before creating the new wave. Re-巩固 shouldn't stack 3+3.
  db.prepare(
    `DELETE FROM review_schedules
      WHERE case_id = ? AND completed_at IS NULL`,
  ).run(caseId);
  const waves = scheduleReview(completedAt, now);
  const insert = db.prepare(
    `INSERT INTO review_schedules
       (case_id, child_id, scheduled_at, notified_at, completed_at,
        completed_is_correct, reopened_count, created_at)
     VALUES (?, ?, ?, NULL, NULL, NULL, 0, ?)`,
  );
  const ids: number[] = [];
  for (const wave of waves) {
    const r = insert.run(caseId, childId, wave.scheduledAt, t);
    ids.push(Number(r.lastInsertRowid));
  }
  return ids.map((id) => loadReview(db, id)!);
}

function loadReview(
  db: Database.Database,
  id: number,
): ReviewScheduleRow | null {
  return (
    (db
      .prepare(
        `SELECT id, case_id AS caseId, child_id AS childId,
                scheduled_at AS scheduledAt, notified_at AS notifiedAt,
                completed_at AS completedAt,
                completed_is_correct AS completedIsCorrect,
                reopened_count AS reopenedCount,
                created_at AS createdAt
           FROM review_schedules WHERE id = ?`,
      )
      .get(id) as ReviewScheduleRow | undefined) ?? null
  );
}

export function completeReviewAttempt(
  db: Database.Database,
  scheduleId: number,
  isCorrect: boolean,
  now: () => number = Date.now,
): ReviewScheduleRow {
  const existing = loadReview(db, scheduleId);
  if (!existing) throw new ReviewNotFoundError(scheduleId);
  if (existing.completedAt !== null) {
    throw new ReviewAlreadyCompletedError(scheduleId);
  }
  const t = now();
  if (isCorrect) {
    db.prepare(
      `UPDATE review_schedules
          SET completed_at = ?, completed_is_correct = 1
        WHERE id = ?`,
    ).run(t, scheduleId);
  } else {
    db.prepare(
      `UPDATE review_schedules
          SET completed_at = ?, completed_is_correct = 0,
              reopened_count = reopened_count + 1
        WHERE id = ?`,
    ).run(t, scheduleId);
  }
  return loadReview(db, scheduleId)!;
}
