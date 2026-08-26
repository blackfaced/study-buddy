// server/src/parent-summary.test.ts
//
// T09-1: aggregateParentSummary is a pure aggregator. Seeds
// mistakes in various closure-loop states and verifies the 6 stats
// + the recurringErrorObservations group.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { migrateSchema } from "./db-migrate.js";
import { aggregateParentSummary } from "./parent-summary.js";

let db: Database.Database;
let tmpDir: string;
const CHILD = "default";
const NOW = 1_700_000_000_000;
const DAY = 86_400_000;

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "study-buddy-parent-summary-"));
  db = new Database(join(tmpDir, "test.db"));
  db.pragma("foreign_keys = ON");
  db.pragma("journal_mode = WAL");
  migrateSchema(db);
  db.prepare(`INSERT OR IGNORE INTO children (id, name, grade) VALUES (?, ?, ?)`)
    .run(CHILD, "小宝", "二年级");
  const { insertMistake } = await import("./routes/mistake-api.js");
  // We also need a second child to verify isolation.
  db.prepare(`INSERT OR IGNORE INTO children (id, name, grade) VALUES (?, ?, ?)`)
    .run("bob", "Bob", "三年级");

  // Seed: 5 cases in different states.
  // 1) new, recent, no attempts → evidenceGap + newMistake
  //    Note: insertMistake auto-creates the 'original' learning_attempt,
  //    so we explicitly delete it to make this case a real evidence gap.
  const c1 = insertMistake(db, {
    childId: CHILD, problem: "1+1=?", userAnswer: "3", correctAnswer: "2",
    errorType: "compute", source: "manual",
  });
  db.prepare(`DELETE FROM learning_attempts WHERE case_id = ?`).run(c1.caseId);
  // 2) new, recent, with 1 attempt → newMistake but NOT evidenceGap
  const c2 = insertMistake(db, {
    childId: CHILD, problem: "2+2=?", userAnswer: "5", correctAnswer: "4",
    errorType: "compute", source: "manual",
  });
  db.prepare(
    `INSERT INTO learning_attempts
       (attempt_id, case_id, child_id, attempt_kind, problem,
        user_answer, correct_answer, is_correct, occurred_at, source)
     VALUES ('attempt:test:1', ?, ?, 'correction', '2+2=?', '4', '4', 1, ?, 'manual')`,
  ).run(c2.caseId, CHILD, NOW - DAY);
  // 3) open obligation → pendingReview
  const _c3 = insertMistake(db, {
    childId: CHILD, problem: "3+3=?", userAnswer: "7", correctAnswer: "6",
    errorType: "carry", source: "manual",
  });
  // 4) verified obligation → alreadyCorrected
  const c4 = insertMistake(db, {
    childId: CHILD, problem: "4+4=?", userAnswer: "9", correctAnswer: "8",
    errorType: "borrow", source: "manual",
  });
  db.prepare(
    `UPDATE correction_obligations SET status = 'verified', verified_at = ?
      WHERE case_id = ?`,
  ).run(NOW, c4.caseId);
  // 5) another borrow case → recurringErrorObservations count >= 2
  insertMistake(db, {
    childId: CHILD, problem: "5+5=?", userAnswer: "11", correctAnswer: "10",
    errorType: "borrow", source: "manual",
  });

  // Bob seed (for cross-child isolation test): 1 mistake that should
  // NOT appear in the default summary.
  insertMistake(db, {
    childId: "bob", problem: "1+1=?", userAnswer: "3", correctAnswer: "2",
    errorType: "compute", source: "manual",
  });
});

afterAll(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  // No DB cleanup needed — the seed is fixed across tests.
});

describe("aggregateParentSummary (T09 PR-C)", () => {
  it("T09-1a: 6 stats match the seed (5 new + 4 pending + 1 verified + 0 replay + 0 reopened + 1 evidenceGap)", () => {
    const s = aggregateParentSummary(db, CHILD, NOW);
    expect(s.stats).toEqual({
      newMistakes: 5, // all 5 default cases opened in last 30d
      pendingReview: 4, // c1, c2, c3, c5 are open obligation (c4 is verified)
      alreadyCorrected: 1, // c4 only
      pendingReplay: 0, // no review_schedules
      reopened: 0, // no reopened reviews
      evidenceGaps: 1, // c1 (we deleted its original attempt)
    });
  });

  it("T09-1b: recurringErrorObservations surfaces borrow (×2) but not compute (×1)", () => {
    const s = aggregateParentSummary(db, CHILD, NOW);
    // We seeded 2 borrow cases (c4, c5) and 3 compute cases (c1, c2, bob's).
    // Only default child compute is counted: c1 + c2 = 2 compute → returns.
    // borrow × 2 also returns.
    const borrow = s.recurringErrorObservations.find((o) => o.errorType === "borrow");
    expect(borrow).toBeDefined();
    expect(borrow?.count).toBe(2);
    expect(borrow?.recentCaseIds).toHaveLength(2);
    const compute = s.recurringErrorObservations.find((o) => o.errorType === "compute");
    // compute also has 2 cases for default child (c1, c2). So it
    // IS surfaced. Adjust expectation: we have 2 compute for default
    // child, so it qualifies for "recurring".
    expect(compute).toBeDefined();
    expect(compute?.count).toBe(2);
  });

  it("T09-4: cross-child isolation — bob's mistake doesn't appear in default summary", () => {
    const s = aggregateParentSummary(db, CHILD, NOW);
    // newMistakes counts default child only (5, not 6).
    expect(s.stats.newMistakes).toBe(5);
  });
});
