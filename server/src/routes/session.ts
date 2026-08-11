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
import {
  appendLearningSessionSourceEvent,
  appendSourceWithdrawal,
  type StudySessionPayloadInput,
} from "../source-events.js";

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
    const startedAt = Date.now();
    let sessionId: string;
    try {
      sessionId = db.transaction(() => {
        const active = getActiveSession(db);
        if (active) completeSession(db, active.id, startedAt);
        const id = crypto.randomUUID();
        db.prepare(
          "INSERT INTO sessions (id, child_id, subject, started_at) VALUES (?, ?, ?, ?)"
        ).run(id, childId, subject || null, startedAt);
        return id;
      })();
    } catch {
      return res.status(500).json({ error: "session could not be started" });
    }

    logger.info("session started", { sessionId, childId, subject });
    res.json({ sessionId, childId, subject, startedAt });
  });

  // ============== 结束会话 ==============
  app.post("/api/session/end", (req: Request, res: Response) => {
    const requestedId = typeof req.body?.sessionId === "string"
      ? req.body.sessionId
      : null;
    const session = requestedId
      ? db.prepare("SELECT id, child_id FROM sessions WHERE id = ?").get(requestedId) as
          | { id: string; child_id: string }
          | undefined
      : getActiveSession(db);
    if (!session) return res.status(400).json({ error: "no active session" });

    try {
      res.json(completeSession(db, session.id, Date.now()));
    } catch {
      res.status(500).json({ error: "session could not be completed" });
    }
  });

  app.patch("/api/session/:sessionId", (req: Request, res: Response) => {
    const sessionId = Array.isArray(req.params.sessionId)
      ? req.params.sessionId[0]
      : req.params.sessionId;
    const correction = parseSessionCorrection(req.body);
    if (!correction) {
      return res.status(400).json({ error: "invalid session correction" });
    }
    try {
      const result = correctSession(db, sessionId, correction, Date.now());
      if (result === null) return res.status(404).json({ error: "session not found" });
      if (result === "not-completed") {
        return res.status(409).json({ error: "session is not completed" });
      }
      if (result === "withdrawn") {
        return res.status(409).json({ error: "session is withdrawn" });
      }
      res.json(result);
    } catch {
      res.status(500).json({ error: "session correction failed" });
    }
  });

  app.delete("/api/session/:sessionId", (req: Request, res: Response) => {
    const sessionId = Array.isArray(req.params.sessionId)
      ? req.params.sessionId[0]
      : req.params.sessionId;
    try {
      const result = withdrawSession(db, sessionId, Date.now());
      if (result === null) return res.status(404).json({ error: "session not found" });
      if (result === "not-completed") {
        return res.status(409).json({ error: "session is not completed" });
      }
      res.json(result);
    } catch {
      res.status(500).json({ error: "session withdrawal failed" });
    }
  });
}

interface SessionRow {
  id: string;
  child_id: string;
  started_at: number;
  ended_at: number | null;
  subject: string | null;
  total_minutes: number;
  avg_focus_score: number;
  posture_warning_count: number;
  offtopic_count: number;
  offtopic_recovered: number;
  source_revision: number;
  source_withdrawn_at: number | null;
}

interface SessionCorrection {
  subject?: string | null;
  totalMinutes?: number;
  avgFocusScore?: number;
  postureWarningCount?: number;
  offtopicCount?: number;
  offtopicRecovered?: number;
}

type SessionMutationResult =
  | ReturnType<typeof sessionResponse>
  | "not-completed"
  | "withdrawn"
  | null;

