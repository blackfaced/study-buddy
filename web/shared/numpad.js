// web/shared/numpad.js
// =====================================================================
// On-screen number pad logic shared by the kid-facing games
// (issue #233). Pure functions, unit-tested in numpad.test.js; the
// per-game DOM wiring lives in each app's index.html.
//
// Design:
//   expectedAnswerLength(answer)  digits of a non-negative integer
//                                 answer; null when the answer is not a
//                                 plain integer (e.g. a mistake-review
//                                 question whose correct_answer column
//                                 holds non-numeric text) — those fall
//                                 back to manual ✓ submit.
//   shouldAutoSubmit(value, ans)  digit count reached → submit without
//                                 waiting for ✓ / Enter.
//   appendDigit / backspace       capped digit-string editing.
// =====================================================================

export function expectedAnswerLength(answer) {
  if (typeof answer === "string" && answer.trim() === "") return null;
  const n = typeof answer === "string" ? Number(answer) : answer;
  if (!Number.isInteger(n) || n < 0) return null;
  return String(n).length;
}

export function shouldAutoSubmit(value, answer) {
  const len = expectedAnswerLength(answer);
  return len !== null && /^\d+$/.test(value) && value.length === len;
}

/** Append one digit, capped at maxLen. Returns the new value. */
export function appendDigit(current, digit, maxLen) {
  if (current.length >= maxLen) return current;
  return current + digit;
}

export function backspace(current) {
  return current.slice(0, -1);
}
