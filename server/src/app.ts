// src/app.ts
// Express app factory — extracted from index.ts so tests can construct
// a fresh app against a temporary SQLite database (no listener, no env
// side effects at import time).
//
// Bug 1 (v0.1): /api/pair referenced an undefined `PORT` symbol, so
// serverUrl came out as `https://<host>:undefined`. Fix is in the route
// below — see commit message for the regression test.

import { config as loadDotenv } from "dotenv";
import express, { type Request, type Response } from "express";
import multer from "multer";
import Database from "better-sqlite3";
import { join, resolve } from "node:path";
import { mkdirSync } from "node:fs";
import { type VisionClient, extractCharsImage } from "./vision.js";
import { requestLogger, type Logger, createLogger, stdoutSink } from "./logger.js";
import { recordGameMistake, getGameWeakTopics, recordGameSession, getGameDailyStats } from "./game-sync.js";
import { BuddyLock } from "./buddy-lock.js";
import {
  addWritingWords,
  deleteWritingWord,
  listWritingAttempts,
  listWritingWords,
  recordWritingAttempt,
} from "./write-sync.js";
import { registerPortalRoutes } from "./routes/portal.js";
import { registerSystemRoutes } from "./routes/system.js";
import { registerBuddyRoutes } from "./routes/buddy.js";
import { registerSessionRoutes } from "./routes/session.js";
import { registerChatRoutes, defaultCallMinimax, classifyTopic } from "./routes/chat.js";


loadDotenv({ path: resolve(process.cwd(), ".env") });

const WEB_DIR = process.env.WEB_DIR || resolve(process.cwd(), "../web");
const HTTPS_PORT = Number(process.env.HTTPS_PORT || 3000);

export interface AppOptions {
  db: Database.Database;
  /** Override the HTTPS port surfaced in /api/pair.serverUrl. Defaults to env HTTPS_PORT. */
  httpsPort?: number;
  /** Vision client for /api/mistake-photo. If null, the endpoint returns 503. */
  visionClient?: VisionClient | null;
  /** Directory where mistake photos are written. */
  mistakesDir?: string;
  /** Path to the Memory Nexus outbox JSONL. */
  outboxPath?: string;
  /** Logger used for request access logs and event logs. Defaults to a stdout logger. */
  logger?: Logger;
  /** Override the 4-digit PIN for /api/buddy/unlock. Defaults to env BUDDY_PIN. Empty/null = unlocked. */
  buddyPin?: string | null;
}

const OFFTOPIC_KEYWORDS = [
  "奥特曼", "汪汪队", "冰雪奇缘", "艾莎", "公主", "巴啦啦",
  "王者荣耀", "蛋仔", "原神", "我的世界", "游戏", "玩具",
  "冰淇淋", "薯片", "巧克力", "奶茶", "零食",
  "电视", "动画片", "漫画", "B站", "抖音", "小红书",
  "小狗", "小猫",
];

const EMOTION_KEYWORDS = ["不想", "不要", "烦", "累", "哭", "生气", "怕"];

function classifyTopic(text: string): "learning" | "offtopic" | "emotion" {
  const t = text.toLowerCase();
  for (const kw of OFFTOPIC_KEYWORDS) {
    if (t.includes(kw.toLowerCase())) return "offtopic";
  }
  for (const kw of EMOTION_KEYWORDS) {
    if (t.includes(kw)) return "emotion";
  }
  return "learning";
}

