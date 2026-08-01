// server/src/routes/whoami.ts
// =====================================================================
// /api/whoami — read-only child + session context for agent introspection.
// =====================================================================
//
// Aggregates state from the children + sessions tables so an agent
// (Mavis, MCP, anything else) can ask "who is the kid using the
// app right now, and which session are they in?" without hitting
// multiple endpoints.
//
// Why a separate module:
//   - /api/pair is about first-run pairing (a specific client
//     joining the hub). /api/whoami is about current state —
//     orthogonal concerns.
//   - Read-only, no side effects. Easy to extend (e.g. add a
//     "settings" field later) without growing the buddy module.
//
// Public API:
//   registerWhoamiRoutes(app, { db, version })
//
// Response shape:
//   {
//     service:  "study-buddy",
//     version:  "0.1.0-test",       // from deps
//     child:    { childId, name, grade },
//     session:  null | { id, childId, subject, startedAt }
//   }
// =====================================================================
import type { Express, Request, Response } from "express";
import type Database from "better-sqlite3";

export interface WhoamiRouteDeps {
  db: Database.Database;
  /** Service version string surfaced in the response. */
  version: string;
}

export function registerWhoamiRoutes(app: Express, deps: WhoamiRouteDeps): void {
  const { db, version } = deps;

  app.get("/api/whoami", (_req: Request, res: Response) => {
    const child = db
      .prepare("SELECT id, name, grade FROM children WHERE id = 'default'")
      .get() as { id: string; name: string; grade: string } | undefined;

    // Most recent active session. Mirrors getActiveSession() in
    // routes/session.ts — we don't import it to keep the modules
    // independent (whoami is read-only and doesn't need the
    // session lifecycle helpers).
    const session = db
      .prepare(
        "SELECT id, child_id, subject, started_at FROM sessions WHERE ended_at IS NULL ORDER BY started_at DESC LIMIT 1"
      )
      .get() as
      | { id: string; child_id: string; subject: string | null; started_at: number }
      | undefined;

    res.json({
      service: "study-buddy",
      version,
      child: {
        childId: child?.id ?? "default",
        name: child?.name ?? "小宝",
        grade: child?.grade ?? "二年级",
      },
      session: session
        ? {
            id: session.id,
            childId: session.child_id,
            subject: session.subject,
            startedAt: session.started_at,
          }
        : null,
    });
  });
}
