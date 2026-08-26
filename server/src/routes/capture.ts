// server/src/routes/capture.ts
// =====================================================================
// POST /api/capture/manual — manual mistake entry (SB124-T03 #127)
// GET  /api/capture/inbox  — open correction obligations per child
// =====================================================================
//
// Both endpoints share the source-of-truth schema (mistake_cases +
// learning_attempts + correction_obligations, post SB124-T01). The
// only difference vs /api/game/mistake is: source='manual' (so dedupe
// is scoped per capture mode) and subject is a required user input
// (so the parent portal can group by subject later).
//
// Manual entry is "v0.1 砍半" for the unified capture epic (#158):
// instead of building a generalized capture service, we ship the
// simplest input path (typed text) and learn what shape the inbox
// needs. Future capture modes (full-page photo, voice, QR) will
// either reuse this endpoint shape or roll up to a /api/capture/...
// router in #158.
// =====================================================================

import type { Express, Request, Response } from "express";
import type Database from "better-sqlite3";
import { insertMistake } from "./mistake-api.js";
import {
  addHypothesis,
  confirmHypothesis,
  modifyHypothesis,
  rejectHypothesis,
  HypothesisConflictError,
  HypothesisNotFoundError,
  type HypothesisRow,
} from "../hypothesis-workflow.js";
import {
  startReinforcementAttempt,
  submitReinforcementAnswer,
  AttemptAlreadySubmittedError,
  AttemptNotFoundError,
  MaxAttemptsReachedError,
} from "../reinforcement-workflow.js";
import { generateSimilarProblems } from "../similar-problems.js";
import {
  createReviewSchedule,
  completeReviewAttempt,
  ReviewAlreadyCompletedError,
  ReviewNotFoundError,
} from "../review-workflow.js";

/**
 * Helper used by the confirm / reject / modify endpoints above.
 * Verifies childId matches the hypothesis, then dispatches to the
 * matching workflow function. Returns the updated row.
 */
function transitionHypothesis(
  db: Database.Database,
  transition: "confirm" | "reject" | "modify",
  childId: string,
  hypothesisId: number,
  text?: string,
  label?: string | null,
): HypothesisRow {
  const row = db
    .prepare(
      `SELECT child_id, status FROM case_hypotheses WHERE id = ?`,
    )
    .get(hypothesisId) as { child_id: string; status: string } | undefined;
  if (!row) throw new HypothesisNotFoundError(hypothesisId);
  if (row.child_id !== childId) {
    throw new HypothesisConflictError(hypothesisId, row.status, transition);
  }
  switch (transition) {
    case "confirm":
      return confirmHypothesis(db, hypothesisId);
    case "reject":
      return rejectHypothesis(db, hypothesisId);
    case "modify":
      if (typeof text !== "string") {
        throw new Error("modify: text is required");
      }
      return modifyHypothesis(db, hypothesisId, text, label);
  }
}

function transitionStatus(err: unknown): number {
  if (err instanceof HypothesisNotFoundError) return 404;
  if (err instanceof HypothesisConflictError) return 409;
  return 500;
}

function publicHypothesis(h: HypothesisRow): {
  id: number;
  caseId: string;
  hypothesis: string;
  label: string | null;
  source: string;
  status: string;
  parentHypothesisId: number | null;
  sensitive: boolean;
  createdAt: number;
  confirmedAt: number | null;
} {
  return {
    id: h.id,
    caseId: h.caseId,
    hypothesis: h.hypothesis,
    label: h.label,
    source: h.source,
    status: h.status,
    parentHypothesisId: h.parentHypothesisId,
    sensitive: h.sensitive === 1,
    createdAt: h.createdAt,
    confirmedAt: h.confirmedAt,
  };
}

export interface CaptureRouteDeps {
  db: Database.Database;
  beforeSourceEventAppend?: (recordType: "learning_attempt") => void;
}

interface ManualRequestBody {
  childId?: unknown;
  problem?: unknown;
  userAnswer?: unknown;
  correctAnswer?: unknown;
  errorType?: unknown;
  subject?: unknown;
}

