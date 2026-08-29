// server/src/routes/quiz-context.ts
// =====================================================================
// POST /api/game/quiz-context — fetch due-mistakes for the picker mix.
// =====================================================================
//
// Issue #99 (T2 of #34 split): the client (candy-math-island) calls
// this at the start of each session to find out (a) whether the kid is
// still inside the "first 5 sessions of today" review-mix window, and
// (b) which due mistakes (open correction obligations) to draw from.
//
// The server is the single source of truth for the per-day session
// count — kids may have 2 devices open, and a client-side count would
// drift. The client just passes its local-date string (YYYY-MM-DD) and
// trusts the server's authoritative count.
//
// Response shape:
//   200 { eligible: boolean, mistakes: MistakeForReview[] }
//   400 { error: string }  when required fields are missing
//
// `eligible: false` means the kid has hit 5+ sessions today; the
// client should drop the `mistakes` field and run the regular picker.
// `eligible: true` with `mistakes: []` means the kid is in-window but
// has no due mistakes to review — the client should still treat the
// session as a normal one (no mix, no special handling).
//
// T3 (#100) adds the `POST /api/game/mistake-review` endpoint that
// the client calls after each in-quiz re-attempt. A correct re-attempt
// verifies the obligation (via recordCorrectionAttempt), which is what
// removes the mistake from the due pool here.
//
// SB124-T01 PR-C: due-mistake pool now reads from mistake_cases JOIN
// correction_obligations (the canonical closure-loop tables). The
// mistakes mirror is bypassed for this hot path.
// =====================================================================

import type { Express, Request, Response } from "express";
import type Database from "better-sqlite3";

export interface QuizContextRouteDeps {
  db: Database.Database;
}

interface QuizContextRequestBody {
  childId?: unknown;
  date?: unknown;
}

const MAX_SESSIONS_PER_DAY = 5;
const MISTAKE_POOL_LIMIT = 20;

export function registerQuizContextRoutes(
  app: Express,
  deps: QuizContextRouteDeps,
): void {
  const { db } = deps;

  app.post("/api/game/quiz-context", (req: Request, res: Response) => {
    const body: QuizContextRequestBody = (req.body ?? {}) as QuizContextRequestBody;

    const childId =
      typeof body.childId === "string" && body.childId.length > 0
        ? body.childId
        : "default";

    // date is a YYYY-MM-DD string the client computes in its local
    // timezone. We trust it (the client owns the "day" semantic) and
    // convert it to a [start, end) ms range to filter game_sessions.
    if (typeof body.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(body.date)) {
      res.status(400).json({ error: "date is required (YYYY-MM-DD)" });
      return;
    }
    const dayStart = new Date(`${body.date}T00:00:00`).getTime();
    if (Number.isNaN(dayStart)) {
      res.status(400).json({ error: "date is not a valid calendar day" });
      return;
    }
    const dayEnd = dayStart + 24 * 60 * 60 * 1000;

    const context = getQuizContext(db, { childId, dayStart, dayEnd });
    res.json(context);
  });
}

export interface GetQuizContextInput {
  childId: string;
  /** Day window start in ms (inclusive). */
  dayStart: number;
  /** Day window end in ms (exclusive). */
  dayEnd: number;
}

export interface MistakeForReview {
  id: number;
  problem: string;
  answer: string;
  errorType: string | null;
}

export interface QuizContextResult {
  eligible: boolean;
  mistakes: MistakeForReview[];
}

/**
 * Compute the per-session quiz context: eligibility for the 30% mix
 * window and the due-mistake pool.
 *
 * `eligible` is true when the kid has started fewer than
 * `MAX_SESSIONS_PER_DAY` game_sessions in the given [dayStart, dayEnd)
 * window. After the threshold, sessions return to 100% regular
 * problems (no mix) to avoid the kid feeling every question is a
 * review of something they already failed.
 *
 * `mistakes` returns up to `MISTAKE_POOL_LIMIT` due mistakes (those
 * with status = 'open' on their correction obligation) for the child,
 * in RANDOM() order. The client draws from this pool with 30% probability
 * per question. We use RANDOM() instead of e.g. "oldest first" because
 * the picker is already drawing without replacement in spirit (the
 * client tracks which mistakes it has shown this session) — random
 * sampling keeps the pool fresh and avoids prioritizing one stale row.
 *
 * When `eligible` is false, `mistakes` is an empty array (the client
 * should ignore it anyway, but returning [] avoids leaking a pool
 * the kid has already cycled past).
 */
export function getQuizContext(
  db: Database.Database,
  input: GetQuizContextInput,
): QuizContextResult {
  const sessionCount = db
    .prepare(
      `SELECT COUNT(*) as c
         FROM game_sessions
         WHERE child_id = ? AND started_at >= ? AND started_at < ?`,
    )
    .get(input.childId, input.dayStart, input.dayEnd) as { c: number };

  if (sessionCount.c >= MAX_SESSIONS_PER_DAY) {
    return { eligible: false, mistakes: [] };
  }

  // v0.9 (SB124-T01 PR-C): read from the canonical mistake_cases
  // JOIN correction_obligations (where the obligation status lives).
  // The mistakes table is a thin mirror; this is the picker hot path
  // and must reflect the live closure-loop state.
  const rows = db
    .prepare(
      `SELECT mc.original_mistake_id AS id,
              mc.problem,
              mc.correct_answer AS answer,
              mc.error_type AS errorType
         FROM mistake_cases mc
         JOIN correction_obligations co ON co.case_id = mc.case_id
        WHERE mc.child_id = ?
          AND co.status = 'open'
        ORDER BY RANDOM()
        LIMIT ?`,
    )
    .all(input.childId, MISTAKE_POOL_LIMIT) as MistakeForReview[];

  return { eligible: true, mistakes: rows };
}
