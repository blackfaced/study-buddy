// server/src/candidate-workflow.ts
//
// T04-C: confirm + discard workflows for per-region OCR candidates.
//
// confirmCandidate(db, candidateId, { userAnswer, correctAnswer, errorType? })
//   1. Load candidate + check ownership
//   2. If status='confirmed' → return existing confirmed_case_id (idempotent)
//   3. If status='discarded' → throw ConflictError (re-confirm blocked)
//   4. buildInsertMistakeInput(candidate, ...)
//   5. insertMistake(db, ...) — writes mistake_cases + mistakes mirror +
//      learning_attempts + correction_obligations
//   6. UPDATE candidate SET status='confirmed', confirmed_case_id=?
//
// discardCandidate(db, candidateId)
//   1. Load candidate + check ownership
//   2. UPDATE candidate SET status='discarded' (idempotent if already
//      discarded → return { discarded: true, wasIdempotent: true })

import type Database from "better-sqlite3";
import {
  insertMistake,
  type InsertMistakeResult,
} from "./capture-service.js";
import { buildInsertMistakeInput } from "./candidate-promotion.js";

export class CandidateNotFoundError extends Error {
  constructor(public readonly candidateId: number) {
    super(`candidate ${candidateId} not found`);
    this.name = "CandidateNotFoundError";
  }
}

export class CandidateConflictError extends Error {
  constructor(
    public readonly candidateId: number,
    public readonly currentStatus: string,
  ) {
    super(
      `candidate ${candidateId} is in status '${currentStatus}' and cannot be confirmed`,
    );
    this.name = "CandidateConflictError";
  }
}

export interface ConfirmInput {
  userAnswer: string;
  correctAnswer: string;
  errorType?: string | null;
  now?: () => number;
}

export interface ConfirmResult {
  caseId: string;
  mistakeId: number;
  idempotent: boolean; // true if re-confirm returned the existing case
}

export interface DiscardResult {
  discarded: true;
  idempotent: boolean;
}

interface CandidateRow {
  id: number;
  draft_id: string;
  child_id: string;
  session_id: string;
  device_id: string;
  region_index: number;
  subject: string | null;
  problem: string | null;
  user_answer: string | null;
  correct_answer: string | null;
  error_type: string | null;
  status: string;
  confirmed_case_id: string | null;
}

function loadCandidate(db: Database.Database, candidateId: number): CandidateRow | null {
  return db
    .prepare(
      `SELECT id, draft_id, child_id, session_id, device_id, region_index,
              subject, problem, user_answer, correct_answer, error_type,
              status, confirmed_case_id
         FROM mistake_photo_candidates
        WHERE id = ?`,
    )
    .get(candidateId) as CandidateRow | undefined ?? null;
}

export function confirmCandidate(
  db: Database.Database,
  candidateId: number,
  input: ConfirmInput,
): ConfirmResult {
  const cand = loadCandidate(db, candidateId);
  if (!cand) throw new CandidateNotFoundError(candidateId);

  // Idempotent: re-confirm returns the same caseId, no second mistake.
  if (cand.status === "confirmed" && cand.confirmed_case_id) {
    const existing = db
      .prepare(
        `SELECT original_mistake_id FROM mistake_cases WHERE case_id = ?`,
      )
      .get(cand.confirmed_case_id) as { original_mistake_id: number } | undefined;
    return {
      caseId: cand.confirmed_case_id,
      mistakeId: existing?.original_mistake_id ?? 0,
      idempotent: true,
    };
  }

  // Re-confirm a discarded candidate is a hard 409. The parent
  // explicitly rejected this region; resurrecting it should require
  // re-running OCR (T04-B), not just re-confirming.
  if (cand.status === "discarded") {
    throw new CandidateConflictError(candidateId, cand.status);
  }

  // status === 'pending' → promote
  const insertInput = buildInsertMistakeInput({
    candidate: {
      id: cand.id,
      childId: cand.child_id,
      subject: cand.subject,
      problem: cand.problem,
      source: "vision_page",
      errorType: cand.error_type,
    },
    userAnswer: input.userAnswer,
    correctAnswer: input.correctAnswer,
    errorType: input.errorType ?? null,
  });
  if (!insertInput) {
    // Empty problem — refuse. The caller should re-run OCR or type
    // manually before retrying confirm.
    throw new CandidateConflictError(candidateId, "empty-problem");
  }

  const result: InsertMistakeResult = insertMistake(db, insertInput);

  db.prepare(
    `UPDATE mistake_photo_candidates
        SET status = 'confirmed', confirmed_case_id = ?
      WHERE id = ? AND status = 'pending'`,
  ).run(result.caseId, candidateId);

  return { caseId: result.caseId, mistakeId: result.id, idempotent: false };
}

export function discardCandidate(
  db: Database.Database,
  candidateId: number,
): DiscardResult {
  const cand = loadCandidate(db, candidateId);
  if (!cand) throw new CandidateNotFoundError(candidateId);

  if (cand.status === "discarded") {
    return { discarded: true, idempotent: true };
  }

  // If already confirmed, refuse — that mistake case is now in the
  // closure loop and the parent should mark-correct it (T3 / T05)
  // rather than discard the underlying candidate.
  if (cand.status === "confirmed") {
    throw new CandidateConflictError(candidateId, cand.status);
  }

  db.prepare(
    `UPDATE mistake_photo_candidates
        SET status = 'discarded'
      WHERE id = ? AND status = 'pending'`,
  ).run(candidateId);

  return { discarded: true, idempotent: false };
}
