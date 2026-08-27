// server/src/routes/mistake-api.ts
// =====================================================================
// SB124-T10 #134: the legacy /api/game/mistake* endpoints are
// deprecated. The closure loop (mistake_cases + correction_obligations
// + learning_attempts) is the source of truth; this file now exposes
// the canonical `insertMistake()` write helper plus 410-only stubs
// for the retired game routes.
//
// Replacements:
//   POST /api/game/mistake          → POST /api/capture/manual
//   POST /api/game/mistake-review   → POST /api/capture/case/:caseId/attempt
//
// The 410 stubs advertise the X-Sunset header so clients can render
// a clear "this is retired" message during the sunset window.
// `insertMistake()` is the canonical closure-loop write path used by
// capture.ts, game-sync, and the integration tests.
// =====================================================================

import type { Express, Request, Response } from "express";
import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { GAME_ONLY_SESSION_SUBJECT } from "../session-kind.js";
import { appendLearningAttemptSourceEvent } from "../source-events.js";
// PR-D: ensureMistakeCompatibility removed (PR #153 made mistake_cases
// the source of truth; the compat bridge is dead code).
import { inferMistakeLevel } from "../mistake-level.js";

export interface MistakeRouteDeps {
  db: Database.Database;
  beforeSourceEventAppend?: (recordType: "learning_attempt") => void;
}

export function registerMistakeRoutes(app: Express, _deps: MistakeRouteDeps): void {
  // T10 #134: registerMistakeRoutes is now a 410-only stub. The
  // closure-loop surface lives in routes/capture.ts and the
  // /api/capture/case/:caseId/attempt endpoint; this stub exists
  // so the legacy /api/game/mistake* paths still return a clean
  // 410 + replacement path during the sunset window. We accept
  // (and ignore) the deps so the existing wiring in app.ts keeps
  // working.

  // ============== T10 #134: deprecate the old game endpoints ==============
  // The closure loop (mistake_cases + correction_obligations +
  // learning_attempts) is the source of truth as of SB124-T01.
  // The /api/game/mistake and /api/game/mistake-review routes
  // still used the pre-T1 contract (mistakes table + reviewed_count
  // CAS + 3-cascade-delete). They now return 410 Gone with the
  // replacement path so existing v0.5 clients can be migrated
  // before the sunset date.
  //
  // X-Sunset header advertises the official removal date for
  // client-side caching. Replacements are stable closure-loop
  // routes that already ship.
  const GAME_ENDPOINT_SUNSET = "2026-12-31";
  const goneWithReplacement = (
    res: Response,
    replacement: string,
  ): Response => {
    res.setHeader("X-Sunset", GAME_ENDPOINT_SUNSET);
    return res.status(410).json({
      error: "this endpoint was retired in SB124-T10; use the closure-loop replacement",
      replacement,
    });
  };

  app.post("/api/game/mistake", (_req: Request, res: Response) => {
    goneWithReplacement(res, "POST /api/capture/manual");
  });

  app.post("/api/game/mistake-review", (_req: Request, res: Response) => {
    goneWithReplacement(
      res,
      "POST /api/capture/case/:caseId/attempt",
    );
  });
}

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
 *     (original, is_correct=0) + correction_obligation (open, reviewed_count=0).
 *     Return {id, caseId, created: true}.
 *   - Existing tuple → return the earliest existing mistake_id + its
 *     caseId with {id, caseId, created: false} (idempotent retry).
 *
 * On collision we DO NOT update user_answer / correct_answer / error_type
 * — the first wrong answer is the "authoritative" record. reviewed_count
 * is only mutated by T3's CAS path.
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
        // reviewed_count lives on correction_obligations; for the
        // mirror we need to read it from there if it exists.
        const reviewedCount = (db
          .prepare("SELECT reviewed_count FROM correction_obligations WHERE case_id = ?")
          .get(existingCase.case_id) as { reviewed_count: number } | undefined)?.reviewed_count ?? 0;
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
          existingCase.error_type, existingCase.hint, reviewedCount,
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

    // 4. Open correction obligation with reviewed_count=0.
    db.prepare(`
      INSERT INTO correction_obligations (case_id, status, opened_at, reviewed_count)
      VALUES (?, 'open', ?, 0)
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
