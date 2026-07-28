// server/src/buddy-lock.test.ts
//
// 4-digit PIN gate for /buddy/. Per PRD issue #55:
// - Correct PIN → ok
// - Wrong PIN → 401 reason 'wrong'
// - 5 wrong in a row → 6th is 'locked' with retryAfterSec ≈ 300
// - Lockout clears after 5 minutes (fake-timer verified)
// - Different IPs are independent counters
// - BUDDY_PIN unset (null) → always ok
// - Non-4-digit input → 'wrong' (input validation)
import { describe, it, expect, beforeEach, vi } from "vitest";
import { BuddyLock } from "./buddy-lock.js";

describe("BuddyLock: correct PIN", () => {
  it("returns ok on first correct attempt", () => {
    const lock = new BuddyLock({ pin: "8864" });
    expect(lock.tryUnlock({ ip: "1.1.1.1", pin: "8864" })).toEqual({ ok: true });
  });

  it("does not increment attempts on a correct PIN", () => {
    const lock = new BuddyLock({ pin: "8864" });
    lock.tryUnlock({ ip: "1.1.1.1", pin: "0000" });  // wrong
    lock.tryUnlock({ ip: "1.1.1.1", pin: "0000" });  // wrong
    lock.tryUnlock({ ip: "1.1.1.1", pin: "8864" });  // correct
    // After correct, the wrong attempts should be reset so a new burst of
    // 5 wrong starts from 0, not 3.
    expect(lock.tryUnlock({ ip: "1.1.1.1", pin: "0000" })).toEqual({
      ok: false,
      reason: "wrong",
    });
  });
});

describe("BuddyLock: wrong PIN", () => {
  it("returns 'wrong' on first wrong attempt (not locked)", () => {
    const lock = new BuddyLock({ pin: "8864" });
    expect(lock.tryUnlock({ ip: "1.1.1.1", pin: "0000" })).toEqual({
      ok: false,
      reason: "wrong",
    });
  });

  it("returns 'wrong' on the 4th wrong attempt (still not locked)", () => {
    const lock = new BuddyLock({ pin: "8864" });
    for (let i = 0; i < 4; i++) {
      const r = lock.tryUnlock({ ip: "1.1.1.1", pin: "0000" });
      expect(r).toEqual({ ok: false, reason: "wrong" });
    }
  });

  it("returns 'wrong' (not 'locked') on exactly the 5th wrong attempt — the 5th is the one that triggers the lock, but the response still says wrong", () => {
    // Per the design: the 5th wrong attempt both records the wrong AND
    // arms the lockout. The 6th attempt is the first one to receive
    // 'locked'. The 5th itself still returns 'wrong' (so the client
    // doesn't get mixed signals).
    const lock = new BuddyLock({ pin: "8864" });
    for (let i = 0; i < 4; i++) {
      lock.tryUnlock({ ip: "1.1.1.1", pin: "0000" });
    }
    expect(lock.tryUnlock({ ip: "1.1.1.1", pin: "0000" })).toEqual({
      ok: false,
      reason: "wrong",
    });
  });
});

