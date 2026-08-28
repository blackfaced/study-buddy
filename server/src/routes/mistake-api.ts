// server/src/routes/mistake-api.ts
// =====================================================================
// Compat-adapter home for the legacy game clients
// (candy-math-island, multiplication-drill).
//
//   POST /api/game/mistake         — adapter over insertMistake()
//   POST /api/game/mistake-review  — adapter over recordCorrectionAttempt()
//
// SB124-T10 briefly retired both endpoints to 410-only stubs; that was
// reversed because these are the ONLY production clients of the routes
// and their error handling silently drops queued data on any non-2xx —
// the sunset window protected nobody and lost every game wrong answer
// and in-quiz re-attempt. The adapters are the long-lived contract;
// they delegate to the same closure-loop write paths (mistake_cases +
// correction_obligations + learning_attempts) as the capture UI.
//
// `insertMistake()` is the canonical closure-loop write path used by
// capture.ts, game-sync, and the integration tests.
// =====================================================================

import type { Express, Request, Response } from "express";
import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { GAME_ONLY_SESSION_SUBJECT } from "../session-kind.js";
import { appendLearningAttemptSourceEvent } from "../source-events.js";
import { recordCorrectionAttempt } from "../attempt-recorder.js";
import type { Logger } from "../logger.js";
// PR-D: ensureMistakeCompatibility removed (PR #153 made mistake_cases
// the source of truth; the compat bridge is dead code).
import { inferMistakeLevel } from "../mistake-level.js";

export interface MistakeRouteDeps {
  db: Database.Database;
  beforeSourceEventAppend?: (recordType: "learning_attempt") => void;
  logger?: Logger;
}

interface MistakeRequestBody {
  childId?: unknown;
  problem?: unknown;
  userAnswer?: unknown;
  correctAnswer?: unknown;
  errorType?: unknown;
}

