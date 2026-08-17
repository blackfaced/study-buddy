// server/src/mistake-level.ts
// =====================================================================
// `inferMistakeLevel(problem, errorType)` — single source of truth for
// the candy-math-island level classification.
//
// Used by:
//   1. db-migrate (one-time backfill of pre-existing rows on upgrade)
//   2. mistake-api (every new mistake insert)
//
// The picker (candy-math-island) used to do this on the client side as
// a text-based heuristic (PR #146). With the level column populated at
// creation time, the picker can just compare `m.level <= kidLevel` and
// drop the client-side inference. The helper lives here as the server
// side source of truth.
//
// Level inference rules (any one match wins):
//   1. errorType = "multiply"                → L3
//   2. problem text contains "×" or "×" or "x"  → L3 (VLM text fallback)
//   3. problem text contains "个" / "几" / "多少" → L3 (counting-word fallback)
//   4. errorType = "carry" or "borrow" + max number ≥ 20 → L2
//   5. errorType = "carry" or "borrow" + max number < 20  → L1
//   6. small numbers / vision_pending / compute → L1
//   7. any other input → L1 (default safe)
//
// L1 < L2 < L3 — caller compares against the kid's current level.

const HAS_MULTIPLY_OP = /[×x×]/;
const HAS_COUNT_WORD = /个|几|多少/;
const NUMBER_PATTERN = /\d+/g;
// Carry/borrow can be either L1 (small) or L2 (large). L2 = the
// two-digit problems in the level-2 generator. Threshold of 20
// matches the generator's lower bound: genAddCarry uses a=10..49,
// genSubBorrow uses big=20..49.
const L2_NUMBER_THRESHOLD = 20;

/**
 * @param {string | null | undefined} problem
 * @param {string | null | undefined} errorType
 * @returns {1 | 2 | 3}  the level the mistake belongs to
 */
export function inferMistakeLevel(
  problem: string | null | undefined,
  errorType: string | null | undefined,
): 1 | 2 | 3 {
  const p = typeof problem === "string" ? problem : "";
  const e = typeof errorType === "string" ? errorType : null;

  // L3 indicators: multiply operator, or L3 counting words
  if (e === "multiply") return 3;
  if (HAS_MULTIPLY_OP.test(p)) return 3;
  if (HAS_COUNT_WORD.test(p)) return 3;

  // L2 indicators: carry/borrow with large numbers
  if (e === "carry" || e === "borrow") {
    const maxNum = maxNumberIn(p);
    if (maxNum >= L2_NUMBER_THRESHOLD) return 2;
  }

  // L1 by default (compute, vision_pending with small numbers, etc.)
  return 1;
}

function maxNumberIn(text: string): number {
  const matches = text.match(NUMBER_PATTERN);
  if (!matches) return 0;
  return Math.max(...matches.map(Number));
}
