// server/src/review-workflow.test.ts
//
// T08-3: workflow for review schedules. createReviewSchedule
// inserts 3 waves (+1/+3/+7 days). completeReviewAttempt writes
// completed_at + is_correct, bumps reopened_count on failure, and
// refuses to re-complete a finished row.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { migrateSchema } from "./db-migrate.js";
import {
  createReviewSchedule,
  completeReviewAttempt,
  ReviewAlreadyCompletedError,
  ReviewNotFoundError,
} from "./review-workflow.js";

let db: Database.Database;
let tmpDir: string;
let caseId = "";

const CHILD = "default";
const FIXED = 1_700_000_000_000;

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "study-buddy-review-"));
  db = new Database(join(tmpDir, "test.db"));
  db.pragma("foreign_keys = ON");
  db.pragma("journal_mode = WAL");
  migrateSchema(db);
  db.prepare(`INSERT OR IGNORE INTO children (id, name, grade) VALUES (?, ?, ?)`)
    .run(CHILD, "小宝", "二年级");
  const { insertMistake } = await import("./capture-service.js");
  const r = insertMistake(db, {
    childId: CHILD,
    problem: "3+4=?",
    userAnswer: "6",
    correctAnswer: "7",
    errorType: "compute",
    source: "manual",
  });
  caseId = r.caseId;
});

afterAll(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  db.exec(`DELETE FROM review_schedules`);
});

describe("createReviewSchedule (T08 PR-C)", () => {
  it("T08-3a (via create): inserts 3 waves for the case", () => {
    const rows = createReviewSchedule(db, caseId, CHILD, FIXED, () => FIXED);
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.scheduledAt)).toEqual([
      FIXED + 1 * 86_400_000,
      FIXED + 3 * 86_400_000,
      FIXED + 7 * 86_400_000,
    ]);
  });

  it("is idempotent: a second create deletes the previous pending schedules", () => {
    createReviewSchedule(db, caseId, CHILD, FIXED, () => FIXED);
    createReviewSchedule(db, caseId, CHILD, FIXED + 100_000, () => FIXED);
    const count = db
      .prepare(`SELECT count(*) AS n FROM review_schedules WHERE case_id = ?`)
      .get(caseId) as { n: number };
    expect(count.n).toBe(3); // still 3 (new wave), not 6
  });
});

describe("completeReviewAttempt (T08 PR-C)", () => {
  it("T08-3a: writes completed_at + is_correct=1 on success", () => {
    const rows = createReviewSchedule(db, caseId, CHILD, FIXED, () => FIXED);
    const after = completeReviewAttempt(db, rows[0].id, true, () => FIXED + 100);
    expect(after.completedAt).toBe(FIXED + 100);
    expect(after.completedIsCorrect).toBe(1);
    expect(after.reopenedCount).toBe(0);
  });

  it("T08-3b: writes is_correct=0 + bumps reopened_count on failure", () => {
    const rows = createReviewSchedule(db, caseId, CHILD, FIXED, () => FIXED);
    const after = completeReviewAttempt(db, rows[0].id, false, () => FIXED + 200);
    expect(after.completedIsCorrect).toBe(0);
    expect(after.reopenedCount).toBe(1);
  });

  it("T08-3c: re-completing a finished schedule throws AlreadyCompleted", () => {
    const rows = createReviewSchedule(db, caseId, CHILD, FIXED, () => FIXED);
    completeReviewAttempt(db, rows[0].id, true, () => FIXED);
    expect(() => completeReviewAttempt(db, rows[0].id, true, () => FIXED + 1)).toThrow(
      ReviewAlreadyCompletedError,
    );
  });

  it("T08 not found: throws ReviewNotFound", () => {
    expect(() => completeReviewAttempt(db, 9999, true)).toThrow(ReviewNotFoundError);
  });
});
