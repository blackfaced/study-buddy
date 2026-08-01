// server/src/routes/buddy.ts
// =====================================================================
// Buddy route module — extracted from app.ts (refactor PR 2).
// =====================================================================
//
// Owns the /buddy/ surface and the cross-app child metadata:
//   - POST /api/buddy/unlock  — 4-digit PIN gate (issue #55)
//   - GET  /api/pair          — first-run pairing info
//   - POST /api/child/rename  — manual rename (issue #29)
//
// Why these three live together: they're all about "who is the kid
// using the buddy chat, and is the parent / kid allowed to use it
// right now". The pairing endpoint gives the buddy page the kid's
// name + the server URL; the unlock endpoint gates the chat; the
// rename endpoint lets the parent fix a wrong name without
// re-pairing. Different lifecycle, but the same access-control
// neighbourhood, so they sit together in one route module.
//
// Public API:
//   - registerBuddyRoutes(app, { db, httpsPort, lock, logger })
// =====================================================================
import type { Express, Request, Response } from "express";
import type Database from "better-sqlite3";
import type { BuddyLock } from "../buddy-lock.js";
import type { Logger } from "../logger.js";

export interface BuddyRouteDeps {
  db: Database.Database;
  /** HTTPS port surfaced in /api/pair.serverUrl. */
  httpsPort: number;
  /** PIN gate state. Reuse the same instance across the app. */
  lock: BuddyLock;
  logger: Logger;
}

/**
 * Mount the buddy routes on the given Express app.
 */
export function registerBuddyRoutes(app: Express, deps: BuddyRouteDeps): void {
  const { db, httpsPort, lock, logger } = deps;

  // ============== Buddy PIN gate (issue #55) ==============
  // Per-IP rate limit: 5 wrong → 5-min lockout. State is in-memory;
  // a server restart clears it (intentional — recoverable by restart).
  app.post("/api/buddy/unlock", (req: Request, res: Response) => {
    const { pin } = req.body ?? {};
    if (typeof pin !== "string") {
      return res.status(400).json({ error: "pin must be a string" });
    }
    const ip = req.ip ?? "unknown";
    const result = lock.tryUnlock({ ip, pin });
    if (result.ok) {
      return res.json({ ok: true });
    }
    if (result.reason === "wrong") {
      return res.status(401).json({ error: "wrong" });
    }
    // Locked out — also surface Retry-After so well-behaved clients
    // can back off automatically.
    res.setHeader("Retry-After", String(result.retryAfterSec));
    return res.status(429).json({ error: "locked", retryAfterSec: result.retryAfterSec });
  });

  // ============== 配对 ==============
  app.get("/api/pair", (req: Request, res: Response) => {
    const child = db.prepare("SELECT * FROM children WHERE id = 'default'").get() as
      | { id: string; name: string; grade: string }
      | undefined;
    res.json({
      childId: child?.id || "default",
      name: child?.name || "小宝",
      grade: child?.grade || "二年级",
      // Bug 1 fix: was `${PORT}` (undefined) — now uses httpsPort.
      serverUrl: `${req.protocol}://${req.hostname}:${httpsPort}`,
    });
  });

  // ============== 改名（手动）==============
  // W1 hotfix #2：父母或 buddy 页面也可以直接改名（不依赖 chat 自动检测）
  // Body: { childId?: string, name: string }
  app.post("/api/child/rename", (req: Request, res: Response) => {
    const childId = (req.body?.childId as string) || "default";
    const name = (req.body?.name as string)?.trim();
    if (!name || name.length < 1 || name.length > 10) {
      return res.status(400).json({ error: "name must be 1-10 chars" });
    }
    const child = db.prepare("SELECT * FROM children WHERE id = ?").get(childId) as
      | { id: string }
      | undefined;
    if (!child) return res.status(404).json({ error: "child not found" });
    db.prepare("UPDATE children SET name = ? WHERE id = ?").run(name, childId);
    logger.info("child name changed via /api/child/rename", { childId, newName: name });
    res.json({ childId, name });
  });
}
