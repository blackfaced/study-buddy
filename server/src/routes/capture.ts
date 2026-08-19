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
