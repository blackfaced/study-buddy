// explanations.js
//
// Static errorType → explanation map for the inline wrong-answer card
// (issue #116, T4 of #34 split).
//
// v0.1 design: hand-written templates per errorType, no LLM. The
// kid-facing quiz candy-math-island declares 4 core errorTypes
// (compute / carry / borrow / multiply); each gets a short
// kid-friendly Chinese explanation. Anything else falls through to
// a generic "再仔细看看题目" so the card is never blank.
//
// Extending in v0.5+:
//   - Add more errorTypes (审题, 应用题 templates) when the generator
//     declares them
//   - Personalize via LLM (per-question explanations like the original
//     #34 spec called for)
//   - i18n (English translation) when the UI goes bilingual
//
// Used by web/games/candy-math-island/index.html: on a wrong answer,
// the answer handler looks up the question's errorType and shows the
// card with `getExplanation(errorType)`.

/**
 * @typedef {Object} Explanation
 * @property {string} title  Short kid-friendly label (e.g. "进位小提示")
 * @property {string} body   1-2 lines of explanation (kid-friendly Chinese)
 */

/** Static map of known errorTypes. Frozen so the module is read-only. */
export const EXPLANATIONS = Object.freeze({
  compute: Object.freeze({
    title: "✏️ 算错啦",
    body: "加减的时候, 再算一遍试试.\n把每个数字单独加或减, 慢慢来不着急.",
  }),
  carry: Object.freeze({
    title: "✏️ 进位小提示",
    body: "把大数凑到 10, 再加剩下的.\n例: 7+5 → 7+3=10, 10+2=12.",
  }),
  borrow: Object.freeze({
    title: "✏️ 退位小提示",
    body: "上面不够减时, 从前一位借 1 当 10.\n例: 13-7 → 13 借 1 = 10+3, 10-7=3, 再 1-1=0.",
  }),
  multiply: Object.freeze({
    title: "✏️ 乘法小提示",
    body: "乘法就是连加: 6×7 = 6+6+6+6+6+6+7 次.\n熟记 1-9 乘法表最快.",
  }),
});

/** Used when the errorType isn't one of the 4 core kid-facing types. */
export const GENERIC_FALLBACK = Object.freeze({
  title: "✏️ 再仔细看看",
  body: "看清楚题目要求, 再试一次.",
});

/**
 * Look up the explanation for an errorType.
 *
 * Behavior:
 *   - known errorType (one of the 4 core) → its entry
 *   - null / undefined / "" / unknown string → GENERIC_FALLBACK
 *
 * Pure: same input always returns the same reference (handy for
 * React-style memoization and unit-test assertions).
 *
 * @param {string|null|undefined} errorType
 * @returns {Readonly<Explanation>}
 */
export function getExplanation(errorType) {
  if (typeof errorType === "string" && errorType.length > 0) {
    const e = EXPLANATIONS[errorType];
    if (e) return e;
  }
  return GENERIC_FALLBACK;
}
