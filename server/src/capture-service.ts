// server/src/capture-service.ts
// =====================================================================
// The single seam through which every Capture mode (game / manual /
// vision / vision_page) creates a Mistake Case: insertMistake() writes
// the canonical mistake_cases row + open Correction Obligation + the
// original Learning Attempt + its Source Event (plus the thin legacy
// mistakes mirror). Routes and workflows own HTTP concerns; this module
// owns the write. Moved out of routes/mistake-api.ts and
// routes/mistake-photo.ts as a pure refactor — zero behavior change.
//
// confirmMistakePhotoDraft() is the vision-photo confirm write core:
// session re-check + insertMistake + mistake_photo_confirmations
// receipt. findMistakePhotoConfirmation() reads that receipt back for
// the photo routes' idempotent replay.
// =====================================================================

import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { GAME_ONLY_SESSION_SUBJECT } from "./session-kind.js";
import { appendLearningAttemptSourceEvent } from "./source-events.js";
import { inferMistakeLevel } from "./mistake-level.js";
import type { DevicePrincipal } from "./device-auth.js";
import {
  findOwnedActiveSession,
  type OwnedSessionFailure,
} from "./session-queries.js";

export interface InsertMistakeInput {
  childId: string;
  problem: string;
  userAnswer: string;
  correctAnswer: string | null;
  errorType: string | null;
  source: string;
  /**
   * SB124-T03 (#127): subject label (e.g. "math", "chinese", "english").
   * The schema column was added in db-migrate.ts; this input is optional
   * (older callers like /api/game/mistake don't set it). The picker does
   * not currently filter by subject — this is just a label the parent
   * portal can group on.
   */
  subject?: string | null;
}

export interface InsertMistakeResult {
  id: number;
  caseId: string;
  created: boolean;
}

/**
 * Insert a wrong-answer row, writing the canonical mistake_cases row
 * first and then mirroring a thin mistakes-table row for the legacy
 * mistake_id used by source_events + mistake_photo FKs.
 *
 * Deduped by (child_id, problem, source) via mistake_cases — that
 * table is the new source-of-truth. The mistakes mirror is created
 * AFTER, never queried for dedupe.
 *
 * Behavior:
 *   - New tuple → INSERT mistake_cases + mistakes mirror + learning_attempt
 *     (original, is_correct=0) + correction_obligation (open).
 *     Return {id, caseId, created: true}.
 *   - Existing tuple → return the earliest existing mistake_id + its
 *     caseId with {id, caseId, created: false} (idempotent retry).
 *
 * On collision we DO NOT update user_answer / correct_answer / error_type
 * — the first wrong answer is the "authoritative" record.
 *
 * Throws if the UNIQUE collision is reported but SELECT cannot find the
 * row (impossible state, surfacing it makes the bug loud in logs).
 */