export function createApp(opts: AppOptions): express.Express {
  const { db } = opts;
  const httpsPort = opts.httpsPort ?? HTTPS_PORT;
  const visionClient = opts.visionClient === undefined ? null : opts.visionClient;
  const mistakesDir = opts.mistakesDir ?? resolve(process.cwd(), "data/mistakes");
  // Ensure the mistakes dir exists. No-op if it already does.
  try {
    mkdirSync(mistakesDir, { recursive: true });
  } catch {
    /* read-only fs in tests; we'll let writes fail loudly there */
  }
  const logger: Logger = opts.logger ?? createLogger({ level: "info", sinks: [stdoutSink] });
  const outboxPath =
    opts.outboxPath ?? resolve(process.cwd(), "data/nexus-outbox.jsonl");

  // 4-digit PIN gate for /buddy/ chat (issue #55). When BUDDY_PIN is
  // unset, the lock is open (dev mode); log a single warning so the
  // deploy is loud, not silent.
  const buddyPinEnv = process.env.BUDDY_PIN ?? "";
  const buddyPin = opts.buddyPin !== undefined ? opts.buddyPin : buddyPinEnv;
  // Normalize: empty string is the "unset" signal, same as null.
  const effectivePin = (buddyPin === null || buddyPin === "") ? null : buddyPin;
  if (effectivePin === null) {
    logger.warn("BUDDY_PIN not set, /buddy/ chat is unlocked (development mode)");
  }
  const buddyLock = new BuddyLock({ pin: effectivePin });

  const app = express();
  app.use(express.json({ limit: "1mb" }));

  // Access log: one entry per request, with method, path, status, durationMs.
  app.use(requestLogger(logger));

  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 500 * 1024 },
  });

  // Portal + system + buddy + session + chat routes
  // (refactor PR 1-4). The rest of app.ts can stay focused on
  // game / write / extract logic.
  registerPortalRoutes(app, WEB_DIR);
  registerSystemRoutes(app, db);
  registerBuddyRoutes(app, { db, httpsPort, lock: buddyLock, logger });
  registerSessionRoutes(app, { db, logger });
  registerChatRoutes(app, {
    db,
    logger,
    outboxPath,
    visionClient: opts.visionClient === undefined ? null : opts.visionClient,
    mistakesDir,
    upload,
    callMinimax: defaultCallMinimax,
  });

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

  // ============== Write app (issue #57) ==============
  // Per-character word library + attempt history. No PIN gate — writing
  // is a parent-supervised activity, not the kind of distraction the
  // buddy PIN is meant to block.
  app.get("/api/write/words", (_req: Request, res: Response) => {
    const words = listWritingWords(db);
    res.json({ words });
  });

  app.post("/api/write/words", (req: Request, res: Response) => {
    const { chars, addedBy } = req.body ?? {};
    if (typeof chars !== "string") {
      return res.status(400).json({ error: "chars must be a string" });
    }
    // Split the string into individual CJK characters; write-sync
    // does the per-char CJK validation + dedup.
    const arr = Array.from(chars);
    const result = addWritingWords(db, arr, typeof addedBy === "string" ? addedBy : "parent");
    res.json(result);
  });

  app.delete("/api/write/words/:char", (req: Request, res: Response) => {
    const char = String(req.params.char);
    // Defensive: only allow single CJK characters in the URL.
    if (!/^[\u4E00-\u9FFF]$/.test(char)) {
      return res.status(400).json({ error: "char must be a single CJK character" });
    }
    const removed = deleteWritingWord(db, char);
    if (!removed) return res.status(404).json({ error: "not found" });
    res.json({ ok: true });
  });

  app.get("/api/write/words/:char/attempts", (req: Request, res: Response) => {
    const char = String(req.params.char);
    if (!/^[\u4E00-\u9FFF]$/.test(char)) {
      return res.status(400).json({ error: "char must be a single CJK character" });
    }
    const rawLimit = Array.isArray(req.query.limit) ? req.query.limit[0] : req.query.limit;
    const limit = Math.min(Number(rawLimit ?? 50) || 50, 200);
    const attempts = listWritingAttempts(db, char, limit);
    res.json({ char, attempts });
  });

  app.post("/api/write/attempts", (req: Request, res: Response) => {
    const { char, level, strokePath } = req.body ?? {};
    if (typeof char !== "string" || !/^[\u4E00-\u9FFF]$/.test(char)) {
      return res.status(400).json({ error: "char must be a single CJK character" });
    }
    if (typeof level !== "number" || !Number.isFinite(level) || level < 0 || level > 1) {
      return res.status(400).json({ error: "level must be a number in [0, 1]" });
    }
    if (strokePath !== null && strokePath !== undefined && typeof strokePath !== "string") {
      return res.status(400).json({ error: "strokePath must be a string or null" });
    }
    // FK enforcement: if the char is not in the library, the INSERT
    // will fail. The client should always add to the library first.
    try {
      const id = recordWritingAttempt(db, { char, level, strokePath: strokePath ?? null });
      res.json({ attemptId: id });
    } catch (e: any) {
      res.status(400).json({ error: e.message });
    }
  });

  // v0.7 (issue #57 v0.2): extract CJK characters from a photo.
  // Powers the Mavis agent's "look at this textbook" workflow.
  app.post(
    "/api/write/extract-words",
    upload.single("image"),
    async (req: Request, res: Response) => {
      if (!visionClient) {
        return res.status(503).json({
          error: "vision not configured (MINIMAX_API_KEY not set on the server)",
        });
      }
      if (!req.file) return res.status(400).json({ error: "no image" });
      const base64 = req.file.buffer.toString("base64");
      try {
        const result = await extractCharsImage(visionClient, base64);
        res.json({ words: result.words, model: "MiniMax-M3" });
      } catch (e: any) {
        res.status(502).json({ error: `vision failed: ${e.message}` });
      }
    },
  );

  return app;
}

// ============== Apps registry re-export (study-buddy = platform) ==============
// Refactor PR 1: AppDescriptor and APPS now live in
// ./routes/portal.ts. Re-export here so existing imports of
// `import { APPS, AppDescriptor } from "./app.js"` keep working.
export type { AppDescriptor } from "./routes/portal.js";
export { APPS } from "./routes/portal.js";

// 辅助函数，给外部用（例如测试 / 文档）
export { classifyTopic };
