// server/src/routes/session.ts
// =====================================================================
// Session route module — extracted from app.ts (refactor PR 3).
// =====================================================================
//
// Owns:
//   - POST /api/session/start
//   - POST /api/session/end
//   - GET /api/session/active
//
// findOwnedActiveSession lives in ../session-queries.js (the non-route
// home for the shared session-ownership seam, so domain modules like
// capture-service don't import from route files).
//
// /start supersedes only the same device's active session for the same child;
// /end aggregates the events logged during that exact owned session.
//
// Public API: registerSessionRoutes(app, { db, logger, auth })
// =====================================================================
import crypto from "node:crypto";
import type { Express, Request, Response } from "express";
import type Database from "better-sqlite3";
import type { Logger } from "../logger.js";
import {
  devicePrincipal,
  type DeviceRequestAuthenticator,
} from "../device-auth.js";
import {
  appendLearningSessionSourceEvent,
  appendSourceWithdrawal,
  type StudySessionPayloadInput,
} from "../source-events.js";
import { GAME_ONLY_SESSION_SUBJECT } from "../session-kind.js";
import {
  findOwnedActiveSession,
  type OwnedSessionFailure,
} from "../session-queries.js";

export interface SessionRouteDeps {
  db: Database.Database;
  logger: Logger;
  auth: DeviceRequestAuthenticator;
}

export function requireOwnedActiveSession(
  req: Request,
  res: Response,
  db: Database.Database,
): { id: string; child_id: string } | null {
  const candidate = req.body?.sessionId ?? req.query?.sessionId;
  const sessionId = typeof candidate === "string" ? candidate : "";
  if (!sessionId) {
    res.status(400).json({ error: "sessionId is required" });
    return null;
  }
  const result = findOwnedActiveSession(db, sessionId, devicePrincipal(res));
  if (result.status !== "ok") {
    respondOwnedSessionFailure(res, result.status);
    return null;
  }
  return result.session;
}

export function respondOwnedSessionFailure(
  res: Response,
  status: OwnedSessionFailure,
): Response {
  if (status === "not-found") return res.status(404).json({ error: "session not found" });
  if (status === "forbidden") {
    return res.status(403).json({ error: "session does not belong to device" });
  }
  return res.status(409).json({ error: "session is not active" });
}

/**
 * Mount the session routes on the given Express app.
 */