export function insertMistake(
  db: Database.Database,
  input: InsertMistakeInput,
  beforeSourceEventAppend?: (recordType: "learning_attempt") => void,
): InsertMistakeResult {
  return db.transaction(() => {
    ensureChildRow(db, input.childId);
    const sessionId = ensureActiveSession(db, input.childId);

    // v0.9 (SB124-T01 PR-B): dedupe against mistake_cases — the
    // canonical source-of-truth. The mistakes mirror is created AFTER,
    // never queried for dedupe.
    const existingCase = db.prepare(
      `SELECT case_id, original_mistake_id, opened_at, session_id,
              problem, user_answer, correct_answer, error_type, hint, level,
              image_path, vision_input, vision_reasoning, vision_model, vision_ts,
              evidence_key, evidence_status, evidence_method, evidence_confirmed_at, source
         FROM mistake_cases
        WHERE child_id = ? AND problem = ? AND source = ?
        ORDER BY opened_at, case_id LIMIT 1`,
    ).get(input.childId, input.problem, input.source) as {
      case_id: string;
      original_mistake_id: number | null;
      opened_at: number;
      session_id: string | null;
      problem: string | null;
      user_answer: string | null;
      correct_answer: string | null;
      error_type: string | null;
      hint: string | null;
      level: number | null;
      image_path: string | null;
      vision_input: string | null;
      vision_reasoning: string | null;
      vision_model: string | null;
      vision_ts: number | null;
      evidence_key: string | null;
      evidence_status: string | null;
      evidence_method: string | null;
      evidence_confirmed_at: number | null;
      source: string;
    } | undefined;
    if (existingCase) {
      // Defensive: legacy compat rows may have NULL original_mistake_id
      // (PR-A backfill pre-dates the original mistakes row). Create
      // a mirror mistake now so callers can use the case's mistake_id.
      let mistakeId = existingCase.original_mistake_id;
      if (mistakeId == null) {
        const mirror = db.prepare(`
          INSERT INTO mistakes (
            session_id, child_id, ts, problem, user_answer, correct_answer,
            error_type, hint, reviewed_count, source, level,
            image_path, vision_input, vision_reasoning, vision_model, vision_ts,
            evidence_key, evidence_status, evidence_method, evidence_confirmed_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          existingCase.session_id, input.childId, existingCase.opened_at,
          existingCase.problem, existingCase.user_answer, existingCase.correct_answer,
          existingCase.error_type, existingCase.hint, 0,
          existingCase.source, existingCase.level,
          existingCase.image_path, existingCase.vision_input, existingCase.vision_reasoning,
          existingCase.vision_model, existingCase.vision_ts,
          existingCase.evidence_key, existingCase.evidence_status,
          existingCase.evidence_method, existingCase.evidence_confirmed_at,
        );
        mistakeId = Number(mirror.lastInsertRowid);
        db.prepare(
          "UPDATE mistake_cases SET original_mistake_id = ? WHERE case_id = ?",
        ).run(mistakeId, existingCase.case_id);
      }
      return { id: mistakeId, caseId: existingCase.case_id, created: false };
    }

    const occurredAt = Date.now();
    // v0.8.x (#146/#148): infer the mistake's level at insert time.
    // Stored on the row so the picker can compare m.level <= kidLevel
    // directly instead of running a text-based heuristic on every
    // draw. Helper lives in mistake-level.ts (shared with the
    // backfill in db-migrate.ts).
    const level = inferMistakeLevel(input.problem, input.errorType ?? null);
    const caseId = `case:${randomUUID()}`;

    // 1. Mirror to mistakes table FIRST — gives the legacy mistake_id
    // that mistake_cases.original_mistake_id (NOT NULL UNIQUE) and
    // source_events / mistake_photo FKs reference. Mistakes remains
    // a thin mirror; the canonical row lives in mistake_cases.
    const mirror = db.prepare(`
      INSERT INTO mistakes (
        session_id, child_id, ts, problem, user_answer, correct_answer,
        error_type, hint, reviewed_count, source, level
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
    `).run(
      sessionId, input.childId, occurredAt, input.problem,
      input.userAnswer, input.correctAnswer, input.errorType, null,
      input.source, level,
    );
    const mistakeId = Number(mirror.lastInsertRowid);

    // 2. Write the canonical case row. original_mistake_id satisfies
    // the NOT NULL UNIQUE constraint (1 case ↔ 1 mistake).
    const caseResult = db.prepare(`
      INSERT INTO mistake_cases (
        case_id, original_mistake_id, child_id, source, opened_at,
        session_id, ts, problem, error_type, hint, level, subject,
        image_path, vision_input, vision_reasoning, vision_model, vision_ts,
        user_answer, correct_answer,
        evidence_key, evidence_status, evidence_method, evidence_confirmed_at
      ) VALUES (
        ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?, ?,
        NULL, NULL, NULL, NULL, NULL,
        ?, ?,
        NULL, NULL, NULL, NULL
      )
    `).run(
      caseId, mistakeId, input.childId, input.source, occurredAt,
      sessionId, occurredAt, input.problem, input.errorType, null, level, input.subject ?? null,
      input.userAnswer, input.correctAnswer,
    );
    if (caseResult.changes !== 1) {
      // Should not happen — caseId is UUID-unique, original_mistake_id
      // was just freshly inserted in step 1.
      throw new Error(
        `insertMistake: case INSERT failed for case_id=${caseId}, ` +
          `mistake_id=${mistakeId} — investigate schema/constraint drift`,
      );
    }

    // 3. The original learning attempt — wrong, no note.
    db.prepare(`
      INSERT INTO learning_attempts (
        attempt_id, case_id, attempt_kind, mistake_id, child_id,
        problem, user_answer, correct_answer, is_correct, occurred_at, source
      ) VALUES (?, ?, 'original', ?, ?, ?, ?, ?, 0, ?, ?)
    `).run(
      `attempt:${caseId}`,
      caseId,
      mistakeId,
      input.childId,
      input.problem,
      input.userAnswer,
      input.correctAnswer,
      occurredAt,
      input.source,
    );

    // 4. Open the correction obligation.
    db.prepare(`
      INSERT INTO correction_obligations (case_id, status, opened_at)
      VALUES (?, 'open', ?)
    `).run(caseId, occurredAt);

    beforeSourceEventAppend?.("learning_attempt");
    appendLearningAttemptSourceEvent(db, {
      mistakeId,
      childId: input.childId,
      occurredAt,
      problem: input.problem,
      submittedAnswer: input.userAnswer,
      expectedAnswer: input.correctAnswer,
      mistakeType: input.errorType,
      source: input.source,
    });
    return { id: mistakeId, caseId, created: true };
  })();
}

/**
 * Make sure a `children` row exists for this childId. In production the
 * default child is created at app startup (db-migrate.ts) and additional
 * children come from the /api/pair flow; this is a no-op for those.
 *
 * Why we still call it here: tests for cross-child isolation (e.g. AT2:
 * alice vs bob) want to POST directly without going through /api/pair
 * first. Auto-creating the row on demand makes the mistake endpoint
 * self-contained and removes a brittle test-setup step.
 */
function ensureChildRow(db: Database.Database, childId: string): void {
  const existing = db
    .prepare("SELECT id FROM children WHERE id = ?")
    .get(childId) as { id: string } | undefined;
  if (existing) return;
  db.prepare("INSERT INTO children (id, name) VALUES (?, ?)").run(
    childId,
    childId === "default" ? "小宝" : childId,
  );
}

/**
 * Find-or-create a legacy game-only session for the child. Device-owned
 * learning sessions are excluded so an unpaired game request can never
 * attach a mistake to a paired browser's active session. New rows use an
 * explicit private subject marker; the longer fallback predicate recognizes
 * old game-only rows without misclassifying a legacy study session that also
 * happened to receive one game mistake.
 */
function ensureActiveSession(db: Database.Database, childId: string): string {
  const existing = db
    .prepare(
      `SELECT s.id FROM sessions s
        WHERE s.child_id = ? AND s.device_id IS NULL AND s.ended_at IS NULL
          AND (
            s.subject = ?
            OR (
              s.subject = 'math'
              AND EXISTS (
                SELECT 1 FROM mistakes m
                 WHERE m.session_id = s.id AND m.source = 'game'
              )
              AND NOT EXISTS (SELECT 1 FROM chat_turns c WHERE c.session_id = s.id)
              AND NOT EXISTS (SELECT 1 FROM posture_events p WHERE p.session_id = s.id)
            )
          )
        ORDER BY s.started_at DESC LIMIT 1`,
    )
    .get(childId, GAME_ONLY_SESSION_SUBJECT) as { id: string } | undefined;
  if (existing) return existing.id;
  const id = randomUUID();
  db.prepare(
    "INSERT INTO sessions (id, child_id, subject) VALUES (?, ?, ?)",
  ).run(id, childId, GAME_ONLY_SESSION_SUBJECT);
  return id;
}

// =====================================================================
// Vision-photo confirm write core (moved from routes/mistake-photo.ts).
// The route keeps HTTP validation, status-code mapping, and the
// in-memory MistakePhotoWorkflow draft store (ADR-0001: the two photo
// paths are intentionally NOT merged); this is the transactional write
// that turns a reviewed draft into a Mistake Case + confirmation receipt.
// =====================================================================

export interface MistakePhotoConfirmationReceipt {
  sessionId: string;
  caseId: string;
  mistakeId: number;
  problemText: string;
  confirmationMethod: string;
}

export interface ConfirmMistakePhotoDraftInput {
  draftId: string;
  problemText: string; // normalized; route has already validated 1..2000 chars
  proposedProblem: string; // draft's proposed text — drives the method classification
  sessionId: string;
  childId: string;
  deviceId: string;
}

export interface ConfirmMistakePhotoDraftResult {
  caseId: string;
  mistakeId: number;
  problemText: string;
  confirmationMethod: "explicit_acceptance" | "explicit_correction";
}

/**
 * Thrown when the device-owned active session changes mid-confirm.
 * The route maps this to the owned-session failure status codes.
 */
export class SessionChangedError extends Error {
  constructor(readonly status: OwnedSessionFailure) {
    super("owned session changed");
  }
}

/**
 * Confirm a reviewed mistake-photo draft: re-check session ownership,
 * classify the confirmation method, write the closure-loop primary
 * tables via insertMistake(), and insert the
 * mistake_photo_confirmations receipt — all in one transaction.
 */
export function confirmMistakePhotoDraft(
  db: Database.Database,
  input: ConfirmMistakePhotoDraftInput,
  beforeSourceEventAppend?: (recordType: "learning_attempt") => void,
): ConfirmMistakePhotoDraftResult {
  const principal: DevicePrincipal = {
    childId: input.childId,
    deviceId: input.deviceId,
  };
  const method: ConfirmMistakePhotoDraftResult["confirmationMethod"] =
    input.problemText === input.proposedProblem
      ? "explicit_acceptance"
      : "explicit_correction";
  const confirmedAt = Date.now();

  return db.transaction(() => {
    const current = findOwnedActiveSession(db, input.sessionId, principal);
    if (current.status !== "ok") throw new SessionChangedError(current.status);
    // T10 mirror work (issue #166): vision confirm writes the
    // closure-loop primary tables directly via `insertMistake()`.
    // It handles dedupe by (child_id, problem, source), writes
    // mistake_cases + learning_attempts (original) +
    // correction_obligations (open), INSERTs a mistakes mirror
    // row (to keep `mistake_photo_confirmations.mistake_id` FK
    // satisfied until PR-D v2.4 drops the column), and appends
    // the learning_attempt source event.
    const insertResult = insertMistake(
      db,
      {
        childId: input.childId,
        problem: input.problemText,
        // Vision path has no typed user/correct answer — the
        // closure loop contract is "we have a wrong answer
        // worth tracking"; typed answer text arrives later
        // (issue #160 capture user answer in review).
        userAnswer: "",
        correctAnswer: "",
        errorType: "confirmed",
        source: "vision",
        subject: "math",
      },
      beforeSourceEventAppend,
    );
    const mistakeId = insertResult.id;
    db.prepare(
      `INSERT OR IGNORE INTO mistake_photo_confirmations
         (draft_id, mistake_id, session_id, child_id, device_id,
          confirmation_method, confirmed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      input.draftId,
      mistakeId,
      input.sessionId,
      input.childId,
      input.deviceId,
      method,
      confirmedAt,
    );
    return {
      caseId: insertResult.caseId,
      mistakeId,
      problemText: input.problemText,
      confirmationMethod: method,
    };
  })();
}

/**
 * Look up the confirmation receipt for a draftId (idempotent replay of
 * the photo confirm route). Returns null when the draft has not been
 * confirmed.
 */
export function findMistakePhotoConfirmation(
  db: Database.Database,
  draftId: string,
): MistakePhotoConfirmationReceipt | null {
  const row = db.prepare(
    `SELECT c.session_id AS sessionId, mc.case_id AS caseId, m.id AS mistakeId,
            m.problem AS problemText,
            c.confirmation_method AS confirmationMethod
       FROM mistake_photo_confirmations c
       JOIN mistakes m ON m.id = c.mistake_id
       JOIN mistake_cases mc ON mc.original_mistake_id = m.id
      WHERE c.draft_id = ?`,
  ).get(draftId) as MistakePhotoConfirmationReceipt | undefined;
  return row ?? null;
}
