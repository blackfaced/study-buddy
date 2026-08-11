import type { Express, Request, Response } from "express";
import {
  requestUsesSecureDeviceTransport,
  type DeviceAuth,
} from "../device-auth.js";

export interface PairingRouteDeps {
  auth: DeviceAuth;
  isLoopback?: (req: Request) => boolean;
  now?: () => number;
  isSecureRequest?: (req: Request) => boolean;
}

export function registerPairingRoutes(app: Express, deps: PairingRouteDeps): void {
  const isLoopback = deps.isLoopback ?? requestIsLoopback;
  const isSecureRequest = deps.isSecureRequest ?? requestUsesSecureDeviceTransport;
  const attempts = new PairingAttemptLimiter(deps.now);

  app.post("/api/pair/code", (req: Request, res: Response) => {
    if (!isLoopback(req)) {
      return res.status(403).json({ error: "pairing codes are local-only" });
    }
    const childId = typeof req.body?.childId === "string" ? req.body.childId : "default";
    const issued = deps.auth.issuePairingCode(childId, {
      resetDevices: req.body?.resetDevices === true,
    });
    if (!issued) return res.status(404).json({ error: "child not found" });
    return res.status(201).json(issued);
  });

  app.post("/api/pair/redeem", (req: Request, res: Response) => {
    if (!isSecureRequest(req)) {
      return res.status(403).json({ error: "secure transport required for pairing" });
    }
    const code = typeof req.body?.code === "string" ? req.body.code.trim() : "";
    const deviceName = typeof req.body?.deviceName === "string"
      ? req.body.deviceName.trim()
      : "";
    if (!/^\d{6}$/.test(code) || deviceName.length < 1 || deviceName.length > 64) {
      return res.status(400).json({ error: "invalid pairing request" });
    }
    const client = req.ip ?? req.socket.remoteAddress ?? "unknown";
    const retryAfterSec = attempts.retryAfterSec(client);
    if (retryAfterSec !== null) {
      res.set("Retry-After", String(retryAfterSec));
      return res.status(429).json({ error: "pairing temporarily locked", retryAfterSec });
    }
    const paired = deps.auth.redeemPairingCode(code, deviceName);
    if (!paired) {
      attempts.recordFailure(client);
      return res.status(401).json({ error: "invalid pairing code" });
    }
    attempts.clear(client);
    return res.status(201).json(paired);
  });
}

class PairingAttemptLimiter {
  readonly #now: () => number;
  readonly #state = new Map<string, { failures: number; lockedUntil: number }>();

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  retryAfterSec(client: string): number | null {
    const state = this.#state.get(client);
    if (!state) return null;
    const now = this.#now();
    if (state.lockedUntil > now) {
      return Math.max(1, Math.ceil((state.lockedUntil - now) / 1000));
    }
    if (state.lockedUntil > 0) this.#state.delete(client);
    return null;
  }

  recordFailure(client: string): void {
    const previous = this.#state.get(client);
    const failures = (previous?.failures ?? 0) + 1;
    this.#state.set(client, {
      failures,
      lockedUntil: failures >= 10 ? this.#now() + 5 * 60_000 : 0,
    });
  }

  clear(client: string): void {
    this.#state.delete(client);
  }
}

function requestIsLoopback(req: Request): boolean {
  const address = req.socket.remoteAddress ?? "";
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}
