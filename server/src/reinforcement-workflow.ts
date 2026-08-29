// server/src/reinforcement-workflow.ts
//
// T07: workflow for reinforcement attempts. Two entry points:
//
//   startReinforcementAttempt(caseId, problem, correctAnswer) → row
//     (status=pending, attempt_index = next available). Throws
//     MaxAttemptsReached if the case already exhausted its
//     `max_attempts` (default 3).
//
//   submitReinforcementAnswer(attemptId, userAnswer) → updated row
//     (is_correct = 0/1). Updates case_reinforcement_state on a
//     correct answer so the loop can show progress.

import type Database from "better-sqlite3";
import { answersMatch } from "./attempt-recorder.js";

export class MaxAttemptsReachedError extends Error {
  constructor(
    public readonly caseId: string,
    public readonly attemptsMade: number,
    public readonly maxAttempts: number,
  ) {
    super(
      `case ${caseId} has reached its max reinforcement attempts (${attemptsMade}/${maxAttempts})`,
    );
    this.name = "MaxAttemptsReachedError";
  }
}

export class AttemptNotFoundError extends Error {
  constructor(public readonly attemptId: number) {
    super(`reinforcement attempt ${attemptId} not found`);
    this.name = "AttemptNotFoundError";
  }
}

export class AttemptAlreadySubmittedError extends Error {
  constructor(public readonly attemptId: number) {
    super(`reinforcement attempt ${attemptId} already submitted`);
    this.name = "AttemptAlreadySubmittedError";
  }
}

export interface ReinforcementAttemptRow {
  id: number;
  caseId: string;
  childId: string;
  attemptIndex: number;
  problem: string;
  correctAnswer: string;
  userAnswer: string | null;
  isCorrect: number | null;
  startedAt: number;
  submittedAt: number | null;
}

function ensureStateRow(
  db: Database.Database,
  caseId: string,
  _now: number,
): { maxAttempts: number; attemptsMade: number } {
  const row = db
    .prepare(
      `SELECT max_attempts AS maxAttempts, reinforcement_attempts_made AS attemptsMade
         FROM case_reinforcement_state WHERE case_id = ?`,
    )
    .get(caseId) as { maxAttempts: number; attemptsMade: number } | undefined;
  if (row) return row;
  db.prepare(
    `INSERT INTO case_reinforcement_state
       (case_id, reinforcement_attempts_made, last_reinforcement_correct_at, max_attempts)
     VALUES (?, 0, NULL, 3)`,
  ).run(caseId);
  return { maxAttempts: 3, attemptsMade: 0 };
}

export function startReinforcementAttempt(
  db: Database.Database,
  caseId: string,
  childId: string,
  problem: string,
  correctAnswer: string,
  _now: () => number = Date.now,
): ReinforcementAttemptRow {
  const t = _now();
  const state = ensureStateRow(db, caseId, t);
  if (state.attemptsMade >= state.maxAttempts) {
    throw new MaxAttemptsReachedError(caseId, state.attemptsMade, state.maxAttempts);
  }
  const attemptIndex = state.attemptsMade + 1;
  const r = db
    .prepare(
      `INSERT INTO reinforcement_attempts
         (case_id, child_id, attempt_index, problem, correct_answer,
          user_answer, is_correct, started_at, submitted_at)
       VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, NULL)`,
    )
    .run(caseId, childId, attemptIndex, problem, correctAnswer, t);
  // bump the state counter (only counts started, not completed)
  db.prepare(
    `UPDATE case_reinforcement_state
        SET reinforcement_attempts_made = reinforcement_attempts_made + 1
      WHERE case_id = ?`,
  ).run(caseId);
  return loadAttempt(db, Number(r.lastInsertRowid))!;
}

function loadAttempt(
  db: Database.Database,
  id: number,
): ReinforcementAttemptRow | null {
  const row = db
    .prepare(
      `SELECT id, case_id AS caseId, child_id AS childId,
              attempt_index AS attemptIndex, problem,
              correct_answer AS correctAnswer, user_answer AS userAnswer,
              is_correct AS isCorrect, started_at AS startedAt,
              submitted_at AS submittedAt
         FROM reinforcement_attempts WHERE id = ?`,
    )
    .get(id) as ReinforcementAttemptRow | undefined;
  return row ?? null;
}

export function submitReinforcementAnswer(
  db: Database.Database,
  attemptId: number,
  userAnswer: string,
  now: () => number = Date.now,
): ReinforcementAttemptRow {
  const existing = loadAttempt(db, attemptId);
  if (!existing) throw new AttemptNotFoundError(attemptId);
  if (existing.userAnswer !== null) {
    throw new AttemptAlreadySubmittedError(attemptId);
  }
  // answersMatch is THE single answer-comparison semantics (owned by
  // the Attempt module): strips ALL whitespace + case-folds, false if
  // either side is empty. Same judge as closure-loop correction attempts.
  const isCorrect = answersMatch(userAnswer, existing.correctAnswer) ? 1 : 0;
  db.prepare(
    `UPDATE reinforcement_attempts
        SET user_answer = ?, is_correct = ?, submitted_at = ?
      WHERE id = ?`,
  ).run(userAnswer, isCorrect, now(), attemptId);
  if (isCorrect === 1) {
    db.prepare(
      `UPDATE case_reinforcement_state
          SET last_reinforcement_correct_at = ?
        WHERE case_id = ?`,
    ).run(now(), existing.caseId);
  }
  return loadAttempt(db, attemptId)!;
}