export function registerMistakeRoutes(app: Express, deps: MistakeRouteDeps): void {
  const { db } = deps;

  // ============== POST /api/game/mistake ==============
  // Compat adapter over insertMistake() for the legacy game clients
  // (candy-math-island, multiplication-drill). Contract (issue #98):
  //
  //   201 {id, caseId, created: true}   new case inserted
  //   200 {id, caseId, created: false}  idempotent dedupe hit
  //   400 {error}                       missing/invalid required fields
  //
  // The route owns the canonical `game` source so client labels cannot
  // partition deduplication.
  app.post("/api/game/mistake", (req: Request, res: Response) => {
    const body: MistakeRequestBody = (req.body ?? {}) as MistakeRequestBody;

    // childId defaults to "default" for backwards compat with old clients
    // that don't know about per-child mistake tracking. Empty string also
    // collapses to the default (defensive — empty childId is meaningless).
    const childId =
      typeof body.childId === "string" && body.childId.length > 0
        ? body.childId
        : "default";

    // problem is the dedupe key (paired with childId and the canonical
    // route-owned source category by the UNIQUE index).
    // Reject missing/non-string early so we never INSERT a NULL problem.
    if (!isBoundedText(body.problem, 200)) {
      res.status(400).json({ error: "problem is required" });
      return;
    }

    // userAnswer is required so the agent can see what the kid typed.
    if (!isBoundedText(body.userAnswer, 100, true)) {
      res.status(400).json({ error: "userAnswer is required" });
      return;
    }

    const correctAnswer =
      typeof body.correctAnswer === "string" ? body.correctAnswer : null;
    const errorType = typeof body.errorType === "string" ? body.errorType : null;
    // App identity is not a learning-evidence category. This route owns the
    // canonical `game` source so client labels cannot partition deduplication
    // or disappear from game-only weak-topic aggregation.
    const source = "game";
    if (
      (correctAnswer !== null && !isBoundedText(correctAnswer, 100, true)) ||
      (errorType !== null && !isBoundedText(errorType, 64, true))
    ) {
      res.status(400).json({ error: "attempt fields exceed the source contract" });
      return;
    }

    let result: InsertMistakeResult;
    try {
      result = insertMistake(
        db,
        {
          childId,
          problem: body.problem,
          userAnswer: body.userAnswer,
          correctAnswer,
          errorType,
          source,
        },
        deps.beforeSourceEventAppend,
      );
    } catch {
      res.status(500).json({ error: "mistake could not be recorded" });
      return;
    }

    res
      .status(result.created ? 201 : 200)
      .json({ id: result.id, caseId: result.caseId, created: result.created });
  });

  // ============== POST /api/game/mistake-review ==============
  // Compat adapter over recordCorrectionAttempt() for the legacy game
  // clients' in-quiz re-attempts of due mistakes. Body:
  //
  //   { childId?, results: [{ mistakeId: number, correct: boolean,
  //                           userAnswer?: string }] }
  //
  // Each result resolves its case via mistake_cases.original_mistake_id
  // and records a correction attempt (attempt_id prefix "review-game").
  // correct=true also verifies the obligation and drops the legacy
  // mistakes mirror row; correct=false leaves the obligation open.
  //
  // Batch semantics: once the top-level body is well-formed the
  // endpoint ALWAYS returns 200 with per-result statuses —
  // {results: [{mistakeId, status: "recorded"|"skipped"}]} — because
  // clients drop their whole queue on any non-2xx, so a single bad
  // row must not fail the batch. 400 is reserved for a malformed
  // top-level body. Skips (case not found, child mismatch, obligation
  // already verified) are warn-logged.
  app.post("/api/game/mistake-review", (req: Request, res: Response) => {
    const body = (req.body ?? {}) as { childId?: unknown; results?: unknown };

    const childId =
      typeof body.childId === "string" && body.childId.length > 0
        ? body.childId
        : "default";

    if (!Array.isArray(body.results)) {
      res.status(400).json({ error: "results array is required" });
      return;
    }

    const results: Array<{ mistakeId: number | null; status: "recorded" | "skipped" }> = [];
    const skip = (mistakeId: number, reason: string): void => {
      deps.logger?.warn("game mistake-review result skipped", {
        mistakeId,
        childId,
        reason,
      });
      results.push({ mistakeId, status: "skipped" });
    };

    for (const raw of body.results) {
      if (
        !raw ||
        typeof raw !== "object" ||
        typeof (raw as Record<string, unknown>).mistakeId !== "number" ||
        typeof (raw as Record<string, unknown>).correct !== "boolean"
      ) {
        // Malformed entry: report it as skipped (never silently drop —
        // the response is the only feedback channel the client has) and
        // warn-log so the bad producer shows up in logs.
        const rawId = (raw as Record<string, unknown> | null)?.mistakeId;
        const entryId = typeof rawId === "number" ? rawId : null;
        deps.logger?.warn("game mistake-review result skipped", {
          mistakeId: entryId,
          childId,
          reason: "malformed entry",
        });
        results.push({ mistakeId: entryId, status: "skipped" });
        continue;
      }
      const r = raw as { mistakeId: number; correct: boolean; userAnswer?: unknown };

      const caseRow = db
        .prepare(
          "SELECT case_id AS caseId, child_id AS childId FROM mistake_cases WHERE original_mistake_id = ?",
        )
        .get(r.mistakeId) as { caseId: string; childId: string } | undefined;
      if (!caseRow) {
        skip(r.mistakeId, "case not found");
        continue;
      }
      if (caseRow.childId !== childId) {
        skip(r.mistakeId, "case belongs to another child");
        continue;
      }

      const outcome = recordCorrectionAttempt(db, {
        caseId: caseRow.caseId,
        childId,
        isCorrect: r.correct,
        userAnswer: typeof r.userAnswer === "string" ? r.userAnswer : null,
        attemptIdPrefix: "review-game",
      });
      if (outcome.outcome === "recorded") {
        results.push({ mistakeId: r.mistakeId, status: "recorded" });
      } else if (outcome.outcome === "already-verified") {
        // Idempotent retry: obligation already closed — don't append a
        // duplicate attempt, tell the client to drop the queue entry.
        skip(r.mistakeId, "obligation already verified");
      } else {
        // Case vanished between resolution and the transactional fetch.
        skip(r.mistakeId, "case not found");
      }
    }

    res.json({ results });
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

export function isBoundedText(
  value: unknown,
  maxLength: number,
  allowEmpty = false,
): value is string {
  return (
    typeof value === "string" &&
    value.length <= maxLength &&
    (allowEmpty || value.length > 0) &&
    // oxlint-disable-next-line no-control-regex -- intentional: reject control chars in user input
    !/[\u0000-\u001f\u007f]/.test(value)
  );
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
