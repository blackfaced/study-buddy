// web/games/candy-math-island/answer-compare.js
// =====================================================================
// `isAnswerCorrect(userInput, correctAnswer)` — single source of truth
// for kid-input vs expected-answer equality.
//
// Why this exists: the picker returns Question objects whose `answer`
// field is `number | string` — see the JSDoc on pickGenWithBias in
// pick-gen.js:
//
//   - Regular weighted-sampling path: `gen()` returns `{ answer: <num> }`
//     (e.g. `45 - 28 = 17` → answer: 17, a Number).
//   - Mistake-review path: pickGenWithBias wraps a server-returned
//     mistake whose `correct_answer` is stored as `TEXT` in SQLite
//     (db-migrate.ts:194), so the API always returns a String like
//     `"17"`.
//
// submitAnswer parses the kid's keypad input as a Number via
// `parseInt(raw, 10)`. A strict `===` comparison between the parsed
// Number and a String `correctAnswer` is **always false**, so the
// mistake-review path was silently marking every correct answer as
// wrong. This helper normalises both sides to a Number (or both to
// String fallback) before comparing.
//
// Edge cases handled here, not in submitAnswer:
//   - whitespace in user input (the keypad shouldn't emit it, but the
//     helper is reusable and trim is cheap)
//   - leading zeros (kid types "007" → 7)
//   - negative results (e.g. 5 - 12 = -7)
//   - non-numeric / empty input (returns false, never throws)
//
// Note: this is the consumer-side defence. The proper "make all
// answers Numbers" fix would be to coerce in the server (cast
// correct_answer on read), but we want the client to be robust
// against any future contract drift — e.g. a future server might add
// a new mistake source whose answer is again a String, and the
// client shouldn't silently regress.
// =====================================================================

/**
 * @param {string|number|null|undefined} userInput   kid's keypad text
 * @param {string|number|null|undefined} correctAnswer  expected answer (may be Number or String)
 * @returns {boolean} true iff both sides are non-empty and parse to the same Number
 */
export function isAnswerCorrect(userInput, correctAnswer) {
  // Normalise userInput: trim whitespace, treat null/empty as wrong
  // (don't throw — submitAnswer pre-validates with isNaN, but the
  // helper should still be safe in isolation).
  const rawUser = typeof userInput === "string" ? userInput.trim() : userInput;
  if (rawUser === "" || rawUser == null) return false;
  const userNum = Number(rawUser);
  if (!Number.isFinite(userNum)) return false;

  // Normalise correctAnswer: handle null/undefined safely.
  if (correctAnswer == null) return false;
  const correctNum = Number(correctAnswer);
  if (!Number.isFinite(correctNum)) return false;

  return userNum === correctNum;
}
