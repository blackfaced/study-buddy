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
// The optional { mistakeProvider, mistakeRate } options enable the
// 30% mistake-mix window (issue #99, #34a-2). When both are set,
// each pick() first rolls against `mistakeRate` (default 0.3); on a
// hit, `mistakeProvider()` is called and its return value (a Mistake
// object compatible with the Question shape) is served directly. If
// the provider returns null (pool empty), the picker falls through
// to the regular weighted-sampling path so a session never starves
// for questions. Callers without mistakeProvider behave exactly as
// before — backwards compat is enforced by the test suite.
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
 *
 * @typedef {Object} Mistake
 * @property {number} id
 * @property {string} problem        e.g. "7+5" — the kid's question
 * @property {number|string} answer  the correct answer
 * @property {string} errorType
 * @property {true} [fromMistake]    marker so callers/tests can identify the source
 */

/**
 * @param {QuizItem[]} items
 * @param {Record<string, number>} errorTypeBias
 * @param {() => number} [rng]
 * @param {{ levels?: number[], mistakeProvider?: () => (Mistake|null), mistakeRate?: number }} [opts]
 * @returns {() => (Question|Mistake)}
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

  // v0.8 (#99, #34a-2): 30% mistake-mix gate. Defaults to 0.3 so callers
  // can pass just { mistakeProvider } and get the spec'd rate. Setting
  // mistakeRate to 0 (or omitting mistakeProvider) disables the gate
  // entirely — the regular weighted path is the only source of picks.
  const mistakeProvider = opts.mistakeProvider;
  const mistakeRate = typeof opts.mistakeRate === "number" ? opts.mistakeRate : 0.3;
  const mistakeGateEnabled = typeof mistakeProvider === "function" && mistakeRate > 0;

  return function pick() {
    // 1. Mistake-mix gate (only when configured). On a hit, try the
    //    provider; null OR a multi-question mistake means "skip this
    //    one and fall through to the regular path" so the session
    //    never starves and never shows a kid two questions in one
    //    card. Multi-question mistakes are still shifted off the
    //    provider's pool by the caller, so they don't re-surface
    //    until the upstream VLM capture (#128 T04) splits them at
    //    the source.
    if (mistakeGateEnabled && rng() < mistakeRate) {
      const m = mistakeProvider();
      if (m && !isMultiQuestionProblem(m.problem)) {
        // Wrap the raw mistake into the Question shape so the renderer
        // and the regular picker can share downstream code. We tag
        // `fromMistake` so the caller can route the answer to the
        // cascade-review endpoint (T3, #100) and so tests can identify
        // the source without inspecting display/answer.
        return {
          display: m.problem,
          answer: m.answer,
          errorType: m.errorType,
          level: null,
          fromMistake: true,
          mistakeId: m.id,
        };
      }
    }
    // 2. Regular weighted-sampling path.
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

// v0.8.16 (candy-math-island start button): VLM photo capture of a
// whole homework page produced mistake records whose `problem` field
// contains MULTIPLE questions glued together. pickGenWithBias rendered
// the raw problem text in the quiz, so kids saw two questions in one
// card and could not answer either. We detect this at the picker
// boundary and skip such mistakes, falling through to the regular
// weighted-sampling path. The proper fix is at the VLM capture layer
// (split one photo into N confirmed mistakes, #128 T04); this
// client-side skip is a defence-in-depth while that's still pending.
//
// Detection rules — any one of:
//   - the problem contains a newline (clearly two+ lines / two+ questions)
//   - the problem contains the bold "第" question marker sequence
//     (VLM sometimes uses "**第一题：**" / "**第二题：**" inline)
const MULTI_Q_NEWLINE = /\n/;
const MULTI_Q_BOLD = /\*\*第[一二三四五六七八九十]+题/g;

/**
 * @param {string} problem
 * @returns {boolean} true if the problem text looks like multiple questions
 */
export function isMultiQuestionProblem(problem) {
  if (typeof problem !== "string" || problem.length === 0) return false;
  if (MULTI_Q_NEWLINE.test(problem)) return true;
  // If we see TWO OR MORE "第N题" markers, it's multi-question even
  // without newlines. One marker could be a single problem that
  // happens to say "first question" — only skip on ≥ 2 to avoid
  // false positives.
  const matches = problem.match(MULTI_Q_BOLD);
  return Array.isArray(matches) && matches.length >= 2;
}

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