function completeSession(
  db: Database.Database,
  sessionId: string,
  endedAt: number,
): ReturnType<typeof sessionResponse> {
  return db.transaction(() => {
    const existing = getSessionRow(db, sessionId);
    if (!existing) throw new Error("session not found");
    if (existing.source_withdrawn_at !== null) throw new Error("session withdrawn");
    if (existing.ended_at !== null && existing.source_revision > 0) {
      return sessionResponse(existing);
    }

    const postureStats = db.prepare(
      `SELECT AVG(score) AS avg_score,
              SUM(CASE WHEN warning IS NOT NULL THEN 1 ELSE 0 END) AS warnings
       FROM posture_events WHERE session_id = ?`,
    ).get(sessionId) as { avg_score: number | null; warnings: number | null };
    const chatStats = db.prepare(
      `SELECT
         SUM(CASE WHEN role='child' AND topic='offtopic' THEN 1 ELSE 0 END) AS offtopic,
         SUM(CASE WHEN role='child' AND topic='offtopic' AND redirected=1 THEN 1 ELSE 0 END) AS recovered
       FROM chat_turns WHERE session_id = ? AND (state IS NULL OR state = 'writing')`,
    ).get(sessionId) as { offtopic: number | null; recovered: number | null };
    const durationMin = Math.max(
      1,
      Math.round((endedAt - existing.started_at) / 60_000),
    );
    db.prepare(
      `UPDATE sessions SET ended_at = ?, total_minutes = ?, avg_focus_score = ?,
         posture_warning_count = ?, offtopic_count = ?, offtopic_recovered = ?,
         source_revision = 1
       WHERE id = ?`,
    ).run(
      endedAt,
      durationMin,
      postureStats.avg_score ?? 0,
      postureStats.warnings ?? 0,
      chatStats.offtopic ?? 0,
      chatStats.recovered ?? 0,
      sessionId,
    );
    const completed = getSessionRow(db, sessionId)!;
    appendLearningSessionSourceEvent(db, {
      recordId: `session:${sessionId}`,
      childId: completed.child_id,
      occurredAt: endedAt,
      revision: 1,
      eventType: "learning_session_completed",
      payload: sessionPayload(completed),
    });
    return sessionResponse(completed);
  })();
}

function correctSession(
  db: Database.Database,
  sessionId: string,
  correction: SessionCorrection,
  occurredAt: number,
): SessionMutationResult {
  return db.transaction(() => {
    const existing = getSessionRow(db, sessionId);
    if (!existing) return null;
    if (existing.source_withdrawn_at !== null) return "withdrawn";
    if (existing.ended_at === null || existing.source_revision < 1) {
      return "not-completed";
    }
    const next = applyCorrection(existing, correction);
    if (sessionsEqual(existing, next)) return sessionResponse(existing);
    const revision = existing.source_revision + 1;
    db.prepare(
      `UPDATE sessions SET subject = ?, total_minutes = ?, avg_focus_score = ?,
         posture_warning_count = ?, offtopic_count = ?, offtopic_recovered = ?,
         source_revision = ? WHERE id = ?`,
    ).run(
      next.subject,
      next.total_minutes,
      next.avg_focus_score,
      next.posture_warning_count,
      next.offtopic_count,
      next.offtopic_recovered,
      revision,
      sessionId,
    );
    const corrected = { ...next, source_revision: revision };
    appendLearningSessionSourceEvent(db, {
      recordId: `session:${sessionId}`,
      childId: corrected.child_id,
      occurredAt,
      revision,
      eventType: "source_record_corrected",
      payload: sessionPayload(corrected),
    });
    return sessionResponse(corrected);
  })();
}

function withdrawSession(
  db: Database.Database,
  sessionId: string,
  occurredAt: number,
): SessionMutationResult {
  return db.transaction(() => {
    const existing = getSessionRow(db, sessionId);
    if (!existing) return null;
    if (existing.ended_at === null || existing.source_revision < 1) {
      return "not-completed";
    }
    if (existing.source_withdrawn_at !== null) return sessionResponse(existing);
    const revision = existing.source_revision + 1;
    db.prepare(
      "UPDATE sessions SET source_withdrawn_at = ?, source_revision = ? WHERE id = ?",
    ).run(occurredAt, revision, sessionId);
    appendSourceWithdrawal(db, {
      recordType: "learning_session",
      recordId: `session:${sessionId}`,
      childId: existing.child_id,
      occurredAt,
      revision,
    });
    return sessionResponse({
      ...existing,
      source_revision: revision,
      source_withdrawn_at: occurredAt,
    });
  })();
}

