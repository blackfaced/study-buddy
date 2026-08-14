// web/games/multiplication-drill/pick-gen.js
// =====================================================================
// #38 (1-9 multiplication drill) — pure question generator.
//
// Two helpers:
//   - pickMultiplicationQuestion(rng) -> { a, b, answer, problem }
//   - makeMultiplicationTable()       -> string
//
// ESM module (uses `export`) because the browser side imports it as
// `import { ... } from "./pick-gen.js"` from the multiplication-drill
// HTML. The Node test runner uses dynamic `import('./pick-gen.js')`
// to load it.
//
// `rng` is injected so tests can drive it deterministically; the
// real UI uses Math.random wrapped in a closure. `a` and `b` are
// sampled independently from [1, 9] so the distribution is uniform
// over the 81-cell table (kid practices 1×1, 9×9, and everything
// in between with equal probability).
// =====================================================================

/**
 * Pick a random 1-9 multiplication question.
 *
 * @param {() => number} rng Returns a float in [0, 1).
 * @returns {{ a: number, b: number, answer: number, problem: string }}
 */
export function pickMultiplicationQuestion(rng) {
  const a = Math.floor(rng() * 9) + 1;
  const b = Math.floor(rng() * 9) + 1;
  return {
    a,
    b,
    answer: a * b,
    problem: `${a} × ${b} = ?`,
  };
}

/**
 * Render the full 1-9 × 1-9 multiplication table as a multi-line
 * string. Used as the "show me the table" hint when the kid gets a
 * question wrong — they can scan the row/column of the answer
 * without leaving the question screen.
 *
 * Rows are the left operand (1, 2, ..., 9), columns are the right
 * operand (1, 2, ..., 9). Cell format is "{a}×{b}={a*b}" with two
 * spaces between cells for a clean columnar layout in plain text.
 *
 * @returns {string} 9 lines, each with 9 cells separated by two spaces.
 */
export function makeMultiplicationTable() {
  const lines = [];
  for (let a = 1; a <= 9; a += 1) {
    const cells = [];
    for (let b = 1; b <= 9; b += 1) {
      cells.push(`${a}×${b}=${a * b}`);
    }
    lines.push(cells.join("  "));
  }
  return lines.join("\n");
}
