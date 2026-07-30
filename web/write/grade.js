// web/write/grade.js
//
// Pure-function grader for "see write" training. Decides the opacity
// of the reference character for the next attempt based on the kid's
// attempt history.
//
// Design (from PRD issue #57):
// - attemptCount = 0  → 1.0   (first time, show full)
// - attemptCount >= 3 → 0.0   (kid has seen it 3+ times, stop showing)
// - attemptCount 1-2 + last shown within cooldown → 0.5
// - attemptCount 1-2 + cooldown elapsed             → 1.0 (reset)
//
// Pure function, no side effects, no DOM, no time source.
// `now` is injected so tests can be deterministic.

/**
 * @param {Object} input
 * @param {number} input.attemptCount  how many times the kid has attempted this character (>= 0)
 * @param {number | null} input.lastShownAt  wall-clock ms when the kid was last shown the reference; null if never
 * @param {number} input.now  current wall-clock ms
 * @param {number} [input.cooldownMs=30000]  how long after lastShownAt before we reset to full opacity
 * @returns {number} opacity 1.0 (full) | 0.5 (half) | 0.0 (none)
 */
export function computeDisplayLevel({
  attemptCount,
  lastShownAt,
  now,
  cooldownMs = 30_000,
}) {
  // First time: always show full.
  if (attemptCount === 0) return 1.0;

  // Cap: 3+ attempts means we've shown enough; no more reference.
  if (attemptCount >= 3) return 0.0;

  // 1-2 attempts: respect cooldown. If cooldown is 0 (disabled), or
  // lastShownAt is null, or the cooldown window has elapsed (>=), reset
  // to full. Otherwise half.
  if (cooldownMs <= 0) return 1.0;
  if (lastShownAt === null) return 1.0;
  if (now - lastShownAt >= cooldownMs) return 1.0;
  return 0.5;
}
