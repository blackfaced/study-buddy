// server/src/similar-problems.ts
//
// T07: pure generator for similar math problems. Given a problem
// string and the error type that produced the mistake, produce
// `count` variants that exercise the same operation and the same
// failure mode but with different numbers — never just copies of
// the original.
//
// v0.1 砍半: supports simple 2-operand add/subtract only. Returns
// an empty array for anything else (downgrade gracefully — the
// caller surfaces a "巩固 not available for this problem" UX).

const DIGITS = [3, 4, 5, 6, 7, 8, 9, 11, 12, 13, 14, 15, 16, 17, 18];

export interface SimilarProblem {
  problem: string;
  correctAnswer: string;
}

interface ParsedAddSub {
  op: "+" | "-";
  a: number;
  b: number;
}

function parseAddSub(problem: string): ParsedAddSub | null {
  // Match "<digits> + <digits>" or "<digits> - <digits>". Tolerate
  // "3+4", "3 + 4", "3+ 4", " 3 + 4 ", and a trailing "=?" or "=".
  const m = problem.match(/^\s*(\d+)\s*([+-])\s*(\d+)\s*(?:[=?].*)?$/);
  if (!m) return null;
  const a = Number(m[1]);
  const b = Number(m[3]);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  // For subtraction, we need a >= b so the answer is non-negative.
  if (m[2] === "-" && a < b) {
    return { op: "-", a: b, b: a }; // swap to keep a >= b
  }
  return { op: m[2] as "+" | "-", a, b };
}

/**
 * Generate `count` similar problems. Same operation, same error
 * trap, different numbers. The numbers are deterministically chosen
 * from a small digit set; we avoid returning duplicates of the
 * original problem and avoid returning duplicates of each other.
 *
 * `rng` is injectable for testability — pass a seeded function in
 * tests; defaults to Math.random.
 */
export function generateSimilarProblems(
  problem: string,
  errorType: string | null,
  count = 2,
  rng: () => number = Math.random,
): SimilarProblem[] {
  const parsed = parseAddSub(problem);
  if (!parsed) return [];

  // errorType guides the number range so the variant has the same
  // failure trap. compute → small nums (no carry), borrow → bigger
  // minuend. Falls back to a generic mid range.
  const pickDigits = (): number[] => {
    if (errorType === "compute") return [3, 4, 5, 6, 7, 8];
    if (errorType === "borrow") return [11, 12, 13, 14, 15, 16, 17, 18];
    if (errorType === "carry") return [6, 7, 8, 9];
    return DIGITS;
  };

  const out: SimilarProblem[] = [];
  const seen = new Set<string>([`${parsed.a}${parsed.op}${parsed.b}`]);
  const pool = pickDigits();

  for (let i = 0; i < count * 3 && out.length < count; i++) {
    const a = pool[Math.floor(rng() * pool.length)];
    const b = pool[Math.floor(rng() * pool.length)];
    let next: ParsedAddSub;
    if (parsed.op === "+") {
      next = { op: "+", a, b };
    } else {
      // keep a >= b so answer is non-negative
      next = a >= b ? { op: "-", a, b } : { op: "-", a: b, b: a };
    }
    const key = `${next.a}${next.op}${next.b}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const correct = next.op === "+" ? next.a + next.b : next.a - next.b;
    out.push({
      problem: `${next.a} ${next.op} ${next.b}`,
      correctAnswer: String(correct),
    });
  }
  return out;
}
