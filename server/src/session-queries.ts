// server/src/session-queries.ts
// =====================================================================
// Shared session ownership queries — the non-route home for the seam
// that both route modules and domain modules (capture-service) depend
// on. Moved out of routes/session.ts so non-route modules don't import
// from route files.
//
// findOwnedActiveSession is the shared boundary for chat and media
// writes: callers must provide an explicit session id and authenticated
// device, and the session must still belong to that device/child and
// remain active.
// =====================================================================
import type Database from "better-sqlite3";
import type { DevicePrincipal } from "./device-auth.js";

export type OwnedSessionResult =
  | { status: "ok"; session: { id: string; child_id: string } }
  | { status: "not-found" }
  | { status: "forbidden" }
  | { status: "ended" };

export type OwnedSessionFailure = Exclude<OwnedSessionResult["status"], "ok">;

export function findOwnedActiveSession(
  db: Database.Database,
  sessionId: string,
  device: DevicePrincipal,
): OwnedSessionResult {
  const session = db.prepare(
    `SELECT id, child_id, device_id, ended_at
       FROM sessions WHERE id = ?`,
  ).get(sessionId) as
    | { id: string; child_id: string; device_id: string | null; ended_at: number | null }
    | undefined;
  if (!session) return { status: "not-found" };
  if (session.child_id !== device.childId || session.device_id !== device.deviceId) {
    return { status: "forbidden" };
  }
  const activeDevice = db.prepare(
    `SELECT 1 FROM paired_devices
      WHERE device_id = ? AND child_id = ? AND revoked_at IS NULL`,
  ).get(device.deviceId, device.childId);
  if (!activeDevice) return { status: "forbidden" };
  if (session.ended_at !== null) return { status: "ended" };
  return { status: "ok", session: { id: session.id, child_id: session.child_id } };
}