export function registerSessionRoutes(app: Express, deps: SessionRouteDeps): void {
  const { db, logger, auth } = deps;

  app.get("/api/session/active", auth.requireDevice, (_req: Request, res: Response) => {
    const device = devicePrincipal(res);
    const session = db.prepare(
      `SELECT id AS sessionId, child_id AS childId, subject, started_at AS startedAt
         FROM sessions
        WHERE device_id = ? AND child_id = ? AND ended_at IS NULL
        ORDER BY started_at DESC LIMIT 1`,
    ).get(device.deviceId, device.childId) as
      | { sessionId: string; childId: string; subject: string | null; startedAt: number }
      | undefined;
    return res.json({ session: session ?? null });
  });

  // ============== 开始会话 ==============
  app.post("/api/session/start", auth.requireDevice, (req: Request, res: Response) => {
    const { childId = "default", subject } = req.body ?? {};
    const device = devicePrincipal(res);
    if (childId !== device.childId) {
      return res.status(403).json({ error: "child does not belong to device" });
    }
    const startedAt = Date.now();
    let sessionId: string;
    try {
      sessionId = db.transaction(() => {
        const active = db.prepare(
          `SELECT id, child_id FROM sessions
            WHERE ended_at IS NULL AND child_id = ? AND device_id = ?
            ORDER BY started_at DESC LIMIT 1`,
        ).get(childId, device.deviceId) as { id: string; child_id: string } | undefined;
        if (active) completeSession(db, active.id, startedAt);
        adoptLegacySessions(db, childId, device.deviceId, startedAt);
        const id = crypto.randomUUID();
        db.prepare(
          `INSERT INTO sessions (id, child_id, device_id, subject, started_at)
           VALUES (?, ?, ?, ?, ?)`,
        ).run(id, childId, device.deviceId, subject || null, startedAt);
        return id;
      })();
    } catch {
      return res.status(500).json({ error: "session could not be started" });
    }

    logger.info("session started", { sessionId, childId, subject });
    res.json({ sessionId, childId, subject, startedAt });
  });

  // ============== 结束会话 ==============
  app.post("/api/session/end", auth.requireDevice, (req: Request, res: Response) => {
    const device = devicePrincipal(res);
    const requestedId = typeof req.body?.sessionId === "string"
      ? req.body.sessionId
      : null;
    if (!requestedId) return res.status(400).json({ error: "sessionId is required" });
    const session = db.prepare(
      "SELECT id, child_id, device_id FROM sessions WHERE id = ?",
    ).get(requestedId) as
      | { id: string; child_id: string; device_id: string | null }
      | undefined;
    if (!session) return res.status(404).json({ error: "session not found" });
    if (session.child_id !== device.childId || session.device_id !== device.deviceId) {
      return res.status(403).json({ error: "session does not belong to device" });
    }

    try {
      res.json(completeSession(db, session.id, Date.now()));
    } catch {
      res.status(500).json({ error: "session could not be completed" });
    }
  });

  app.patch("/api/session/:sessionId", auth.requireDevice, (req: Request, res: Response) => {
    const sessionId = Array.isArray(req.params.sessionId)
      ? req.params.sessionId[0]
      : req.params.sessionId;
    const correction = parseSessionCorrection(req.body);
    if (!correction) {
      return res.status(400).json({ error: "invalid session correction" });
    }
    if (!isOwnedSession(db, sessionId, devicePrincipal(res))) {
      return res.status(403).json({ error: "session does not belong to device" });
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

  app.delete("/api/session/:sessionId", auth.requireDevice, (req: Request, res: Response) => {
    const sessionId = Array.isArray(req.params.sessionId)
      ? req.params.sessionId[0]
      : req.params.sessionId;
    if (!isOwnedSession(db, sessionId, devicePrincipal(res))) {
      return res.status(403).json({ error: "session does not belong to device" });
    }
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

/**
 * Close pre-pairing active sessions and bind every legacy session that has a
 * published Source Event to the first paired device that starts a new epoch.
 * This prevents nullable-device sessions from becoming active or corrective
 * orphans after the ownership boundary is enabled.
 */
function adoptLegacySessions(
  db: Database.Database,
  childId: string,
  deviceId: string,
  endedAt: number,
): void {
  const activeLegacy = db.prepare(
    `SELECT s.id FROM sessions s
      WHERE s.child_id = ? AND s.device_id IS NULL AND s.ended_at IS NULL
        AND COALESCE(s.subject, '') <> ?
        AND NOT (
          COALESCE(s.subject, '') = 'math'
          AND EXISTS (
            SELECT 1 FROM mistakes m
             WHERE m.session_id = s.id AND m.source = 'game'
          )
          AND NOT EXISTS (SELECT 1 FROM chat_turns c WHERE c.session_id = s.id)
          AND NOT EXISTS (SELECT 1 FROM posture_events p WHERE p.session_id = s.id)
        )
      ORDER BY s.started_at ASC`,
  ).all(childId, GAME_ONLY_SESSION_SUBJECT) as Array<{ id: string }>;
  for (const session of activeLegacy) completeSession(db, session.id, endedAt);
  db.prepare(
    `UPDATE sessions SET device_id = ?
      WHERE child_id = ? AND device_id IS NULL AND source_revision > 0`,
  ).run(deviceId, childId);
}

function isOwnedSession(
  db: Database.Database,
  sessionId: string,
  device: { deviceId: string; childId: string },
): boolean {
  const owned = db.prepare(
    `SELECT 1 FROM sessions
      WHERE id = ? AND child_id = ? AND device_id = ?`,
  ).get(sessionId, device.childId, device.deviceId);
  if (owned) return true;
  const claimed = db.prepare(
    `UPDATE sessions SET device_id = ?
      WHERE id = ? AND child_id = ? AND device_id IS NULL
        AND source_revision > 0`,
  ).run(device.deviceId, sessionId, device.childId);
  return claimed.changes === 1;
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