describe("BuddyLock: 5-attempt lockout", () => {
  it("returns 'locked' with retryAfterSec on the 6th attempt after 5 wrongs", () => {
    const lock = new BuddyLock({ pin: "8864" });
    for (let i = 0; i < 5; i++) {
      lock.tryUnlock({ ip: "1.1.1.1", pin: "0000" });
    }
    const r = lock.tryUnlock({ ip: "1.1.1.1", pin: "8864" });
    expect(r.ok).toBe(false);
    if (r.ok === false && r.reason === "locked") {
      // 5 minutes ± a few seconds (we don't pin the exact number, just
      // the order of magnitude).
      expect(r.retryAfterSec).toBeGreaterThan(290);
      expect(r.retryAfterSec).toBeLessThanOrEqual(300);
    } else {
      // Make the test fail with a useful message if the type guard above
      // didn't match.
      expect.fail(`expected 'locked' with retryAfterSec, got ${JSON.stringify(r)}`);
    }
  });

  it("does NOT unlock even if a correct PIN is provided while locked", () => {
    const lock = new BuddyLock({ pin: "8864" });
    for (let i = 0; i < 5; i++) {
      lock.tryUnlock({ ip: "1.1.1.1", pin: "0000" });
    }
    // Even with the correct PIN, locked state takes priority.
    const r = lock.tryUnlock({ ip: "1.1.1.1", pin: "8864" });
    expect(r).toMatchObject({ ok: false, reason: "locked" });
  });

  it("unlocks after the lockout window elapses (fake-timer verified)", () => {
    let now = 1_000_000;
    const lock = new BuddyLock({ pin: "8864", now: () => now });
    for (let i = 0; i < 5; i++) {
      lock.tryUnlock({ ip: "1.1.1.1", pin: "0000" });
    }
    expect(lock.tryUnlock({ ip: "1.1.1.1", pin: "8864" })).toMatchObject({
      ok: false,
      reason: "locked",
    });
    // 4 minutes later: still locked.
    now += 4 * 60 * 1000;
    expect(lock.tryUnlock({ ip: "1.1.1.1", pin: "8864" })).toMatchObject({
      ok: false,
      reason: "locked",
    });
    // 5 minutes + 1s later: unlocked, can try again.
    now += 60 * 1000 + 1000;
    expect(lock.tryUnlock({ ip: "1.1.1.1", pin: "8864" })).toEqual({ ok: true });
  });

  it("uses real Date.now when no clock is injected (smoke test, does not actually wait 5 min)", () => {
    const lock = new BuddyLock({ pin: "8864" });
    for (let i = 0; i < 5; i++) {
      lock.tryUnlock({ ip: "1.1.1.1", pin: "0000" });
    }
    const r = lock.tryUnlock({ ip: "1.1.1.1", pin: "8864" });
    expect(r).toMatchObject({ ok: false, reason: "locked" });
  });
});

describe("BuddyLock: per-IP isolation", () => {
  it("wrong attempts on one IP do not lock another IP", () => {
    const lock = new BuddyLock({ pin: "8864" });
    for (let i = 0; i < 5; i++) {
      lock.tryUnlock({ ip: "1.1.1.1", pin: "0000" });
    }
    // IP 2.2.2.2 is fresh.
    expect(lock.tryUnlock({ ip: "2.2.2.2", pin: "8864" })).toEqual({ ok: true });
  });

  it("rejects input with non-4-digit pin (treated as wrong, not a crash)", () => {
    const lock = new BuddyLock({ pin: "8864" });
    expect(lock.tryUnlock({ ip: "1.1.1.1", pin: "12" })).toEqual({
      ok: false,
      reason: "wrong",
    });
    expect(lock.tryUnlock({ ip: "1.1.1.1", pin: "12345" })).toEqual({
      ok: false,
      reason: "wrong",
    });
    expect(lock.tryUnlock({ ip: "1.1.1.1", pin: "abcd" })).toEqual({
      ok: false,
      reason: "wrong",
    });
    expect(lock.tryUnlock({ ip: "1.1.1.1", pin: "" })).toEqual({
      ok: false,
      reason: "wrong",
    });
  });
});

describe("BuddyLock: BUDDY_PIN unset (development mode)", () => {
  it("null PIN → always ok, no rate limit applied", () => {
    const lock = new BuddyLock({ pin: null });
    for (let i = 0; i < 100; i++) {
      expect(lock.tryUnlock({ ip: "1.1.1.1", pin: "0000" })).toEqual({ ok: true });
    }
  });

  it("empty-string PIN is treated as unset (null-equivalent)", () => {
    const lock = new BuddyLock({ pin: "" });
    expect(lock.tryUnlock({ ip: "1.1.1.1", pin: "0000" })).toEqual({ ok: true });
  });
});

describe("BuddyLock: reset", () => {
  it("reset(ip) clears that IP's attempts and lock state", () => {
    const lock = new BuddyLock({ pin: "8864" });
    for (let i = 0; i < 5; i++) {
      lock.tryUnlock({ ip: "1.1.1.1", pin: "0000" });
    }
    lock.reset("1.1.1.1");
    // After reset, should be able to try again.
    expect(lock.tryUnlock({ ip: "1.1.1.1", pin: "8864" })).toEqual({ ok: true });
  });
});
