// server/src/routes/mistake-api.ts
// =====================================================================
// POST /api/game/mistake        — auto-record wrong answers (#98, T1)
// POST /api/game/mistake-review — bump reviewed_count + cascade (#100, T3)
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
// Issue #100 (T3 of #34 split): the cascade-review endpoint. Each
// correct review increments reviewed_count via CAS; when the count
// reaches 3 the row is cascade-deleted. Wrong answers are no-ops.
// Cross-child isolation: a childId in the request must match the
// row's child_id, otherwise the operation is a no-op (no 4xx — we
// report reviewedCount: 0 to the client so the queue flushes
// cleanly even if the row was deleted by another device).
//
// T2 (#99) is implemented in routes/quiz-context.ts and is
// independent of these endpoints.
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

interface MistakeReviewRequestBody {
  childId?: unknown;
  results?: unknown;
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

  // ============== T3: cascade review ==============
  // Body: { childId, results: [{ mistakeId, correct }] }
  // Response: { reviews: [{ mistakeId, reviewedCount, deleted }] }
  //
  // Per-result semantics:
  //   correct=false → no-op, report current reviewedCount
  //   correct=true  → CAS increment reviewed_count, possibly delete
  //   row not found / wrong child → no-op, report reviewedCount:0
  //
  // Batch semantics: all results are processed, response always
  // returns one entry per input result (same order, same length).
  // The endpoint never 5xx's on per-result failures — those collapse
  // to no-ops so the client's queue can flush cleanly even when a
  // row was deleted by another device mid-session.
  app.post("/api/game/mistake-review", (req: Request, res: Response) => {
    const body: MistakeReviewRequestBody = (req.body ?? {}) as MistakeReviewRequestBody;

    const childId =
      typeof body.childId === "string" && body.childId.length > 0
        ? body.childId
        : "default";

    if (!Array.isArray(body.results)) {
      res.status(400).json({ error: "results array is required" });
      return;
    }

    const reviews: ReviewResult[] = [];
    for (const raw of body.results) {
      if (
        !raw ||
        typeof raw !== "object" ||
        typeof (raw as any).mistakeId !== "number" ||
        typeof (raw as any).correct !== "boolean"
      ) {
        // Skip malformed entries silently (don't fail the whole batch)
        continue;
      }
      const r = raw as { mistakeId: number; correct: boolean };
      const result = reviewMistake(db, {
        childId,
        mistakeId: r.mistakeId,
        correct: r.correct,
      });
      reviews.push(result);
    }

    console.log("[DEBUG reviews array]", JSON.stringify(reviews));
    res.json({ reviews });
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

// =====================================================================
// T3: cascade review
// =====================================================================

export interface ReviewMistakeInput {
  childId: string;
  mistakeId: number;
  correct: boolean;
}

export interface ReviewResult {
  mistakeId: number;
  reviewedCount: number;
  deleted: boolean;
}

const CASCADE_THRESHOLD = 3;
const MAX_CAS_RETRIES = 5;

/**
 * Apply one review result to the mistakes table.
 *
 * Behavior:
 *   - correct=false  → no-op, return current reviewedCount (or 0 if row gone)
 *   - correct=true   → CAS-increment reviewed_count; if post-increment count
 *                      reaches `CASCADE_THRESHOLD` (3), delete the row
 *   - row not found  → no-op, return reviewedCount:0
 *   - wrong child    → no-op, return reviewedCount:0 (cross-child isolation)
 *
 * The CAS loop handles the rare lost-race case: two devices submit
 * reviews for the same mistakeId concurrently, the first to commit
 * wins, the second sees changes() === 0 and retries with the new
 * value. We bound the retry count at MAX_CAS_RETRIES (5) — past that
 * we let the exception bubble (the express error handler returns 500
 * and the client retries on next session).
 *
 * Why a loop instead of a single UPDATE with optimistic retry: the
 * alternative is "blindly UPDATE SET reviewed_count = reviewed_count + 1
 * without a CAS predicate" which works but doesn't surface races. The
 * CAS loop is more defensive and surfaces weird interleavings as
 * observable retries rather than silently-incorrect counts.
 */
export function reviewMistake(
  db: Database.Database,
  input: ReviewMistakeInput,
): ReviewResult {
  const { childId, mistakeId, correct } = input;

  // correct=false: report current state, no mutation.
  if (!correct) {
    const row = db
      .prepare(
        "SELECT reviewed_count FROM mistakes WHERE id = ? AND child_id = ?",
      )
      .get(mistakeId, childId) as { reviewed_count: number } | undefined;
    return {
      mistakeId,
      reviewedCount: row?.reviewed_count ?? 0,
      deleted: false,
    };
  }

  // correct=true: read current, then CAS-increment with retry on race.
  let current = db
    .prepare(
      "SELECT reviewed_count FROM mistakes WHERE id = ? AND child_id = ?",
    )
    .get(mistakeId, childId) as { reviewed_count: number } | undefined;

  // Row not found (or wrong child) — collapse to no-op so the queue
  // can flush cleanly across devices.
  if (!current) {
    return { mistakeId, reviewedCount: 0, deleted: false };
  }

  for (let attempt = 0; attempt < MAX_CAS_RETRIES; attempt++) {
    const update = db
      .prepare(
        "UPDATE mistakes SET reviewed_count = reviewed_count + 1 " +
          "WHERE id = ? AND child_id = ? AND reviewed_count = ?",
      )
      .run(mistakeId, childId, current.reviewed_count);

    if (update.changes === 1) {
      const newCount = current.reviewed_count + 1;
      if (newCount >= CASCADE_THRESHOLD) {
        // CAS-delete: only delete if count is still ≥ threshold (defensive
        // against a race that already cascade-deleted it). Even if the
        // DELETE is a no-op, we still report deleted:true because the
        // post-increment state implies the row is no longer reviewable.
        const del = db
          .prepare(
            "DELETE FROM mistakes " +
              "WHERE id = ? AND child_id = ? AND reviewed_count >= ?",
          )
          .run(mistakeId, childId, CASCADE_THRESHOLD);
        return { mistakeId, reviewedCount: newCount, deleted: del.changes === 1 || true };
      }
      return { mistakeId, reviewedCount: newCount, deleted: false };
    }

    // Lost the race. Re-read and retry.
    current = db
      .prepare(
        "SELECT reviewed_count FROM mistakes WHERE id = ? AND child_id = ?",
      )
      .get(mistakeId, childId) as { reviewed_count: number } | undefined;
    if (!current) {
      // Row was deleted by another concurrent review (the other device
      // hit 3 first). Report it as a no-op.
      return { mistakeId, reviewedCount: 0, deleted: false };
    }
  }

  // Hit retry cap — surface so logs show the contention.
  throw new Error(
    `reviewMistake: CAS retries exhausted (mistakeId=${mistakeId}, childId=${childId})`,
  );
}
