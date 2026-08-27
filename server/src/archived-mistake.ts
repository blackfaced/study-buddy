// server/src/archived-mistake.ts
//
// T10 #134: pure read-only helper for the legacy `mistakes` mirror.
// Returns the raw row as it sits in the mirror, regardless of
// `is_archived`. The closure loop (mistake_cases +
// correction_obligations + learning_attempts) is the source of
// truth; this helper exists for diagnostic / debug only.
//
// Why a separate helper: closure-loop readers should never go
// through this code. By isolating the raw read in a typed
// interface, we make it obvious in the call sites that this is
// "intentionally bypassing the closure loop" — every caller is
// either a test or a debug endpoint.

import type Database from "better-sqlite3";

export interface ArchivedMistake {
  id: number;
  sessionId: string;
  childId: string;
  ts: number;
  subject: string | null;
  problem: string | null;
  errorType: string | null;
  hint: string | null;
  reviewedCount: number;
  imagePath: string | null;
  visionInput: string | null;
  visionReasoning: string | null;
  visionModel: string | null;
  visionTs: number | null;
  source: string;
  userAnswer: string | null;
  correctAnswer: string | null;
  evidenceKey: string | null;
  evidenceStatus: string | null;
  evidenceMethod: string | null;
  evidenceConfirmedAt: number | null;
  level: number | null;
  isArchived: number;
}

/**
 * Read a single legacy mistakes-table row by id. Returns the raw
 * record (including `isArchived`) or null if no row exists.
 *
 * Pure: only reads from disk via the supplied database handle.
 * No I/O, no side effects, no logging.
 *
 * Diagnostic use only — closure-loop code must read from
 * `mistake_cases` instead.
 */
export function readArchivedMistake(
  db: Database.Database,
  id: number,
): ArchivedMistake | null {
  const row = db
    .prepare(
      `SELECT id, session_id, child_id, ts, subject, problem, error_type, hint,
              reviewed_count, image_path, vision_input, vision_reasoning,
              vision_model, vision_ts, source, user_answer, correct_answer,
              evidence_key, evidence_status, evidence_method,
              evidence_confirmed_at, level, is_archived
         FROM mistakes
        WHERE id = ?`,
    )
    .get(id) as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    id: row.id as number,
    sessionId: row.session_id as string,
    childId: row.child_id as string,
    ts: row.ts as number,
    subject: (row.subject as string | null) ?? null,
    problem: (row.problem as string | null) ?? null,
    errorType: (row.error_type as string | null) ?? null,
    hint: (row.hint as string | null) ?? null,
    reviewedCount: (row.reviewed_count as number) ?? 0,
    imagePath: (row.image_path as string | null) ?? null,
    visionInput: (row.vision_input as string | null) ?? null,
    visionReasoning: (row.vision_reasoning as string | null) ?? null,
    visionModel: (row.vision_model as string | null) ?? null,
    visionTs: (row.vision_ts as number | null) ?? null,
    source: (row.source as string) ?? "study-buddy",
    userAnswer: (row.user_answer as string | null) ?? null,
    correctAnswer: (row.correct_answer as string | null) ?? null,
    evidenceKey: (row.evidence_key as string | null) ?? null,
    evidenceStatus: (row.evidence_status as string | null) ?? null,
    evidenceMethod: (row.evidence_method as string | null) ?? null,
    evidenceConfirmedAt: (row.evidence_confirmed_at as number | null) ?? null,
    level: (row.level as number | null) ?? null,
    isArchived: (row.is_archived as number) ?? 0,
  };
}
