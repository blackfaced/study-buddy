import { createHash, randomInt, randomUUID, randomBytes } from "node:crypto";
import Database from "better-sqlite3";
import type { Request, RequestHandler, Response } from "express";

const PAIRING_TTL_MS = 5 * 60_000;

export interface DevicePrincipal {
  deviceId: string;
  childId: string;
}

export interface DeviceAuthOptions {
  db: Database.Database;
  now?: () => number;
  isSecureRequest?: (req: Request) => boolean;
}

export interface DeviceRequestAuthenticator {
  requireDevice: RequestHandler;
}

export class DeviceAuth {
  readonly #db: Database.Database;
  readonly #now: () => number;
  readonly #isSecureRequest: (req: Request) => boolean;

  constructor(options: DeviceAuthOptions) {
    this.#db = options.db;
    this.#now = options.now ?? Date.now;
    this.#isSecureRequest = options.isSecureRequest ?? requestUsesSecureDeviceTransport;
  }

  issuePairingCode(
    childId: string,
    options: { resetDevices?: boolean } = {},
  ): { code: string; expiresAt: number } | null {
    const child = this.#db.prepare("SELECT id FROM children WHERE id = ?").get(childId);
    if (!child) return null;

    const now = this.#now();
    const expiresAt = now + PAIRING_TTL_MS;
    return this.#db.transaction(() => {
      if (options.resetDevices) {
        this.#db.prepare(
          "UPDATE paired_devices SET revoked_at = ? WHERE child_id = ? AND revoked_at IS NULL",
        ).run(now, childId);
      }
      this.#db.prepare(
        "DELETE FROM pairing_codes WHERE child_id = ? OR expires_at <= ? OR used_at IS NOT NULL",
      ).run(childId, now);

      for (let attempt = 0; attempt < 5; attempt += 1) {
        const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
        try {
          this.#db.prepare(
            `INSERT INTO pairing_codes
               (id, code_hash, child_id, created_at, expires_at)
             VALUES (?, ?, ?, ?, ?)`,
          ).run(randomUUID(), digest(code), childId, now, expiresAt);
          return { code, expiresAt };
        } catch (error) {
          const isCodeCollision = error instanceof Database.SqliteError
            && error.code === "SQLITE_CONSTRAINT_UNIQUE";
          if (!isCodeCollision || attempt === 4) throw error;
        }
      }
      throw new Error("pairing code could not be generated");
    })();
  }

  redeemPairingCode(
    code: string,
    deviceName: string,
  ): { credential: string; deviceId: string; childId: string } | null {
    const now = this.#now();
    return this.#db.transaction(() => {
      const row = this.#db.prepare(
        `SELECT id, child_id AS childId
           FROM pairing_codes
          WHERE code_hash = ? AND used_at IS NULL AND expires_at > ?`,
      ).get(digest(code), now) as { id: string; childId: string } | undefined;
      if (!row) return null;

      const credential = `sb_${randomBytes(32).toString("base64url")}`;
      const deviceId = randomUUID();
      this.#db.prepare(
        `INSERT INTO paired_devices
           (device_id, child_id, credential_hash, device_name, created_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(deviceId, row.childId, digest(credential), deviceName, now, now);
      this.#db.prepare("UPDATE pairing_codes SET used_at = ? WHERE id = ?")
        .run(now, row.id);
      return { credential, deviceId, childId: row.childId };
    })();
  }

  readonly requireDevice: RequestHandler = (req, res, next) => {
    if (!this.#isSecureRequest(req)) return secureTransportRequired(res);
    const credential = bearerCredential(req);
    if (!credential) return unauthorized(res);
    const now = this.#now();
    const device = this.#db.prepare(
      `SELECT device_id AS deviceId, child_id AS childId, last_seen_at AS lastSeenAt
         FROM paired_devices
        WHERE credential_hash = ? AND revoked_at IS NULL`,
    ).get(digest(credential)) as (DevicePrincipal & { lastSeenAt: number }) | undefined;
    if (!device) return unauthorized(res);
    if (now - device.lastSeenAt >= 60_000) {
      this.#db.prepare("UPDATE paired_devices SET last_seen_at = ? WHERE device_id = ?")
        .run(now, device.deviceId);
    }
    res.locals.device = { deviceId: device.deviceId, childId: device.childId };
    next();
  };
}

export function requestUsesSecureDeviceTransport(req: Request): boolean {
  if (req.secure) return true;
  const address = req.socket.remoteAddress ?? "";
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

export function devicePrincipal(res: Response): DevicePrincipal {
  return res.locals.device as DevicePrincipal;
}

function bearerCredential(req: Request): string | null {
  const header = req.get("authorization");
  if (!header?.startsWith("Bearer ")) return null;
  const credential = header.slice("Bearer ".length).trim();
  return credential.startsWith("sb_") ? credential : null;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function unauthorized(res: Response): void {
  res.status(401).json({ error: "device authentication required" });
}

function secureTransportRequired(res: Response): void {
  res.status(403).json({ error: "secure transport required for device authentication" });
}
