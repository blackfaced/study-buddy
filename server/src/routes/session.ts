// server/src/routes/session.ts
// =====================================================================
// Session route module — extracted from app.ts (refactor PR 3).
// =====================================================================
//
// Owns:
//   - POST /api/session/start
//   - POST /api/session/end
//   - getActiveSession(db)         shared helper used by chat/frame
//   - getOrCreateActiveSession(db) shared helper used by chat/frame/mistake
//
// The two helpers are exported because other route modules (chat,
// frame, mistake) need to "find or start" an active session before
// logging events. Centralising them here keeps the rule in one
// place: "the active session is the most recent row where
// ended_at IS NULL; create one if none exists".
//
// Why these routes sit together: both are about the lifecycle of
// a single study-buddy session. /start closes the previous one
// and opens a new one; /end aggregates the events logged during
// the session (posture focus scores, offtopic chat counts) into
// the row so the parent dashboard has the rollup.
//
// Public API:
//   - getActiveSession(db)
//   - getOrCreateActiveSession(db)
//   - registerSessionRoutes(app, { db, logger })
// =====================================================================
import crypto from "node:crypto";
import type { Express, Request, Response } from "express";
import type Database from "better-sqlite3";
import type { Logger } from "../logger.js";

export interface SessionRouteDeps {
  db: Database.Database;
  logger: Logger;
}

/** Read the most recent active session row, or undefined if none. */
export function getActiveSession(db: Database.Database):
  | { id: string; child_id: string; subject?: string | null }
  | undefined {
  return db
    .prepare(
      "SELECT id, child_id FROM sessions WHERE ended_at IS NULL ORDER BY started_at DESC LIMIT 1"
    )
    .get() as { id: string; child_id: string } | undefined;
}

/**
 * Get the active session, or auto-create one for the default child if
 * none exists. Lets the kid keep chatting / logging events after a
 * previous session was ended (e.g. after "写完啦"), instead of getting
 * 400 "no active session".
 *
 * Mirrors the `ensureActiveSession` pattern used by recordGameMistake
 * in game-sync.ts. Session stays open until a real /api/session/end
 * call.
 */
export function getOrCreateActiveSession(db: Database.Database): { id: string; child_id: string } {
  const existing = getActiveSession(db);
  if (existing) return existing;
  const id = crypto.randomUUID();
  db.prepare(
    "INSERT INTO sessions (id, child_id, subject) VALUES (?, ?, ?)"
  ).run(id, "default", null);
  return { id, child_id: "default" };
}

/**
 * Mount the session routes on the given Express app.
 */
export function registerSessionRoutes(app: Express, deps: SessionRouteDeps): void {
  const { db, logger } = deps;

  // ============== 开始会话 ==============
  app.post("/api/session/start", (req: Request, res: Response) => {
    const { childId = "default", subject } = req.body;
    db.prepare(
      "UPDATE sessions SET ended_at = strftime('%s','now')*1000 WHERE ended_at IS NULL"
    ).run();

    const sessionId = crypto.randomUUID();
    db.prepare(
      "INSERT INTO sessions (id, child_id, subject) VALUES (?, ?, ?)"
    ).run(sessionId, childId, subject || null);

    logger.info("session started", { sessionId, childId, subject });
    res.json({ sessionId, childId, subject, startedAt: Date.now() });
  });

  // ============== 结束会话 ==============
  app.post("/api/session/end", (_req: Request, res: Response) => {
    const session = getActiveSession(db);
    if (!session) return res.status(400).json({ error: "no active session" });

    const endedAt = Date.now();
    const sess = db.prepare("SELECT * FROM sessions WHERE id = ?").get(session.id) as
      | { id: string; started_at: number };
    const durationMin = Math.max(1, Math.round((endedAt - sess.started_at) / 60000));

    const postureStats = db
      .prepare(
        `SELECT COUNT(*) as count, AVG(score) as avg_score,
                SUM(CASE WHEN warning IS NOT NULL THEN 1 ELSE 0 END) as warnings
         FROM posture_events WHERE session_id = ?`
      )
      .get(session.id) as { avg_score: number | null; warnings: number | null };

    const chatStats = db
      .prepare(
        `SELECT
          SUM(CASE WHEN role='child' AND topic='offtopic' THEN 1 ELSE 0 END) as offtopic,
          SUM(CASE WHEN role='child' AND topic='offtopic' AND redirected=1 THEN 1 ELSE 0 END) as recovered
         FROM chat_turns WHERE session_id = ? AND (state IS NULL OR state = 'writing')`
      )
      .get(session.id) as { offtopic: number | null; recovered: number | null };

    db.prepare(
      `UPDATE sessions SET
         ended_at = ?, total_minutes = ?, avg_focus_score = ?,
         posture_warning_count = ?, offtopic_count = ?, offtopic_recovered = ?
       WHERE id = ?`
    ).run(
      endedAt,
      durationMin,
      postureStats.avg_score || 0,
      postureStats.warnings || 0,
      chatStats.offtopic || 0,
      chatStats.recovered || 0,
      session.id
    );

    res.json({
      sessionId: session.id,
      durationMin,
      avgFocusScore: Math.round(postureStats.avg_score || 0),
      postureWarningCount: postureStats.warnings || 0,
      offtopicCount: chatStats.offtopic || 0,
      offtopicRecovered: chatStats.recovered || 0,
    });
  });
}
