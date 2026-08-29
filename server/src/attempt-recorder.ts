// server/src/attempt-recorder.ts
// =====================================================================
// The Attempt module seed. Owns:
//
//   - answersMatch / normalizeAnswer: THE single answer-comparison
//     semantics for correction attempts (routes/capture.ts
//     handleAttempt) AND reinforcement attempts
//     (reinforcement-workflow.ts submitReinforcementAnswer). No other
//     module may grow its own comparator.
//
//   - recordCorrectionAttempt: the post-validation core of a
//     correction attempt against a mistake case. Extracted from
//     handleAttempt (routes/capture.ts) so the legacy
//     /api/game/mistake-review compat adapter can record in-quiz
//     re-attempts through the exact same closure-loop write path as
//     the capture UI.
//
// recordCorrectionAttempt holds:
//   - case + obligation fetch (authoritative, inside the transaction)
//   - verified-idempotency: an already-closed obligation gets NO new
//     attempt row — the caller reports the current state instead
//   - INSERT OR IGNORE into learning_attempts with a deterministic
//     attempt_id (`<prefix>:<caseId>:<occurredAt>`)
//   - on isCorrect: close the obligation (status='verified',
//     verified_at=now) + delete the legacy `mistakes` mirror row
//
// Unlike handleAttempt's original inline writes, the whole multi-write
// runs in a single db.transaction(...): a crash between the attempt
// INSERT and the obligation UPDATE can no longer leave a half-recorded
// correction.
//
// Callers own HTTP-level validation: existence (404), cross-child
// checks (403), and calling answersMatch all stay in the route handler.
// `userAnswer` is nullable because the legacy game clients don't always
// echo the kid's re-attempt answer.
// =====================================================================

import type Database from "better-sqlite3";

/**
 * Compare a kid's submitted answer to the canonical correct_answer.
 * Pure function. Whitespace-stripped + case-folded.
 * Returns false if either side is missing/empty.
 *
 * THE single answer-comparison semantics for correction AND
 * reinforcement attempts — both routes/capture.ts and
 * reinforcement-workflow.ts import this. Do not grow a second
 * comparator elsewhere.
 *
 * v0.1 limitation: this is a textual comparison. Math problems where
 * the kid writes "5+3=8" vs the canonical "8" won't match — the spec
 * says "首次独立订正正确" closes the obligation, so v0.5 can add a
 * numeric / expression-aware comparator. The current implementation
 * is intentionally conservative: better to ask the kid to type the
 * exact answer form than to over-credit fuzzy matches.
 */
export function answersMatch(submitted: string, expected: string): boolean {
  const a = normalizeAnswer(submitted);
  const b = normalizeAnswer(expected);
  if (!a || !b) return false;
  return a === b;
}

// Strip ALL whitespace (not just collapse). Math answers often vary
// in spacing (1+1=2 vs 1 + 1 = 2) but the kid is still expressing
// the same answer. Pure function, no captures.
export function normalizeAnswer(s: string): string {
  return (s ?? "").replace(/\s+/g, "").toLowerCase();
}

export interface RecordCorrectionAttemptInput {
  caseId: string;
  childId: string;
  isCorrect: boolean;
  userAnswer: string | null;
  /**
   * Prefix for the deterministic attempt_id. The capture route uses
   * "review-self" (kid typed the answer in the review UI); the legacy
   * game adapter uses "review-game". Defaults to "review-self".
   */
  attemptIdPrefix?: string;
}

export type RecordCorrectionAttemptResult =
  | {
      outcome: "recorded";
      obligationStatus: string;
      reviewedCount: number;
      verifiedAt: number | null;
    }
  | {
      outcome: "already-verified";
      obligationStatus: string;
      reviewedCount: number;
      verifiedAt: number | null;
    }
  | { outcome: "not-found" };

export function recordCorrectionAttempt(
  db: Database.Database,
  input: RecordCorrectionAttemptInput,
): RecordCorrectionAttemptResult {
  const prefix = input.attemptIdPrefix ?? "review-self";
  return db.transaction((): RecordCorrectionAttemptResult => {
    const row = db
      .prepare(
        `SELECT mc.case_id AS caseId,
                mc.child_id AS childId,
                mc.correct_answer AS correctAnswer,
                mc.source,
                co.status AS obligationStatus,
                co.reviewed_count AS reviewedCount
           FROM mistake_cases mc
           JOIN correction_obligations co ON co.case_id = mc.case_id
          WHERE mc.case_id = ?`,
      )
      .get(input.caseId) as
      | {
          caseId: string;
          childId: string;
          correctAnswer: string | null;
          source: string;
          obligationStatus: string;
          reviewedCount: number;
        }
      | undefined;
    if (!row) {
      return { outcome: "not-found" };
    }

    // Already verified (race with another device, or a repeat review
    // of a closed case): report the current state, don't append a new
    // attempt row. Idempotent retry of the kid's last input.
    if (row.obligationStatus !== "open") {
      const verifiedRow = db
        .prepare(
          "SELECT verified_at AS verifiedAt FROM correction_obligations WHERE case_id = ?",
        )
        .get(input.caseId) as { verifiedAt: number | null } | undefined;
      return {
        outcome: "already-verified",
        obligationStatus: row.obligationStatus,
        reviewedCount: row.reviewedCount,
        verifiedAt: verifiedRow?.verifiedAt ?? null,
      };
    }

    const occurredAt = Date.now();
    const attemptId = `${prefix}:${input.caseId}:${occurredAt}`;

    db.prepare(`
      INSERT OR IGNORE INTO learning_attempts
        (attempt_id, case_id, attempt_kind, mistake_id, child_id, problem,
         user_answer, correct_answer, is_correct, occurred_at, source)
      VALUES (?, ?, 'correction', NULL, ?, NULL, ?, ?, ?, ?, ?)
    `).run(
      attemptId,
      input.caseId,
      input.childId,
      input.userAnswer,
      row.correctAnswer,
      input.isCorrect ? 1 : 0,
      occurredAt,
      row.source,
    );

    let verifiedAt: number | null = null;
    let obligationStatus = row.obligationStatus;
    if (input.isCorrect) {
      // First independent correct closes the obligation (T05 semantics).
      verifiedAt = Date.now();
      db.prepare(
        "UPDATE correction_obligations SET status = 'verified', verified_at = ? WHERE case_id = ? AND status = 'open'",
      ).run(verifiedAt, input.caseId);
      obligationStatus = "verified";
      // Drop the legacy mistakes mirror (same as T3 closeObligation path,
      // PR-D #155). mistake_cases is preserved. The mirror's id is the
      // original_mistake_id stored on the canonical case row.
      db.prepare(
        "DELETE FROM mistakes WHERE id = (SELECT original_mistake_id FROM mistake_cases WHERE case_id = ?) AND child_id = ?",
      ).run(input.caseId, input.childId);
    }

    return {
      outcome: "recorded",
      obligationStatus,
      reviewedCount: row.reviewedCount,
      verifiedAt,
    };
  })();
}
