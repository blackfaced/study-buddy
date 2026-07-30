// web/write/grade.test.js
//
// Pure-function grader for "see write" training: given the attempt
// count + when the kid was last shown the reference character, decide
// the opacity (1.0 = full, 0.5 = half, 0.0 = no reference) for the
// next attempt.
//
// Design (from PRD issue #57):
// - attemptCount = 0  → 1.0   (first time, show full)
// - attemptCount >= 3 → 0.0   (kid has seen it 3+ times, stop showing)
// - attemptCount 1-2 + last shown within cooldown → 0.5
// - attemptCount 1-2 + cooldown elapsed             → 1.0 (reset)
//
// Cooldown = 30s default. Inject `now` for deterministic tests.
import { test } from "node:test";
import assert from "node:assert/strict";
import { computeDisplayLevel } from "./grade.js";

const NOW = 1_000_000;
const COOLDOWN_MS = 30_000;

test("computeDisplayLevel: first attempt (attemptCount=0) → 1.0", () => {
  const r = computeDisplayLevel({ attemptCount: 0, lastShownAt: null, now: NOW, cooldownMs: COOLDOWN_MS });
  assert.equal(r, 1.0);
});

test("computeDisplayLevel: 1 attempt, last shown just now → 0.5", () => {
  const r = computeDisplayLevel({
    attemptCount: 1,
    lastShownAt: NOW - 5_000,  // shown 5s ago
    now: NOW,
    cooldownMs: COOLDOWN_MS,
  });
  assert.equal(r, 0.5);
});

test("computeDisplayLevel: 1 attempt, last shown > 30s ago → 1.0 (cooldown reset)", () => {
  const r = computeDisplayLevel({
    attemptCount: 1,
    lastShownAt: NOW - 60_000,  // 60s ago
    now: NOW,
    cooldownMs: COOLDOWN_MS,
  });
  assert.equal(r, 1.0);
});

test("computeDisplayLevel: 2 attempts, last shown within cooldown → 0.5", () => {
  const r = computeDisplayLevel({
    attemptCount: 2,
    lastShownAt: NOW - 1_000,
    now: NOW,
    cooldownMs: COOLDOWN_MS,
  });
  assert.equal(r, 0.5);
});

test("computeDisplayLevel: 3 attempts → 0.0 (no reference, regardless of cooldown)", () => {
  const r1 = computeDisplayLevel({
    attemptCount: 3,
    lastShownAt: NOW - 1_000,  // just shown
    now: NOW,
    cooldownMs: COOLDOWN_MS,
  });
  assert.equal(r1, 0.0);

  const r2 = computeDisplayLevel({
    attemptCount: 3,
    lastShownAt: null,  // never shown (edge case)
    now: NOW,
    cooldownMs: COOLDOWN_MS,
  });
  assert.equal(r2, 0.0);
});

test("computeDisplayLevel: 10 attempts → 0.0 (cap is 3)", () => {
  const r = computeDisplayLevel({
    attemptCount: 10,
    lastShownAt: NOW - 1_000,
    now: NOW,
    cooldownMs: COOLDOWN_MS,
  });
  assert.equal(r, 0.0);
});

test("computeDisplayLevel: cooldownMs = 0 → always treats as cooldown elapsed → 1.0", () => {
  // Edge case: 1 attempt, last shown right now, but cooldown is 0 → reset
  const r = computeDisplayLevel({
    attemptCount: 1,
    lastShownAt: NOW,
    now: NOW,
    cooldownMs: 0,
  });
  assert.equal(r, 1.0);
});

test("computeDisplayLevel: cooldownMs default = 30_000 (smoke test)", () => {
  // 29s ago < 30s cooldown → 0.5
  const r1 = computeDisplayLevel({
    attemptCount: 1,
    lastShownAt: NOW - 29_000,
    now: NOW,
  });
  assert.equal(r1, 0.5);

  // 31s ago > 30s cooldown → 1.0
  const r2 = computeDisplayLevel({
    attemptCount: 1,
    lastShownAt: NOW - 31_000,
    now: NOW,
  });
  assert.equal(r2, 1.0);
});

test("computeDisplayLevel: exactly at cooldown boundary → 1.0 (cooldown elapsed)", () => {
  // now - lastShownAt === cooldownMs → cooldown has fully elapsed → reset
  const r = computeDisplayLevel({
    attemptCount: 1,
    lastShownAt: NOW - COOLDOWN_MS,  // exactly 30s ago
    now: NOW,
    cooldownMs: COOLDOWN_MS,
  });
  assert.equal(r, 1.0);
});

test("computeDisplayLevel: just inside cooldown boundary (cooldown-1ms) → 0.5", () => {
  // 1ms before the cooldown elapses → still in cooldown → half
  const r = computeDisplayLevel({
    attemptCount: 1,
    lastShownAt: NOW - COOLDOWN_MS + 1,  // 29.999s ago
    now: NOW,
    cooldownMs: COOLDOWN_MS,
  });
  assert.equal(r, 0.5);
});
