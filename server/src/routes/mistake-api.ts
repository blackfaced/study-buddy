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
// `insertMistake()` — the canonical Mistake Case write path — lives in
// ../capture-service.js. This file keeps only the HTTP compat adapters
// and the isBoundedText() request-validation helper.
// =====================================================================

import type { Express, Request, Response } from "express";
import type Database from "better-sqlite3";
import { recordCorrectionAttempt } from "../attempt-recorder.js";
import type { Logger } from "../logger.js";
// PR-D: ensureMistakeCompatibility removed (PR #153 made mistake_cases
// the source of truth; the compat bridge is dead code).
import {
  insertMistake,
  type InsertMistakeResult,
} from "../capture-service.js";

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
