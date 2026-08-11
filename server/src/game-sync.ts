// src/game-sync.ts
//
// Game-side mistake ingestion + aggregation for the study-buddy platform.
// Each app (currently: candy-math-island) uses the canonical mistake HTTP
// route; this module owns session persistence and read-side aggregation.
//
// Also exposes getGameWeakTopics, which the agent and the apps use to
// look at the child's recent weak areas in the game-specific stream
// (errorType = carry/borrow/sign/compute, not the study-buddy natural-
// language error_type bucket).

import { createHash } from "node:crypto";
import { appendLearningSessionSourceEvent } from "./source-events.js";

export interface GameWeakTopic {
  subject: string;
  errorType: string;
  count: number;
}

export interface GameSessionInput {
  childId: string;
  appId: string;
  durationSec: number;
  totalQuestions: number;
  correctCount: number;
  startedAt: number;
  endedAt: number;
}

export interface GameDailyStat {
  date: string;            // "2026-07-26" — local date the session started on
  sessionCount: number;
  totalQuestions: number;
  correctCount: number;
  correctRate: number;     // 0-100 (rounded)
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

/**
 * Record a finished game session (v0.6 time-mode). Persists the summary
 * (totalQuestions, correctCount, duration) to `game_sessions` and
 * commits a learning-session Source Event atomically.
 *
 * Throws on totalQuestions <= 0 (a session with no questions is almost
 * always a client bug or a child who closed the tab immediately).
 */
export async function recordGameSession(
  db: import("better-sqlite3").Database,
  input: GameSessionInput,
): Promise<number> {
  if (input.appId.length === 0 || input.appId.length > 128) {
    throw new Error("recordGameSession: appId must be between 1 and 128 characters");
  }
  if (!Number.isInteger(input.totalQuestions) || input.totalQuestions <= 0) {
    throw new Error(
      `recordGameSession: totalQuestions must be > 0 (got ${input.totalQuestions})`
    );
  }
  if (!Number.isInteger(input.correctCount) ||
    input.correctCount < 0 || input.correctCount > input.totalQuestions) {
    throw new Error(
      `recordGameSession: correctCount (${input.correctCount}) must be in [0, totalQuestions] (${input.totalQuestions})`
    );
  }
  if (!Number.isFinite(input.startedAt) || !Number.isFinite(input.endedAt) ||
    input.startedAt < 0 || input.endedAt < input.startedAt) {
    throw new Error("recordGameSession: timestamps must be finite and ordered");
  }
  if (!Number.isFinite(input.durationSec) || input.durationSec < 0) {
    throw new Error("recordGameSession: durationSec must be a non-negative number");
  }
  // Sanity: make sure the child exists (FK enforces but a friendlier error helps).
  const child = db.prepare("SELECT id FROM children WHERE id = ?").get(input.childId);
  if (!child) {
    throw new Error(`recordGameSession: child '${input.childId}' not found`);
  }

  const sourceRecordId = gameSessionSourceRecordId(input);
  return db.transaction(() => {
    const existing = db.prepare(
      `SELECT id, child_id, app_id, duration_sec, total_questions, correct_count,
              started_at, ended_at
       FROM game_sessions WHERE source_record_id = ?`,
    ).get(sourceRecordId) as {
      id: number;
      child_id: string;
      app_id: string;
      duration_sec: number;
      total_questions: number;
      correct_count: number;
      started_at: number;
      ended_at: number;
    } | undefined;
    if (existing) {
      if (!sameGameSession(existing, input)) {
        throw new Error("recordGameSession: retry conflicts with the existing session");
      }
      return existing.id;
    }
    const result = db.prepare(
      `INSERT INTO game_sessions
         (source_record_id, child_id, app_id, duration_sec, total_questions,
          correct_count, started_at, ended_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      sourceRecordId,
      input.childId,
      input.appId,
      input.durationSec,
      input.totalQuestions,
      input.correctCount,
      input.startedAt,
      input.endedAt,
    );
    const id = Number(result.lastInsertRowid);
    appendLearningSessionSourceEvent(db, {
      recordId: sourceRecordId,
      childId: input.childId,
      occurredAt: input.endedAt,
      revision: 1,
      eventType: "learning_session_completed",
      payload: {
        kind: "learning_session",
        sessionKind: "game",
        appId: input.appId,
        startedAt: input.startedAt,
        endedAt: input.endedAt,
        durationMinutes: Math.max(1, Math.round(input.durationSec / 60)),
        totalQuestions: input.totalQuestions,
        correctCount: input.correctCount,
      },
    });
    return id;
  })();
}

function gameSessionSourceRecordId(input: GameSessionInput): string {
  const stableKey = JSON.stringify([
    input.childId,
    input.appId,
    input.durationSec,
    input.totalQuestions,
    input.correctCount,
    input.startedAt,
    input.endedAt,
  ]);
  const digest = createHash("sha256").update(stableKey).digest("hex").slice(0, 32);
  return `game_session:${digest}`;
}

function sameGameSession(
  row: {
    child_id: string;
    app_id: string;
    duration_sec: number;
    total_questions: number;
    correct_count: number;
    started_at: number;
    ended_at: number;
  },
  input: GameSessionInput,
): boolean {
  return row.child_id === input.childId &&
    row.app_id === input.appId &&
    row.duration_sec === input.durationSec &&
    row.total_questions === input.totalQuestions &&
    row.correct_count === input.correctCount &&
    row.started_at === input.startedAt &&
    row.ended_at === input.endedAt;
}

/**
 * Aggregate game_sessions by local date, descending.
 * One row per day with summed totalQuestions / correctCount and
 * rounded correctRate (0-100). Optional appId filter.
 */
export async function getGameDailyStats(
  db: import("better-sqlite3").Database,
  days: number,
  appId?: string,
): Promise<GameDailyStat[]> {
  const since = Date.now() - days * 24 * 3600 * 1000;
  // date(started_at/1000, 'unixepoch', 'localtime') formats as YYYY-MM-DD
  // using the server's local timezone. Good enough for a single-user,
  // single-timezone home server.
  const rows = appId
    ? (db
        .prepare(
          `SELECT
              date(started_at/1000, 'unixepoch', 'localtime') AS day,
              COUNT(*) AS sessionCount,
              SUM(total_questions) AS totalQuestions,
              SUM(correct_count) AS correctCount
            FROM game_sessions
            WHERE started_at >= ? AND app_id = ?
            GROUP BY day
            ORDER BY day DESC`,
        )
        .all(since, appId) as Array<{
        day: string;
        sessionCount: number;
        totalQuestions: number;
        correctCount: number;
      }>)
    : (db
        .prepare(
          `SELECT
              date(started_at/1000, 'unixepoch', 'localtime') AS day,
              COUNT(*) AS sessionCount,
              SUM(total_questions) AS totalQuestions,
              SUM(correct_count) AS correctCount
            FROM game_sessions
            WHERE started_at >= ?
            GROUP BY day
            ORDER BY day DESC`,
        )
        .all(since) as Array<{
        day: string;
        sessionCount: number;
        totalQuestions: number;
        correctCount: number;
      }>);

  return rows.map((r) => ({
    date: r.day,
    sessionCount: r.sessionCount,
    totalQuestions: r.totalQuestions,
    correctCount: r.correctCount,
    correctRate:
      r.totalQuestions > 0
        ? Math.round((r.correctCount / r.totalQuestions) * 100)
        : 0,
  }));
}
