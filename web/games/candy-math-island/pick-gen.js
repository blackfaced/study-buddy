// pickGenWithBias — weighted-sampling question picker for the candy
// math island quiz. Given a set of (errorType, level, gen) tuples and
// a per-errorType weight map, returns a function that picks and runs a
// generator on each call. Weights are normalized so they don't have to
// sum to 1 — the caller can pass { carry: 0.6, compute: 0.4 } or just
// { carry: 3, compute: 2 }, both work.
//
// The optional { levels, rng } options let the caller restrict the
// active pool (e.g. to honour the adaptive ladder's current level)
// and inject a deterministic RNG for tests.
//
// Used by web/games/candy-math-island/index.html. The buildBiasFromWeakTopics
// helper below is also exported so the game can convert the server's
// /api/game/weak-topics response into the bias map without extra glue.

/**
 * @typedef {Object} QuizItem
 * @property {string} errorType  e.g. "carry" | "borrow" | "multiply" | "compute"
 * @property {number} level      1 | 2 | 3 — used by the level filter
 * @property {() => Question} gen
 *
 * @typedef {Object} Question
 * @property {string} display
 * @property {number} answer
 * @property {string} [errorType]
 * @property {boolean} [scenario]
 */

/**
 * @param {QuizItem[]} items
 * @param {Record<string, number>} errorTypeBias
 * @param {() => number} [rng]
 * @param {{ levels?: number[] }} [opts]
 * @returns {() => Question}
 */
export function pickGenWithBias(items, errorTypeBias, rng = Math.random, opts = {}) {
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error("pickGenWithBias: no items");
  }
  // Filter by level first so the weights below only cover reachable items.
  const pool = opts.levels
    ? items.filter((it) => opts.levels.includes(it.level))
    : items.slice();
  if (pool.length === 0) {
    throw new Error("pickGenWithBias: no items match levels filter");
  }

  // Build (item, weight) pairs and total weight.
  const weighted = pool.map((it) => ({ it, w: Math.max(0, errorTypeBias[it.errorType] ?? 0) }));
  const total = weighted.reduce((s, x) => s + x.w, 0);
  if (total <= 0) {
    throw new Error("pickGenWithBias: no positive weight in bias map for the current pool");
  }

  return function pick() {
    const r = rng() * total;
    let acc = 0;
    for (const { it, w } of weighted) {
      acc += w;
      if (r < acc) return it.gen();
    }
    // Floating-point edge case: r very close to total.
    return weighted[weighted.length - 1].it.gen();
  };
}

// Known errorTypes the bias map should always cover. Anything not in
// this set is ignored when reading from weak-topics, so the server is
// free to add new errorTypes in the future without breaking the client.
const KNOWN_ERROR_TYPES = ["carry", "borrow", "multiply", "compute"];

// Top-1 weak topic weight. Per issue #16, we want ~60% of the 60s
// session to target the weakest area, with the remaining 40% keeping
// basic fluency alive.
const TOP1_WEIGHT = 0.6;
const DEFAULT_FLOOR_COMPUTE = 0.5;

/**
 * Convert a /api/game/weak-topics response into a normalized bias map.
 * Defaults: compute-heavy (no weak data → keep practicing basics).
 * With weak data: top-1 errorType gets 60%, the rest share 40%.
 *
 * @param {Array<{ errorType: string, count: number }>} weakTopics
 * @returns {Record<string, number>}
 */
export function buildBiasFromWeakTopics(weakTopics) {
  // Filter to known errorTypes; unknown ones (e.g. future server additions)
  // are dropped silently rather than corrupting the bias map.
  const known = (weakTopics || []).filter((t) => KNOWN_ERROR_TYPES.includes(t.errorType));
  if (known.length === 0) {
    return { carry: 0.15, borrow: 0.15, multiply: 0.2, compute: DEFAULT_FLOOR_COMPUTE };
  }
  const top = known[0];
  const remaining = 1 - TOP1_WEIGHT;
  // Distribute the remaining 40% across the other known types, plus a
  // small floor for compute so we never lose basic fluency entirely.
  const otherTypes = KNOWN_ERROR_TYPES.filter((t) => t !== top.errorType);
  const each = remaining / otherTypes.length;
  const bias = {};
  for (const t of otherTypes) bias[t] = each;
  bias[top.errorType] = TOP1_WEIGHT;
  return bias;
}