function getSessionRow(
  db: Database.Database,
  sessionId: string,
): SessionRow | undefined {
  return db.prepare("SELECT * FROM sessions WHERE id = ?").get(sessionId) as
    | SessionRow
    | undefined;
}

function sessionPayload(row: SessionRow): StudySessionPayloadInput {
  return {
    kind: "learning_session",
    sessionKind: "study",
    subject: row.subject,
    startedAt: row.started_at,
    endedAt: row.ended_at!,
    durationMinutes: row.total_minutes,
    averageFocusScore: Math.round(row.avg_focus_score),
    postureWarningCount: row.posture_warning_count,
    offTopicCount: row.offtopic_count,
    offTopicRecovered: row.offtopic_recovered,
  };
}

function sessionResponse(row: SessionRow) {
  return {
    sessionId: row.id,
    durationMin: row.total_minutes,
    avgFocusScore: Math.round(row.avg_focus_score),
    postureWarningCount: row.posture_warning_count,
    offtopicCount: row.offtopic_count,
    offtopicRecovered: row.offtopic_recovered,
    revision: row.source_revision,
    withdrawn: row.source_withdrawn_at !== null,
  };
}

function parseSessionCorrection(value: unknown): SessionCorrection | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  const allowed = [
    "subject",
    "totalMinutes",
    "avgFocusScore",
    "postureWarningCount",
    "offtopicCount",
    "offtopicRecovered",
  ];
  if (Object.keys(body).length === 0 || Object.keys(body).some((key) => !allowed.includes(key))) {
    return null;
  }
  if (
    body.subject !== undefined &&
    body.subject !== null &&
    (typeof body.subject !== "string" || body.subject.length > 64)
  ) return null;
  if (!optionalInteger(body.totalMinutes, 1, 1440)) return null;
  if (!optionalNumber(body.avgFocusScore, 0, 100)) return null;
  if (!optionalInteger(body.postureWarningCount, 0, 10_000)) return null;
  if (!optionalInteger(body.offtopicCount, 0, 10_000)) return null;
  if (!optionalInteger(body.offtopicRecovered, 0, 10_000)) return null;
  return body as SessionCorrection;
}

function optionalInteger(value: unknown, min: number, max: number): boolean {
  return value === undefined ||
    (typeof value === "number" && Number.isInteger(value) && value >= min && value <= max);
}

function optionalNumber(value: unknown, min: number, max: number): boolean {
  return value === undefined ||
    (typeof value === "number" && Number.isFinite(value) && value >= min && value <= max);
}

function applyCorrection(row: SessionRow, correction: SessionCorrection): SessionRow {
  return {
    ...row,
    subject: correction.subject === undefined ? row.subject : correction.subject,
    total_minutes: correction.totalMinutes ?? row.total_minutes,
    avg_focus_score: correction.avgFocusScore ?? row.avg_focus_score,
    posture_warning_count: correction.postureWarningCount ?? row.posture_warning_count,
    offtopic_count: correction.offtopicCount ?? row.offtopic_count,
    offtopic_recovered: correction.offtopicRecovered ?? row.offtopic_recovered,
  };
}

function sessionsEqual(left: SessionRow, right: SessionRow): boolean {
  return left.subject === right.subject &&
    left.total_minutes === right.total_minutes &&
    left.avg_focus_score === right.avg_focus_score &&
    left.posture_warning_count === right.posture_warning_count &&
    left.offtopic_count === right.offtopic_count &&
    left.offtopic_recovered === right.offtopic_recovered;
}
