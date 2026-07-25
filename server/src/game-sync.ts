// src/game-sync.ts
//
// Game-side mistake ingestion + aggregation for the study-buddy platform.
// Each app (currently: candy-math-island) POSTs a mistake here; we persist
// it into the shared mistakes table (with source='game') and append the
// same payload to the outbox so the loose-coupled Nexus worker can
// index it asynchronously.
//
// Also exposes getGameWeakTopics, which the agent and the apps use to
// look at the child's recent weak areas in the game-specific stream
// (errorType = carry/borrow/sign/compute, not the study-buddy natural-
// language error_type bucket).

import { randomUUID } from "node:crypto";
import { appendOutbox, type OutboxEntry } from "./outbox.js";

export interface GameMistakeInput {
  childId: string;
  subject: string;
  problem: string;
  errorType: string;
  userAnswer: number;
  correctAnswer: number;
  level: number;
}

export interface GameWeakTopic {
  subject: string;
  errorType: string;
  count: number;
}

/**
 * Record a mistake from a game. Persists it as a mistakes row with
 * source='game' and an active session (auto-created if none exists).
 * Also appends a math_mistake entry to the outbox for the Nexus worker.
 * Returns the inserted mistake id.
 */
export async function recordGameMistake(
  db: import("better-sqlite3").Database,
  outboxPath: string,
  input: GameMistakeInput,
): Promise<number> {
  const sessionId = ensureActiveSession(db, input.childId);
  const result = db
    .prepare(
      `INSERT INTO mistakes
         (session_id, subject, problem, error_type, user_answer, correct_answer, source)
       VALUES (?, ?, ?, ?, ?, ?, 'game')`
    )
    .run(
      sessionId,
      input.subject,
      input.problem,
      input.errorType,
      String(input.userAnswer),
      String(input.correctAnswer),
    );
  const id = Number(result.lastInsertRowid);

  // Append to the outbox so the Nexus worker can index it without
  // blocking this request. Failure to write the outbox is best-effort
  // — we don't want a stuck disk to fail a mistake save.
  try {
    const entry: OutboxEntry = {
      id: "e_" + randomUUID(),
      ts: Date.now(),
      kind: "math_mistake",
      entityId: childEntityId(input.childId),
      payload: {
        subject: input.subject,
        problem: input.problem,
        errorType: input.errorType,
        userAnswer: input.userAnswer,
        correctAnswer: input.correctAnswer,
        level: input.level,
        source: "game",
        mistakeId: id,
      },
    };
    await appendOutbox(outboxPath, [entry]);
  } catch {
    /* outbox write failure is non-fatal — the SQLite row is the
     * source of truth; the worker can be backfilled later. */
  }

  return id;
}

/**
 * Aggregate recent game mistakes (default 7 days) by (subject, errorType).
 * Returned in count-desc order. Only counts source='game' rows.
 */
export async function getGameWeakTopics(
  db: import("better-sqlite3").Database,
  days: number,
): Promise<GameWeakTopic[]> {
  const since = Date.now() - days * 24 * 3600 * 1000;
  return db
    .prepare(
      `SELECT subject, error_type as errorType, COUNT(*) as count
         FROM mistakes
         WHERE source = 'game' AND ts >= ?
         GROUP BY subject, error_type
         ORDER BY count DESC
         LIMIT 20`,
    )
    .all(since) as GameWeakTopic[];
}

/** Get-or-create the active session for this child. Auto-starts on demand. */
function ensureActiveSession(db: import("better-sqlite3").Database, childId: string): string {
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

function childEntityId(childId: string): string {
  return `child:${childId}`;
}
