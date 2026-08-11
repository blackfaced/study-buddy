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
import { resolve } from "node:path";
import { mkdirSync } from "node:fs";
import { type VisionClient } from "./vision.js";
import { requestLogger, type Logger, createLogger, stdoutSink } from "./logger.js";
import { BuddyLock } from "./buddy-lock.js";
import { registerPortalRoutes } from "./routes/portal.js";
import { registerSystemRoutes } from "./routes/system.js";
import { registerBuddyRoutes } from "./routes/buddy.js";
import { registerSessionRoutes } from "./routes/session.js";
import {
  registerChatRoutes,
  defaultCallMinimax,
  classifyTopic,
  type CallMinimax,
} from "./routes/chat.js";
import { registerGameRoutes } from "./routes/game.js";
import { registerWriteRoutes } from "./routes/write.js";
import { registerWhoamiRoutes } from "./routes/whoami.js";
import { registerMistakeRoutes } from "./routes/mistake-api.js";
import { registerQuizContextRoutes } from "./routes/quiz-context.js";
import { registerIntegrationRoutes } from "./routes/integration.js";
import { DeviceAuth, type DeviceRequestAuthenticator } from "./device-auth.js";
import { registerPairingRoutes } from "./routes/pairing.js";

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
  /** @deprecated Compatibility-only; active request paths no longer write JSONL. */
  outboxPath?: string;
  /** Logger used for request access logs and event logs. Defaults to a stdout logger. */
  logger?: Logger;
  /** Override the 4-digit PIN for /api/buddy/unlock. Defaults to env BUDDY_PIN. Empty/null = unlocked. */
  buddyPin?: string | null;
  /** Independent credential for loopback-only provider integration APIs. */
  integrationToken?: string | null;
  /** Test seam for the socket-level loopback policy. */
  integrationLoopbackCheck?: (req: Request) => boolean;
  /** Test seam for local-only pairing-code issuance. */
  pairingLoopbackCheck?: (req: Request) => boolean;
  /** Test seam for pairing expiry and credential timestamps. */
  deviceAuthNow?: () => number;
  /** Test seam for the HTTPS-or-loopback device credential policy. */
  deviceSecureTransportCheck?: (req: Request) => boolean;
  /** Injected request authenticator for route-isolated tests. */
  deviceAuthenticator?: DeviceRequestAuthenticator;
  /** Test seam for chat completion; production defaults to MiniMax. */
  callMinimax?: CallMinimax;
  /** Throw-only test seam; the real immutable writer always runs afterward. */
  beforeSourceEventAppend?: (recordType: "learning_attempt") => void;
}

const OFFTOPIC_KEYWORDS = [
  "奥特曼", "汪汪队", "冰雪奇缘", "艾莎", "公主", "巴啦啦",
  "王者荣耀", "蛋仔", "原神", "我的世界", "游戏", "玩具",
  "冰淇淋", "薯片", "巧克力", "奶茶", "零食",
  "电视", "动画片", "漫画", "B站", "抖音", "小红书",
  "小狗", "小猫",
];

const EMOTION_KEYWORDS = ["不想", "不要", "烦", "累", "哭", "生气", "怕"];

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
  const deviceAuth = new DeviceAuth({
    db,
    now: opts.deviceAuthNow,
    isSecureRequest: opts.deviceSecureTransportCheck,
  });
  const deviceAuthenticator = opts.deviceAuthenticator ?? deviceAuth;

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
  registerPairingRoutes(app, {
    auth: deviceAuth,
    isLoopback: opts.pairingLoopbackCheck,
    now: opts.deviceAuthNow,
    isSecureRequest: opts.deviceSecureTransportCheck,
  });
  registerBuddyRoutes(app, { db, httpsPort, lock: buddyLock, logger });
  registerSessionRoutes(app, { db, logger, auth: deviceAuthenticator });
  registerChatRoutes(app, {
    db,
    logger,
    visionClient: opts.visionClient === undefined ? null : opts.visionClient,
    mistakesDir,
    upload,
    callMinimax: opts.callMinimax ?? defaultCallMinimax,
    auth: deviceAuthenticator,
  });

  // Game + write + extract routes
  // (refactor PR 5). The rest of app.ts is glue + re-exports.
  registerGameRoutes(app, { db, logger });
  registerWriteRoutes(app, {
    db,
    logger,
    mistakesDir,
    visionClient: opts.visionClient === undefined ? null : opts.visionClient,
  });
  registerWhoamiRoutes(app, { db, version: "0.1.0", auth: deviceAuthenticator });
  registerMistakeRoutes(app, {
    db,
    beforeSourceEventAppend: opts.beforeSourceEventAppend,
  });
  registerQuizContextRoutes(app, { db });
  const integrationToken =
    opts.integrationToken === undefined
      ? (process.env.INTEGRATION_API_TOKEN ?? null)
      : opts.integrationToken;
  registerIntegrationRoutes(app, {
    db,
    token: integrationToken,
    isLoopback: opts.integrationLoopbackCheck,
  });

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
