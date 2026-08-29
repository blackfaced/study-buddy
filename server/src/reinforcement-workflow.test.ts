// server/src/reinforcement-workflow.test.ts
//
// T07-3 + T07-4: workflow for reinforcement attempts. Covers
// start (writes row + bumps state counter), submit (writes answer,
// computes is_correct, updates last_correct_at), max-attempts guard
// (throws MaxAttemptsReached), idempotency (re-submit throws
// AttemptAlreadySubmitted).

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { migrateSchema } from "./db-migrate.js";
import {
  startReinforcementAttempt,
  submitReinforcementAnswer,
  AttemptAlreadySubmittedError,
  AttemptNotFoundError,
  MaxAttemptsReachedError,
} from "./reinforcement-workflow.js";

let db: Database.Database;
let tmpDir: string;
let caseId = "";

const CHILD = "default";

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "study-buddy-reinforcement-"));
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
  db.exec(`DELETE FROM reinforcement_attempts`);
  db.exec(`DELETE FROM case_reinforcement_state`);
});

describe("startReinforcementAttempt (T07 PR-C)", () => {
  it("T07-3a: starts attempt 1 with user_answer=null and is_correct=null", () => {
    const a = startReinforcementAttempt(db, caseId, CHILD, "5+3=?", "8");
    expect(a.attemptIndex).toBe(1);
    expect(a.userAnswer).toBeNull();
    expect(a.isCorrect).toBeNull();
    expect(a.submittedAt).toBeNull();

    const state = db
      .prepare(
        `SELECT reinforcement_attempts_made AS n FROM case_reinforcement_state WHERE case_id = ?`,
      )
      .get(caseId) as { n: number };
    expect(state.n).toBe(1);
  });

  it("3 successive starts land attempt_index 1, 2, 3 then block at 4", () => {
    const a1 = startReinforcementAttempt(db, caseId, CHILD, "5+3=?", "8");
    const a2 = startReinforcementAttempt(db, caseId, CHILD, "6+2=?", "8");
    const a3 = startReinforcementAttempt(db, caseId, CHILD, "7+1=?", "8");
    expect([a1.attemptIndex, a2.attemptIndex, a3.attemptIndex]).toEqual([1, 2, 3]);
    expect(() => startReinforcementAttempt(db, caseId, CHILD, "8+1=?", "9")).toThrow(
      MaxAttemptsReachedError,
    );
  });
});

describe("submitReinforcementAnswer (T07 PR-C)", () => {
  it("correct answer → is_correct=1, updates last_reinforcement_correct_at", () => {
    const a = startReinforcementAttempt(db, caseId, CHILD, "5+3=?", "8");
    const after = submitReinforcementAnswer(db, a.id, "8");
    expect(after.isCorrect).toBe(1);
    expect(after.userAnswer).toBe("8");
    expect(after.submittedAt).not.toBeNull();

    const state = db
      .prepare(
        `SELECT last_reinforcement_correct_at AS t FROM case_reinforcement_state WHERE case_id = ?`,
      )
      .get(caseId) as { t: number };
    expect(state.t).not.toBeNull();
  });

  it("wrong answer → is_correct=0, no last_reinforcement_correct_at update", () => {
    const a = startReinforcementAttempt(db, caseId, CHILD, "5+3=?", "8");
    const after = submitReinforcementAnswer(db, a.id, "9");
    expect(after.isCorrect).toBe(0);
    const state = db
      .prepare(
        `SELECT last_reinforcement_correct_at AS t FROM case_reinforcement_state WHERE case_id = ?`,
      )
      .get(caseId) as { t: number | null };
    expect(state.t).toBeNull();
  });

  it("interior whitespace in the submitted answer still matches (unified answersMatch semantics)", () => {
    // The old inline trim().toLowerCase() compare marked "1 + 1 = 2"
    // vs canonical "1+1=2" as WRONG. The unified answersMatch strips
    // all whitespace, so this must be judged correct.
    const a = startReinforcementAttempt(db, caseId, CHILD, "1+1=?", "1+1=2");
    const after = submitReinforcementAnswer(db, a.id, "1 + 1 = 2");
    expect(after.isCorrect).toBe(1);
  });

  it("re-submit throws AttemptAlreadySubmitted (idempotency)", () => {
    const a = startReinforcementAttempt(db, caseId, CHILD, "5+3=?", "8");
    submitReinforcementAnswer(db, a.id, "8");
    expect(() => submitReinforcementAnswer(db, a.id, "9")).toThrow(
      AttemptAlreadySubmittedError,
    );
  });

  it("submit on missing id throws AttemptNotFound", () => {
    expect(() => submitReinforcementAnswer(db, 9999, "8")).toThrow(AttemptNotFoundError);
  });
});
