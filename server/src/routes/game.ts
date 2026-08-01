// server/src/routes/game.ts
// =====================================================================
// Game route module — extracted from app.ts (refactor PR 5a).
// =====================================================================
//
// Owns the /api/game/* surface (the v0.5b platform sync endpoints):
//   - POST /api/game/mistake      — record a mistake from a hung app
//   - GET  /api/game/weak-topics  — recent weak topics for a window
//   - POST /api/game/session      — record a finished time-mode run
//   - GET  /api/game/daily        — daily stats for the parent dashboard
//
// All heavy lifting is in ./game-sync.ts (recordGameMistake,
// getGameWeakTopics, recordGameSession, getGameDailyStats). This
// module is the HTTP shell: validation + status codes + response
// shape. The data layer has its own tests (game-sync.test.ts).
//
// Public API:
//   - registerGameRoutes(app, { db, logger, outboxPath })
// =====================================================================
import type { Express, Request, Response } from "express";
import type Database from "better-sqlite3";
import type { Logger } from "../logger.js";
import { recordGameMistake, getGameWeakTopics, recordGameSession, getGameDailyStats } from "../game-sync.js";

export interface GameRouteDeps {
  db: Database.Database;
  logger: Logger;
  outboxPath: string;
}

export function registerGameRoutes(app: Express, deps: GameRouteDeps): void {
  const { db, logger, outboxPath } = deps;

  // ============== Game sync (v0.5b) ==============
  // Apps like candy-math-island POST their mistakes here. We persist to
  // the shared mistakes table (source='game') and append the same event
  // to the outbox so the Memory Nexus worker can index it asynchronously.
  app.post("/api/game/mistake", async (req: Request, res: Response) => {
    const { childId, subject, problem, errorType, userAnswer, correctAnswer, level } = req.body ?? {};
    if (
      typeof childId !== "string" ||
      typeof subject !== "string" ||
      typeof problem !== "string" ||
      typeof errorType !== "string" ||
      typeof userAnswer !== "number" ||
      typeof correctAnswer !== "number" ||
      typeof level !== "number"
    ) {
      return res.status(400).json({ error: "missing or invalid fields" });
    }
    try {
      const id = await recordGameMistake(db, outboxPath, {
        childId,
        subject,
        problem,
        errorType,
        userAnswer,
        correctAnswer,
        level,
      });
      logger.info("game mistake recorded", { mistakeId: id, errorType, level });
      res.json({ mistakeId: id });
    } catch (e: any) {
      logger.error("game mistake record failed", { error: e.message });
      res.status(500).json({ error: e.message });
    }
  });

  app.get("/api/game/weak-topics", async (req: Request, res: Response) => {
    const days = Number(req.query.days ?? 7);
    if (!Number.isFinite(days) || days <= 0) {
      return res.status(400).json({ error: "days must be a positive number" });
    }
    const topics = await getGameWeakTopics(db, days);
    res.json({ days, weakTopics: topics });
  });

  // ============== Game session (v0.6 time-mode) ==============
  // Apps POST a finished time-mode run here for daily aggregation.
  app.post("/api/game/session", async (req: Request, res: Response) => {
    const {
      childId, appId, durationSec,
      totalQuestions, correctCount,
      startedAt, endedAt,
    } = req.body ?? {};
    if (
      typeof childId !== "string" ||
      typeof appId !== "string" ||
      typeof durationSec !== "number" ||
      typeof totalQuestions !== "number" ||
      typeof correctCount !== "number" ||
      typeof startedAt !== "number" ||
      typeof endedAt !== "number"
    ) {
      return res.status(400).json({ error: "missing or invalid fields" });
    }
    try {
      const id = await recordGameSession(db, outboxPath, {
        childId, appId, durationSec,
        totalQuestions, correctCount,
        startedAt, endedAt,
      });
      const correctRate = Math.round((correctCount / totalQuestions) * 100);
      logger.info("game session recorded", {
        sessionId: id, appId, totalQuestions, correctCount, correctRate,
      });
      res.json({ sessionId: id, correctRate });
    } catch (e: any) {
      // 400 for validation errors thrown by recordGameSession (e.g. totalQuestions <= 0);
      // 500 for anything else.
      if (/must be/.test(e.message) || /not found/.test(e.message)) {
        return res.status(400).json({ error: e.message });
      }
      logger.error("game session record failed", { error: e.message });
      res.status(500).json({ error: e.message });
    }
  });

  app.get("/api/game/daily", async (req: Request, res: Response) => {
    const days = Number(req.query.days ?? 7);
    if (!Number.isFinite(days) || days <= 0) {
      return res.status(400).json({ error: "days must be a positive number" });
    }
    const appId = typeof req.query.appId === "string" ? req.query.appId : undefined;
    const daily = await getGameDailyStats(db, days, appId);
    res.json({ days, appId: appId ?? null, daily });
  });
}
