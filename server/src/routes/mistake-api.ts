// server/src/routes/mistake-api.ts
// =====================================================================
// POST /api/game/mistake — auto-record wrong answers as mistakes.
// =====================================================================
//
// Issue #98 (T1 of #34 split): the server-side foundation that lets
// the client POST a wrong answer and have it deduped per (childId,
// problem) via a UNIQUE index. Response shape:
//
//   201 {id: number, created: true}   when a new row was inserted
//   200 {id: number, created: false}  when the row already existed (idempotent)
//   400 {error: string}               when required fields are missing
//
// T2 (#99) and T3 (#100) build on this contract: T2 fetches due
// mistakes via /api/game/quiz-context, T3 increments reviewed_count
// and cascade-deletes after 3 corrects. Both are independent of
// this endpoint's request/response shape, so they can land in any
// order after T1.
//
// Note on session_id: the existing `mistakes.session_id` column is
// NOT NULL because the schema was designed for study-buddy chat
// mistakes (where every mistake belongs to a chat session). Auto-
// recorded game mistakes are not associated with any chat session,
// so we synthesize a placeholder ("_auto_mistake_<childId>") that
// is recognizable in queries and satisfies the NOT NULL constraint.
// A future schema migration could split mistakes into chat / game
// streams, but that's out of scope for T1.
// =====================================================================

import type { Express, Request, Response } from "express";
import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";

export interface MistakeRouteDeps {
  db: Database.Database;
}

interface MistakeRequestBody {
  childId?: unknown;
  problem?: unknown;
  userAnswer?: unknown;
  correctAnswer?: unknown;
  errorType?: unknown;
  source?: unknown;
}

export function registerMistakeRoutes(app: Express, deps: MistakeRouteDeps): void {
  const { db } = deps;

  app.post("/api/game/mistake", (req: Request, res: Response) => {
    const body: MistakeRequestBody = (req.body ?? {}) as MistakeRequestBody;

    // childId defaults to "default" for backwards compat with old clients
    // that don't know about per-child mistake tracking. Empty string also
    // collapses to the default (defensive — empty childId is meaningless).
    const childId =
      typeof body.childId === "string" && body.childId.length > 0
        ? body.childId
        : "default";

    // problem is the dedupe key (paired with childId by the UNIQUE index).
    // Reject missing/non-string early so we never INSERT a NULL problem.
    if (typeof body.problem !== "string" || body.problem.length === 0) {
      res.status(400).json({ error: "problem is required" });
      return;
    }

    // userAnswer is required so the agent can see what the kid typed.
    if (typeof body.userAnswer !== "string") {
      res.status(400).json({ error: "userAnswer is required" });
      return;
    }

    const result = insertMistake(db, {
      childId,
      problem: body.problem,
      userAnswer: body.userAnswer,
      correctAnswer:
        typeof body.correctAnswer === "string" ? body.correctAnswer : null,
      errorType: typeof body.errorType === "string" ? body.errorType : null,
      source: typeof body.source === "string" ? body.source : "game",
    });

    res
      .status(result.created ? 201 : 200)
      .json({ id: result.id, created: result.created });
  });
}

export interface InsertMistakeInput {
  childId: string;
  problem: string;
  userAnswer: string;
  correctAnswer: string | null;
  errorType: string | null;
  source: string;
}

export interface InsertMistakeResult {
  id: number;
  created: boolean;
}

/**
 * Insert a wrong-answer row into `mistakes` deduped by (child_id, problem).
 *
 * Behavior:
 *   - New (child_id, problem) pair → INSERT, return {id, created: true}
 *   - Existing (child_id, problem) pair → UNIQUE conflict, return the
 *     existing id with {id, created: false} (idempotent retry)
 *
 * On collision we DO NOT update user_answer / correct_answer / error_type
 * — the first wrong answer is the "authoritative" record. The 30% mix
 * picker (T2) reads reviewed_count for staleness; reviewed_count is only
 * mutated by T3's CAS path.
 *
 * Throws if the UNIQUE collision is reported but SELECT cannot find the
 * row (impossible state, surfacing it makes the bug loud in logs).
 */
export function insertMistake(
  db: Database.Database,
  input: InsertMistakeInput,
): InsertMistakeResult {
  ensureChildRow(db, input.childId);
  const sessionId = ensureActiveSession(db, input.childId);
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO mistakes (
      session_id, child_id, problem, user_answer, correct_answer, error_type, source
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const result = stmt.run(
    sessionId,
    input.childId,
    input.problem,
    input.userAnswer,
    input.correctAnswer,
    input.errorType,
    input.source,
  );
  if (result.changes === 1) {
    return { id: Number(result.lastInsertRowid), created: true };
  }
  // INSERT OR IGNORE skipped — the row already exists. Look up its id.
  const existing = db
    .prepare("SELECT id FROM mistakes WHERE child_id = ? AND problem = ?")
    .get(input.childId, input.problem) as { id: number } | undefined;
  if (!existing) {
    // Should be impossible: UNIQUE said we collided, but the row is gone.
    // Throwing (not returning 500 manually) lets the express error handler
    // log it once with full stack instead of swallowing a phantom dedupe.
    throw new Error(
      `insertMistake: UNIQUE collision but row not found ` +
        `(child_id=${input.childId}, problem=${input.problem})`,
    );
  }
  return { id: existing.id, created: false };
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
 * Find-or-create an active (un-ended) session for the child. Mirrors
 * the same-named helper in game-sync.ts; duplicated here so the mistake
 * module doesn't depend on the larger game-sync surface (which pulls in
 * outbox + Nexus concerns that T1 doesn't need). If we ever want one
 * source of truth, lift this to a shared sessions.ts module.
 */
function ensureActiveSession(db: Database.Database, childId: string): string {
  const existing = db
    .prepare(
      "SELECT id FROM sessions WHERE child_id = ? AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1",
    )
    .get(childId) as { id: string } | undefined;
  if (existing) return existing.id;
  const id = randomUUID();
  db.prepare(
    "INSERT INTO sessions (id, child_id, subject) VALUES (?, ?, ?)",
  ).run(id, childId, "math");
  return id;
}
