// server/src/candidate-promotion.ts
//
// T04-C: pure helper that builds the InsertMistakeInput from a
// candidate row + the kid's typed answer. Trivial composition so
// the workflow (T04C-3) and route (T04C-5) can both call it.
//
// The actual DB writes live in insertMistake() (mistake-api.ts) and
// are wired by candidate-workflow.ts. This file is pure data shape.

import type { InsertMistakeInput } from "./routes/mistake-api.js";

export interface CandidateForPromotion {
  id: number;
  childId: string;
  subject: string | null;
  problem: string | null;
  source: string; // "vision_page"
  errorType?: string | null;
}

export interface PromotionInput {
  candidate: CandidateForPromotion;
  userAnswer: string;
  correctAnswer: string;
  errorType?: string | null;
}

/**
 * Map a candidate + parent-supplied answers to the InsertMistakeInput
 * shape that mistake-api expects. The candidate's `problem` came
 * from the per-region OCR; the parent may have edited it via the
 * review UI (T04-D), in which case the route should pass the edited
 * `problem` through `candidate.problem` already.
 *
 * Returns null if the candidate has no problem text — the caller
 * should refuse to promote an empty problem (closure loop needs
 * something to act on).
 */
export function buildInsertMistakeInput(
  input: PromotionInput,
): InsertMistakeInput | null {
  const { candidate, userAnswer, correctAnswer, errorType } = input;
  if (!candidate.problem || candidate.problem.trim() === "") {
    return null;
  }
  return {
    childId: candidate.childId,
    problem: candidate.problem,
    userAnswer,
    correctAnswer,
    errorType: errorType ?? candidate.errorType ?? null,
    source: candidate.source,
    subject: candidate.subject ?? null,
  };
}