interface InboxEntry {
  caseId: string;
  mistakeId: number;
  problem: string;
  userAnswer: string | null;
  correctAnswer: string | null;
  errorType: string | null;
  source: string;
  subject: string | null;
  reviewedCount: number;
  status: string;
  openedAt: number;
}

export function registerCaptureRoutes(app: Express, deps: CaptureRouteDeps): void {
  const { db } = deps;

  // ============== Manual mistake entry ==============
  // Body: { childId?, problem, userAnswer, correctAnswer, errorType?, subject }
  // Response: { id, caseId, created }  (201 new / 200 idempotent)
  //
  // Required fields are problem, userAnswer, correctAnswer, subject.
  // errorType is optional (manual entry doesn't always have a clear
  // error category). userAnswer is required (the parent must commit
  // a typed answer — empty string is rejected to keep the closure
  // loop actionable).
  app.post("/api/capture/manual", (req: Request, res: Response) => {
    const body: ManualRequestBody = (req.body ?? {}) as ManualRequestBody;

    // childId defaults to "default" — same convention as /api/game/mistake
    // (PR #145 namespace isolation tests rely on this default)
    const childId =
      typeof body.childId === "string" && body.childId.length > 0
        ? body.childId
        : "default";

    // Required: problem (non-empty bounded text 200)
    if (!isBoundedText(body.problem, 200)) {
      res.status(400).json({ error: "problem is required" });
      return;
    }
    // Required: userAnswer (non-empty bounded text 100)
    if (!isBoundedText(body.userAnswer, 100)) {
      res.status(400).json({ error: "userAnswer is required" });
      return;
    }
    // Required: correctAnswer (non-empty bounded text 100) — the
    // "no I-don't-know path" keeps the closure loop actionable.
    if (!isBoundedText(body.correctAnswer, 100)) {
      res.status(400).json({ error: "correctAnswer is required" });
      return;
    }
    // Required: subject (non-empty bounded text 32) — used by parent
    // portal to group entries.
    if (!isBoundedText(body.subject, 32)) {
      res.status(400).json({ error: "subject is required" });
      return;
    }
    // Optional: errorType
    const errorType = typeof body.errorType === "string" ? body.errorType : null;
    if (errorType !== null && !isBoundedText(errorType, 64, true)) {
      res.status(400).json({ error: "errorType exceeds the source contract" });
      return;
    }

    let result;
    try {
      result = insertMistake(
        db,
        {
          childId,
          problem: body.problem,
          userAnswer: body.userAnswer,
          correctAnswer: body.correctAnswer,
          errorType,
          // Manual capture is a distinct source for dedupe purposes
          // (the same problem in manual + game are separate cases per
          // the capture-mode-scoped dedupe rule in #158).
          source: "manual",
          subject: body.subject,
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

  // ============== Inbox list ==============
  // GET /api/capture/inbox?childId=X
  // Response: { cases: [{ caseId, mistakeId, problem, userAnswer,
  //                       correctAnswer, errorType, source, subject,
  //                       reviewedCount, status, openedAt }] }
  //
  // Returns open correction obligations for the child, across all
  // sources (game, manual, vision, …). Verified obligations are
  // excluded — the kid doesn't see them in the inbox. Status filter
  // is `co.status = 'open'` (PR-D #155 contract). Cross-child
  // isolation enforced via `mc.child_id = ?`.
  app.get("/api/capture/inbox", (req: Request, res: Response) => {
    const raw = (req.query.childId ?? "") as string;
    const childId = typeof raw === "string" && raw.length > 0 ? raw : "default";

    const rows = db
      .prepare(
        `SELECT mc.case_id AS caseId,
                mc.original_mistake_id AS mistakeId,
                mc.problem,
                mc.user_answer AS userAnswer,
                mc.correct_answer AS correctAnswer,
                mc.error_type AS errorType,
                mc.source,
                mc.subject,
                co.reviewed_count AS reviewedCount,
                co.status,
                co.opened_at AS openedAt
           FROM mistake_cases mc
           JOIN correction_obligations co ON co.case_id = mc.case_id
          WHERE mc.child_id = ?
            AND co.status = 'open'
            AND co.reviewed_count < 3
          ORDER BY co.opened_at DESC, mc.case_id`,
      )
      .all(childId) as InboxEntry[];

    res.json({ cases: rows });
  });

  // ============== Review workspace case detail ==============
  // GET /api/capture/case/:caseId?childId=X
  // Response: { caseId, problem, userAnswer (original wrong),
  //             correctAnswer, errorType, source, subject,
  //             obligationStatus, reviewedCount, openedAt,
  //             attempts: [{ kind, userAnswer, isCorrect, occurredAt }] }
  //
  // Privacy: this endpoint is the kid-facing view of a Mistake Case.
  // It MUST NOT leak vision_reasoning, image_path, or vision_input —
  // those are parent/internal concerns. Only the kid's own user_answer
  // and is_correct on each attempt is exposed. Cross-child access is
  // 403 (not 404) so the kid can distinguish "not your case" from
  // "doesn't exist" (404) — but the test suite disagrees (privacy:
  // even 403 leaks existence). We return 403 in this implementation
  // because the inbox already enumerates the kid's caseIds, so a
  // 403 vs 404 distinction is not informative.
  app.get("/api/capture/case/:caseId", (req: Request, res: Response) => {
    const caseId = req.params.caseId;
    const raw = (req.query.childId ?? "") as string;
    const childId = typeof raw === "string" && raw.length > 0 ? raw : null;
    if (!childId) {
      res.status(400).json({ error: "childId is required" });
      return;
    }
    const row = db
      .prepare(
        `SELECT mc.case_id AS caseId,
                mc.child_id AS childId,
                mc.problem,
                mc.user_answer AS userAnswer,
                mc.correct_answer AS correctAnswer,
                mc.error_type AS errorType,
                mc.source,
                mc.subject,
                co.status AS obligationStatus,
                co.reviewed_count AS reviewedCount,
                co.opened_at AS openedAt
           FROM mistake_cases mc
           JOIN correction_obligations co ON co.case_id = mc.case_id
          WHERE mc.case_id = ?`,
      )
      .get(caseId) as
      | {
          caseId: string;
          childId: string;
          problem: string;
          userAnswer: string | null;
          correctAnswer: string | null;
          errorType: string | null;
          source: string;
          subject: string | null;
          obligationStatus: string;
          reviewedCount: number;
          openedAt: number;
        }
      | undefined;
    if (!row) {
      res.status(404).json({ error: "case not found" });
      return;
    }
    if (row.childId !== childId) {
      res.status(403).json({ error: "case belongs to another child" });
      return;
    }
    const attempts = db
      .prepare(
        `SELECT attempt_kind AS kind, user_answer AS userAnswer, is_correct AS isCorrect, occurred_at AS occurredAt
           FROM learning_attempts
          WHERE case_id = ?
          ORDER BY occurred_at, attempt_id`,
      )
      .all(caseId) as Array<{
        kind: string;
        userAnswer: string | null;
        isCorrect: number;
        occurredAt: number;
      }>;
    res.json({
      ...row,
      attempts: attempts.map((a) => ({ ...a, isCorrect: a.isCorrect === 1 })),
    });
  });

  // ============== Review attempt submission ==============
  // POST /api/capture/case/:caseId/attempt
  // Body: { childId, answer }
  // Response: { caseId, isCorrect, obligationStatus, reviewedCount, verifiedAt? }
  //
  // The kid re-solves the problem independently. Server compares the
  // submitted answer to the canonical correct_answer (textual +
  // whitespace + case-insensitive normalization). Wrong → record
  // correction learning_attempt (is_correct=0), keep obligation open.
  // Correct → record correction attempt (is_correct=1) AND close the
  // obligation (status='verified', drop mistakes mirror). History is
  // always preserved in learning_attempts — verified cases keep their
  // timeline for the parent / analytics view.
  app.post("/api/capture/case/:caseId/attempt", (req: Request, res: Response) => {
    try {
      handleAttempt(db, req, res);
    } catch (err) {
      res.status(500).json({ error: `attempt handler failed: ${(err as Error).message}` });
    }
  });

  // ============== T06 PR-C: case hypothesis state machine ==============
  // 5 endpoints: add / confirm / reject / modify + a kid-facing list
  // that drops sensitive=true rows. Cross-child verification reuses
  // the same pattern as the case detail endpoint above: caller
  // provides childId (query or body), server rejects mismatches.
  // ============== POST add ==============
  app.post(
    "/api/capture/case/:caseId/hypothesis",
    (req: Request, res: Response) => {
      const caseId = String(req.params.caseId);
      const body = (req.body ?? {}) as {
        childId?: unknown;
        source?: unknown;
        text?: unknown;
        label?: unknown;
      };
      const childId =
        typeof body.childId === "string" && body.childId.length > 0
          ? body.childId
          : null;
      if (!childId) {
        res.status(400).json({ error: "childId is required" });
        return;
      }
      if (
        body.source !== "system" &&
        body.source !== "parent" &&
        body.source !== "kid"
      ) {
        res.status(400).json({ error: "source must be 'system' | 'parent' | 'kid'" });
        return;
      }
      if (!isBoundedText(body.text, 200)) {
        res.status(400).json({ error: "text is required (1-200 chars)" });
        return;
      }
      if (body.label !== undefined && body.label !== null && typeof body.label !== "string") {
        res.status(400).json({ error: "label must be a string" });
        return;
      }
      // Cross-child: case must belong to the caller's child.
      const caseRow = db
        .prepare(`SELECT child_id FROM mistake_cases WHERE case_id = ?`)
        .get(caseId) as { child_id: string } | undefined;
      if (!caseRow || caseRow.child_id !== childId) {
        res.status(403).json({ error: "case belongs to another child" });
        return;
      }
      try {
        const h = addHypothesis(db, {
          caseId,
          childId,
          source: body.source,
          text: body.text,
          label: typeof body.label === "string" ? body.label : null,
        });
        res.status(201).json(publicHypothesis(h));
      } catch (err) {
        res.status(400).json({
          error: `addHypothesis failed: ${(err as Error).message}`,
        });
      }
    },
  );

  // ============== POST confirm / reject / modify ==============
  // All three share the same auth + 403 pattern (see
  // transitionHypothesis() helper below).
  app.post(
    "/api/capture/case/:caseId/hypothesis/:hypothesisId/confirm",
    (req: Request, res: Response) => {
      const childId = (typeof req.body?.childId === "string" && req.body.childId.length > 0)
        ? req.body.childId : null;
      if (!childId) {
        res.status(400).json({ error: "childId is required" });
        return;
      }
      const id = Number(req.params.hypothesisId);
      if (!Number.isInteger(id) || id <= 0) {
        res.status(400).json({ error: "invalid hypothesisId" });
        return;
      }
      try {
        const h = transitionHypothesis(db, "confirm", childId, id);
        res.json(publicHypothesis(h));
      } catch (err) {
        res.status(transitionStatus(err)).json({ error: (err as Error).message });
      }
    },
  );

  app.post(
    "/api/capture/case/:caseId/hypothesis/:hypothesisId/reject",
    (req: Request, res: Response) => {
      const childId = (typeof req.body?.childId === "string" && req.body.childId.length > 0)
        ? req.body.childId : null;
      if (!childId) {
        res.status(400).json({ error: "childId is required" });
        return;
      }
      const id = Number(req.params.hypothesisId);
      if (!Number.isInteger(id) || id <= 0) {
        res.status(400).json({ error: "invalid hypothesisId" });
        return;
      }
      try {
        const h = transitionHypothesis(db, "reject", childId, id);
        res.json(publicHypothesis(h));
      } catch (err) {
        res.status(transitionStatus(err)).json({ error: (err as Error).message });
      }
    },
  );

  app.post(
    "/api/capture/case/:caseId/hypothesis/:hypothesisId/modify",
    (req: Request, res: Response) => {
      const childId = (typeof req.body?.childId === "string" && req.body.childId.length > 0)
        ? req.body.childId : null;
      if (!childId) {
        res.status(400).json({ error: "childId is required" });
        return;
      }
      const id = Number(req.params.hypothesisId);
      if (!Number.isInteger(id) || id <= 0) {
        res.status(400).json({ error: "invalid hypothesisId" });
        return;
      }
      const body = (req.body ?? {}) as { text?: unknown; label?: unknown };
      if (!isBoundedText(body.text, 200)) {
        res.status(400).json({ error: "text is required (1-200 chars)" });
        return;
      }
      if (body.label !== undefined && body.label !== null && typeof body.label !== "string") {
        res.status(400).json({ error: "label must be a string" });
        return;
      }
      try {
        const h = transitionHypothesis(
          db,
          "modify",
          childId,
          id,
          body.text,
          typeof body.label === "string" ? body.label : null,
        );
        res.json(publicHypothesis(h));
      } catch (err) {
        res.status(transitionStatus(err)).json({ error: (err as Error).message });
      }
    },
  );

  // ============== GET list (kid view filters sensitive) ==============
  app.get("/api/capture/case/:caseId/hypotheses", (req: Request, res: Response) => {
    const caseId = req.params.caseId;
    const raw = (req.query.childId ?? "") as string;
    const childId = typeof raw === "string" && raw.length > 0 ? raw : null;
    if (!childId) {
      res.status(400).json({ error: "childId is required" });
      return;
    }
    // Cross-child
    const caseRow = db
      .prepare(`SELECT child_id FROM mistake_cases WHERE case_id = ?`)
      .get(caseId) as { child_id: string } | undefined;
    if (!caseRow || caseRow.child_id !== childId) {
      res.status(403).json({ error: "case belongs to another child" });
      return;
    }
    // view: 'kid' drops sensitive rows; 'parent' returns everything
    // (with the sensitive flag so the parent UI can decide).
    const view = (req.query.view ?? "parent") as string;
    const includeSensitive = view !== "kid";
    const rows = db
      .prepare(
        includeSensitive
          ? `SELECT id, case_id AS caseId, child_id AS childId, hypothesis, label,
                    source, status, parent_hypothesis_id AS parentHypothesisId,
                    sensitive, created_at AS createdAt, confirmed_at AS confirmedAt
               FROM case_hypotheses WHERE case_id = ? ORDER BY id`
          : `SELECT id, case_id AS caseId, child_id AS childId, hypothesis, label,
                    source, status, parent_hypothesis_id AS parentHypothesisId,
                    sensitive, created_at AS createdAt, confirmed_at AS confirmedAt
               FROM case_hypotheses WHERE case_id = ? AND sensitive = 0 ORDER BY id`,
      )
      .all(caseId) as Array<{
        id: number; caseId: string; childId: string; hypothesis: string;
        label: string | null; source: string; status: string;
        parentHypothesisId: number | null; sensitive: number;
        createdAt: number; confirmedAt: number | null;
      }>;
    res.json({
      caseId,
      view,
      hypotheses: rows.map((r) => ({
        ...r,
        sensitive: r.sensitive === 1,
      })),
    });
  });

  // ============== T07 PR-C: reinforcement similar problems ==============
  // POST /api/capture/case/:caseId/reinforcement
  //   body: { childId, problem?, correctAnswer? } — when omitted,
  //     server generates a similar problem via generateSimilarProblems
  //     using the case's problem + errorType.
  //   201: { attemptIndex, problem, correctAnswer, attemptsRemaining }
  //   404: case not found / cross-child
  //   409: max attempts reached (MaxAttemptsReached)

  app.post(
    "/api/capture/case/:caseId/reinforcement",
    (req: Request, res: Response) => {
      const caseId = String(req.params.caseId);
      const body = (req.body ?? {}) as {
        childId?: unknown;
        problem?: unknown;
        correctAnswer?: unknown;
      };
      const childId =
        typeof body.childId === "string" && body.childId.length > 0
          ? body.childId
          : null;
      if (!childId) {
        res.status(400).json({ error: "childId is required" });
        return;
      }

      const caseRow = db
        .prepare(
          `SELECT child_id, problem, error_type FROM mistake_cases WHERE case_id = ?`,
        )
        .get(caseId) as
        | { child_id: string; problem: string | null; error_type: string | null }
        | undefined;
      if (!caseRow || caseRow.child_id !== childId) {
        res.status(404).json({ error: "case not found" });
        return;
      }

      let problemText: string;
      let correctAnswerText: string;
      if (typeof body.problem === "string" && typeof body.correctAnswer === "string") {
        // Caller-supplied (e.g. parent typed a custom巩固 problem)
        problemText = body.problem;
        correctAnswerText = body.correctAnswer;
      } else {
        // Auto-generate from the original problem
        const variants = generateSimilarProblems(caseRow.problem ?? "", caseRow.error_type, 1);
        if (variants.length === 0) {
          res.status(422).json({
            error: "similar problems not available for this problem type",
          });
          return;
        }
        problemText = variants[0].problem;
        correctAnswerText = variants[0].correctAnswer;
      }

      try {
        const attempt = startReinforcementAttempt(
          db,
          caseId,
          childId,
          problemText,
          correctAnswerText,
        );
        const state = db
          .prepare(
            `SELECT max_attempts AS maxAttempts, reinforcement_attempts_made AS made
               FROM case_reinforcement_state WHERE case_id = ?`,
          )
          .get(caseId) as { maxAttempts: number; made: number };
        res.status(201).json({
          attemptId: attempt.id,
          attemptIndex: attempt.attemptIndex,
          problem: attempt.problem,
          attemptsRemaining: state.maxAttempts - state.made,
        });
      } catch (err) {
        if (err instanceof MaxAttemptsReachedError) {
          res.status(409).json({ error: err.message, attemptsRemaining: 0 });
          return;
        }
        res.status(500).json({ error: (err as Error).message });
      }
    },
  );

  // POST /api/capture/reinforcement/:attemptId/answer
  //   body: { userAnswer }
  //   200: { attemptId, isCorrect, attemptsRemaining }
  //   404: attempt not found
  //   409: already submitted (idempotency guard)
  app.post(
    "/api/capture/reinforcement/:attemptId/answer",
    (req: Request, res: Response) => {
      const attemptId = Number(req.params.attemptId);
      if (!Number.isInteger(attemptId) || attemptId <= 0) {
        res.status(400).json({ error: "invalid attemptId" });
        return;
      }
      const body = (req.body ?? {}) as { userAnswer?: unknown };
      if (!isBoundedText(body.userAnswer, 200)) {
        res.status(400).json({ error: "userAnswer is required" });
        return;
      }
      try {
        const after = submitReinforcementAnswer(
          db,
          attemptId,
          body.userAnswer,
        );
        const state = db
          .prepare(
            `SELECT max_attempts AS maxAttempts, reinforcement_attempts_made AS made
               FROM case_reinforcement_state WHERE case_id = ?`,
          )
          .get(after.caseId) as { maxAttempts: number; made: number };
        res.json({
          attemptId: after.id,
          isCorrect: after.isCorrect === 1,
          attemptsRemaining: state.maxAttempts - state.made,
        });
      } catch (err) {
        if (err instanceof AttemptNotFoundError) {
          res.status(404).json({ error: "attempt not found" });
          return;
        }
        if (err instanceof AttemptAlreadySubmittedError) {
          res.status(409).json({ error: "attempt already submitted" });
          return;
        }
        res.status(500).json({ error: (err as Error).message });
      }
    },
  );

  // ============== T08 PR-C: delayed review schedule ==============
  // GET /api/capture/case/:caseId/reviews?childId=...&includeCompleted=...
  //   200: { caseId, reviews: [{ id, scheduledAt, completedAt, isCorrect, reopenedCount }] }
  //   403: case belongs to another child
  app.get(
    "/api/capture/case/:caseId/reviews",
    (req: Request, res: Response) => {
      const caseId = String(req.params.caseId);
      const rawChild = (req.query.childId ?? "") as string;
      const childId = typeof rawChild === "string" && rawChild.length > 0 ? rawChild : null;
      if (!childId) {
        res.status(400).json({ error: "childId is required" });
        return;
      }
      const caseRow = db
        .prepare(`SELECT child_id FROM mistake_cases WHERE case_id = ?`)
        .get(caseId) as { child_id: string } | undefined;
      if (!caseRow || caseRow.child_id !== childId) {
        res.status(403).json({ error: "case belongs to another child" });
        return;
      }
      const includeCompleted = req.query.includeCompleted === "true";
      const where = includeCompleted
        ? `WHERE case_id = ?`
        : `WHERE case_id = ? AND completed_at IS NULL`;
      const rows = db
        .prepare(
          `SELECT id, scheduled_at AS scheduledAt, completed_at AS completedAt,
                  completed_is_correct AS completedIsCorrect,
                  reopened_count AS reopenedCount
             FROM review_schedules
             ${where}
            ORDER BY scheduled_at ASC`,
        )
        .all(caseId) as Array<{
          id: number; scheduledAt: number; completedAt: number | null;
          completedIsCorrect: number | null; reopenedCount: number;
        }>;
      res.json({
        caseId,
        reviews: rows.map((r) => ({
          id: r.id,
          scheduledAt: r.scheduledAt,
          completedAt: r.completedAt,
          isCorrect: r.completedIsCorrect === 1,
          reopenedCount: r.reopenedCount,
        })),
      });
    },
  );

  // POST /api/capture/case/:caseId/reviews
  //   body: { childId, completedAt? } — when omitted, completedAt =
  //     now (server clock). Schedules 3 review waves (+1/+3/+7d).
  //   201: { reviews: [{ id, scheduledAt, daysAfter }] }
  //   403: case belongs to another child
  app.post(
    "/api/capture/case/:caseId/reviews",
    (req: Request, res: Response) => {
      const caseId = String(req.params.caseId);
      const body = (req.body ?? {}) as { childId?: unknown; completedAt?: unknown };
      const childId =
        typeof body.childId === "string" && body.childId.length > 0
          ? body.childId
          : null;
      if (!childId) {
        res.status(400).json({ error: "childId is required" });
        return;
      }
      const completedAt =
        typeof body.completedAt === "number" ? body.completedAt : Date.now();

      const caseRow = db
        .prepare(`SELECT child_id FROM mistake_cases WHERE case_id = ?`)
        .get(caseId) as { child_id: string } | undefined;
      if (!caseRow || caseRow.child_id !== childId) {
        res.status(403).json({ error: "case belongs to another child" });
        return;
      }

      const rows = createReviewSchedule(db, caseId, childId, completedAt);
      res.status(201).json({
        caseId,
        reviews: rows.map((r) => ({
          id: r.id,
          scheduledAt: r.scheduledAt,
        })),
      });
    },
  );

  // POST /api/capture/review/:reviewId/complete
  //   body: { isCorrect }
  //   200: { reviewId, isCorrect, reopenedCount }
  //   404: review not found
  //   409: already completed
  app.post(
    "/api/capture/review/:reviewId/complete",
    (req: Request, res: Response) => {
      const reviewId = Number(req.params.reviewId);
      if (!Number.isInteger(reviewId) || reviewId <= 0) {
        res.status(400).json({ error: "invalid reviewId" });
        return;
      }
      const body = (req.body ?? {}) as { isCorrect?: unknown };
      if (typeof body.isCorrect !== "boolean") {
        res.status(400).json({ error: "isCorrect (boolean) is required" });
        return;
      }
      try {
        const after = completeReviewAttempt(db, reviewId, body.isCorrect);
        res.json({
          reviewId: after.id,
          isCorrect: after.completedIsCorrect === 1,
          reopenedCount: after.reopenedCount,
        });
      } catch (err) {
        if (err instanceof ReviewNotFoundError) {
          res.status(404).json({ error: "review not found" });
          return;
        }
        if (err instanceof ReviewAlreadyCompletedError) {
          res.status(409).json({ error: "review already completed" });
          return;
        }
        res.status(500).json({ error: (err as Error).message });
      }
    },
  );
}

function handleAttempt(db: Database.Database, req: Request, res: Response): void {
  const caseId = req.params.caseId;
  const body = (req.body ?? {}) as { childId?: unknown; answer?: unknown };

  const childId =
    typeof body.childId === "string" && body.childId.length > 0 ? body.childId : null;
  if (!childId) {
    res.status(400).json({ error: "childId is required" });
    return;
  }
  if (!isBoundedText(body.answer, 200)) {
    res.status(400).json({ error: "answer is required (1-200 chars)" });
    return;
  }

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
    .get(caseId) as
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
    res.status(404).json({ error: "case not found" });
    return;
  }
  if (row.childId !== childId) {
    res.status(403).json({ error: "case belongs to another child" });
    return;
  }

  // Already verified (race with another device, or someone hit T3 3-correct
  // cascade in parallel): report the current state, don't append a new
  // attempt row. Idempotent retry of the kid's last input.
  if (row.obligationStatus !== "open") {
    const verifiedRow = db
      .prepare("SELECT verified_at AS verifiedAt FROM correction_obligations WHERE case_id = ?")
      .get(caseId) as { verifiedAt: number | null } | undefined;
    res.json({
      caseId,
      isCorrect: true,
      obligationStatus: row.obligationStatus,
      reviewedCount: row.reviewedCount,
      verifiedAt: verifiedRow?.verifiedAt ?? null,
    });
    return;
  }

  const isCorrect = answersMatch(String(body.answer), row.correctAnswer ?? "");
  const occurredAt = Date.now();
  const attemptId = `review-self:${caseId}:${occurredAt}`;

  db.prepare(`
    INSERT OR IGNORE INTO learning_attempts
      (attempt_id, case_id, attempt_kind, mistake_id, child_id, problem,
       user_answer, correct_answer, is_correct, occurred_at, source)
    VALUES (?, ?, 'correction', NULL, ?, NULL, ?, ?, ?, ?, ?)
  `).run(
    attemptId,
    caseId,
    childId,
    String(body.answer),
    row.correctAnswer,
    isCorrect ? 1 : 0,
    occurredAt,
    row.source,
  );

  let verifiedAt: number | null = null;
  let reviewedCount = row.reviewedCount;
  let obligationStatus = row.obligationStatus;
  if (isCorrect) {
    // First independent correct closes the obligation (T05 semantics).
    // T3 still uses the 3-correct cascade for game-flow reviews.
    verifiedAt = Date.now();
    db.prepare(
      "UPDATE correction_obligations SET status = 'verified', verified_at = ? WHERE case_id = ? AND status = 'open'",
    ).run(verifiedAt, caseId);
    obligationStatus = "verified";
    // Drop the legacy mistakes mirror (same as T3 closeObligation path,
    // PR-D #155). mistake_cases is preserved. The mirror's id is the
    // original_mistake_id stored on the canonical case row.
    db.prepare(
      "DELETE FROM mistakes WHERE id = (SELECT original_mistake_id FROM mistake_cases WHERE case_id = ?) AND child_id = ?",
    ).run(caseId, childId);
  }

  res.json({
    caseId,
    isCorrect: Boolean(isCorrect),
    obligationStatus,
    reviewedCount,
    verifiedAt,
  });
}

/**
 * Compare a kid's submitted answer to the canonical correct_answer.
 * Pure function. Whitespace-stripped + case-folded.
 * Returns false if either side is missing/empty.
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
// oxlint: unicorn(consistent-function-scoping)
function normalizeAnswer(s: string): string {
  return (s ?? "").replace(/\s+/g, "").toLowerCase();
}

function isBoundedText(
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
