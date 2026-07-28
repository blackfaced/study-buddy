// server/src/buddy-lock.ts
//
// 4-digit PIN gate for /buddy/. Per PRD issue #55:
// - BUDDY_PIN unset (null or empty) → all attempts return ok (dev mode).
// - BUDDY_PIN set → exact-match required. Wrong attempts are counted
//   per IP; on the 5th wrong attempt the IP is locked for 5 minutes.
//   During lockout, even the correct PIN returns 'locked'.
// - State is in-memory (Map<ip, {attempts, lockedUntil}>). Server
//   restart clears the map. This is intentional (PRD §Further Notes):
//   a stuck lockout is recoverable by restarting, which a parent
//   can do deliberately; persisting to SQLite would mean a kid who
//   managed to lock themselves out is locked out across restarts.

export type BuddyLockResult =
  | { ok: true }
  | { ok: false; reason: "wrong" }
  | { ok: false; reason: "locked"; retryAfterSec: number };

export interface BuddyLockOptions {
  /** 4-digit PIN, or null/empty to disable the lock (development mode). */
  pin: string | null;
  /** Max wrong attempts before lockout. Default 5. */
  maxAttempts?: number;
  /** Lockout window in ms. Default 5 * 60 * 1000. */
  lockoutMs?: number;
  /** Clock for testing. Defaults to Date.now. */
  now?: () => number;
}

interface IpState {
  attempts: number;
  /** Wall-clock ms until which this IP is locked. 0 = not locked. */
  lockedUntil: number;
}

const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_LOCKOUT_MS = 5 * 60 * 1000;

export class BuddyLock {
  private readonly pin: string | null;
  private readonly maxAttempts: number;
  private readonly lockoutMs: number;
  private readonly now: () => number;
  private readonly state = new Map<string, IpState>();

  constructor(opts: BuddyLockOptions) {
    // Normalize: empty string → null (treat unset the same as null).
    this.pin = opts.pin && opts.pin.length > 0 ? opts.pin : null;
    this.maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.lockoutMs = opts.lockoutMs ?? DEFAULT_LOCKOUT_MS;
    this.now = opts.now ?? Date.now;
  }

  /**
   * Attempt to unlock for the given IP with the given PIN.
   * Returns { ok: true } on success, or { ok: false, reason, ... }.
   *
   * Semantics:
   * - If `pin` is null (BUDDY_PIN unset), always returns { ok: true }
   *   without touching the rate-limit state.
   * - If currently locked, returns { ok: false, reason: 'locked',
   *   retryAfterSec: <seconds until unlock> } without comparing PIN.
   * - Otherwise: compare the supplied PIN. If correct → ok. If wrong →
   *   increment attempts; if attempts >= maxAttempts, arm the
   *   lockout window and return { ok: false, reason: 'wrong' } (so the
   *   client can show "wrong password"; the NEXT attempt is the one
   *   that returns 'locked').
   */
  tryUnlock(input: { ip: string; pin: string }): BuddyLockResult {
    if (this.pin === null) {
      return { ok: true };
    }

    const now = this.now();
    const cur = this.state.get(input.ip);

    // Locked? Don't even compare the PIN.
    if (cur && cur.lockedUntil > now) {
      const retryAfterSec = Math.max(1, Math.ceil((cur.lockedUntil - now) / 1000));
      return { ok: false, reason: "locked", retryAfterSec };
    }

    // Lockout window just expired — clear state so a fresh start.
    if (cur && cur.lockedUntil > 0 && cur.lockedUntil <= now) {
      this.state.delete(input.ip);
    }

    // Validate input shape: 4-digit numeric string. Anything else is 'wrong'.
    if (!/^\d{4}$/.test(input.pin)) {
      const wrong = this.recordWrong(input.ip, now);
      return wrong;
    }

    if (input.pin === this.pin) {
      // Correct — clear any wrong-attempt history for this IP.
      this.state.delete(input.ip);
      return { ok: true };
    }

    return this.recordWrong(input.ip, now);
  }

  /** Reset state for a single IP. Useful for tests and admin tools. */
  reset(ip: string): void {
    this.state.delete(ip);
  }

  /** Test helper: how many IPs are currently being tracked. */
  size(): number {
    return this.state.size;
  }

  private recordWrong(ip: string, now: number): BuddyLockResult {
    const prev = this.state.get(ip);
    const attempts = (prev?.attempts ?? 0) + 1;
    if (attempts >= this.maxAttempts) {
      this.state.set(ip, { attempts, lockedUntil: now + this.lockoutMs });
    } else {
      this.state.set(ip, { attempts, lockedUntil: prev?.lockedUntil ?? 0 });
    }
    return { ok: false, reason: "wrong" };
  }
}
