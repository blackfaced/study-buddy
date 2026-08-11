// server/src/routes/whoami.ts
// =====================================================================
// /api/whoami — read-only context for the authenticated child device.
// =====================================================================
//
// Aggregates the paired child's profile and this device's active session.
// It must never expose the globally latest session because multiple child
// devices may be active independently.
//
// Why a separate module:
//   - /api/pair is about first-run pairing (a specific client
//     joining the hub). /api/whoami is about current state —
//     orthogonal concerns.
//   - Read-only, no side effects. Easy to extend (e.g. add a
//     "settings" field later) without growing the buddy module.
//
// Public API:
//   registerWhoamiRoutes(app, { db, version, auth })
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
import { devicePrincipal, type DeviceRequestAuthenticator } from "../device-auth.js";

export interface WhoamiRouteDeps {
  db: Database.Database;
  /** Service version string surfaced in the response. */
  version: string;
  auth: DeviceRequestAuthenticator;
}

export function registerWhoamiRoutes(app: Express, deps: WhoamiRouteDeps): void {
  const { db, version, auth } = deps;

  app.get("/api/whoami", auth.requireDevice, (_req: Request, res: Response) => {
    const device = devicePrincipal(res);
    const child = db
      .prepare("SELECT id, name, grade FROM children WHERE id = ?")
      .get(device.childId) as { id: string; name: string; grade: string } | undefined;

    // A paired browser may inspect only its own active session.
    const session = db
      .prepare(
        `SELECT id, child_id, subject, started_at FROM sessions
          WHERE device_id = ? AND child_id = ? AND ended_at IS NULL
          ORDER BY started_at DESC LIMIT 1`,
      )
      .get(device.deviceId, device.childId) as
      | { id: string; child_id: string; subject: string | null; started_at: number }
      | undefined;

    res.json({
      service: "study-buddy",
      version,
      child: {
        childId: child?.id ?? device.childId,
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
