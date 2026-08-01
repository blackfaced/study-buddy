// server/src/routes/system.ts
// =====================================================================
// System route module — extracted from app.ts (refactor PR 1).
// =====================================================================
//
// Owns ops / liveness endpoints. Today that's just /api/health,
// which returns 200 with the basic counts. Future additions (e.g.
// /api/metrics, /api/version-detail) should land here, not in
// app.ts directly.
//
// Public API:
//   - registerSystemRoutes(app, db)  mount the system endpoints
// =====================================================================
import type { Express } from "express";
import type Database from "better-sqlite3";

/**
 * Mount the system routes on the given Express app.
 *
 * @param app   the Express app
 * @param db    a better-sqlite3 instance (read-only queries here)
 */
export function registerSystemRoutes(app: Express, db: Database.Database): void {
  // ============== 健康检查 ==============
  app.get("/api/health", (_req, res) => {
    const children = db.prepare("SELECT COUNT(*) as c FROM children").get() as { c: number };
    const sessions = db.prepare("SELECT COUNT(*) as c FROM sessions").get() as { c: number };
    res.json({
      ok: true,
      service: "study-buddy",
      version: "0.1.0",
      childrenCount: children.c,
      sessionsCount: sessions.c,
    });
  });
}
