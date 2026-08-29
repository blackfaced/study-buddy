// sync-mistake-reviews.js
//
// Extracted from inline code in index.html so it can be unit-tested.
// Flushes the pendingMistakeReviews queue to the server's
// /api/game/mistake-review endpoint (T3 = #100).
//
// Contract:
//   - Fire-and-forget: caller does NOT await this; the queue flush
//     runs in the background and resolves silently (errors swallowed).
//   - On success: queue is mutated in place to empty (length = 0).
//   - On error: queue is dropped (length = 0) — best-effort. We don't
//     retry because the kid's next session will re-mix the same
//     mistakes anyway (the server still has them with the obligation
//     open), so a retry would just record them twice.
//   - Empty queue: no-op, returns immediately.
//
// Why drop the queue on error instead of keeping it: a stuck queue
// means we'd keep POSTing the same review on every session, recording
// duplicate correction attempts for a case the kid already verified.
// The drop is safer than the retry.
//
// Used by web/games/candy-math-island/index.html syncToServer().

/**
 * @typedef {Object} ReviewEntry
 * @property {number} mistakeId
 * @property {boolean} correct
 *
 * @typedef {Object} SyncMistakeReviewsDeps
 * @property {(url: string, init: { method: string, body: object }) => Promise<any>} fetchFn
 *   The HTTP client to use. Defaults to globalThis.StudyBuddy.fetch
 *   when omitted (the production path; tests pass a stub).
 * @property {string} apiBase
 *   Pre-pended to the endpoint path. e.g. "" for same-origin or
 *   "https://mac-mini.local:3000" for a remote dev server.
 * @property {string} [childId="default"]
 *   Which child's mistakes to apply the reviews to. Defaults to
 *   "default" to match the rest of the candy-math-island client.
 */

/**
 * Flush the pendingMistakeReviews queue to the server.
 *
 * @param {ReviewEntry[]} queue
 * @param {SyncMistakeReviewsDeps} deps
 * @returns {Promise<void>}
 */
export async function syncMistakeReviews(queue, deps) {
  if (!Array.isArray(queue) || queue.length === 0) return;
  const { fetchFn, apiBase, childId } = deps;
  // Snapshot the queue before any mutation. The body passed to fetch
  // holds a reference to the array; if we cleared the queue in place
  // before the fetch returned, the body would also become empty
  // (same reference, mutated length). Copying is cheap (handful of
  // entries per session) and decouples the wire payload from the
  // caller's state.
  const results = queue.slice();
  try {
    await fetchFn(apiBase + "/api/game/mistake-review", {
      method: "POST",
      body: { childId: childId ?? "default", results },
    });
    // Success: clear the queue in place so the caller's reference stays valid.
    queue.length = 0;
  } catch {
    // Drop the queue on any error (network, 4xx, 5xx). See file header
    // for why retrying is worse than dropping.
    queue.length = 0;
  }
}
