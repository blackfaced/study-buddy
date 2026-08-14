// explanations.js
//
// Static errorType → explanation map for the inline wrong-answer card
// (issue #116, T4 of #34 split; #34b v0.5 expansion).
//
// v0.1: hand-written templates per errorType, no LLM. The kid-facing
// quiz candy-math-island declared 4 core errorTypes (compute / carry
// / borrow / multiply); each got a short kid-friendly Chinese
// explanation. Anything else fell through to a generic "再仔细看看题目".
//
// v0.5: extends coverage to the meta errorTypes the real kid data
// shows up most (审题 / 钟表 / 应用题 / vision_pending). v0.1 砍半
// left 8 vision_pending + 5 null + 1 审题 + 1 钟表 in the data, all
// falling through to the generic fallback. v0.5 gives each its own
// hand-tuned card so the kid actually sees useful coaching on the
// errors that are happening.
//
// LLM-generated per-question explanations remain a v1.0 design. v0.5
// keeps the no-LLM contract; cost is zero per request, quality is
// uniform, and templates are hand-tunable.
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
  // v0.5 expansion: covers the meta errorTypes the real kid data
  // (14 real mistakes: 8 vision_pending + 2 borrow + 2 compute +
  // 1 carry + 1 审题 + 1 钟表) was hitting the fallback for.
  审题: Object.freeze({
    title: "✏️ 看清题目",
    body: "题目要求啥先看清楚, 是问加还是减.\n把关键词圈出来, 再动笔.",
  }),
  钟表: Object.freeze({
    title: "✏️ 钟表题",
    body: "时针短, 分针长, 短的指小时.\n看准是几点几分, 一格是 5 分钟.",
  }),
  应用题: Object.freeze({
    title: "✏️ 应用题",
    body: "先把题目变成算式, 再算.\n已知啥, 要求啥, 一步步来.",
  }),
  vision_pending: Object.freeze({
    title: "✏️ 拍题确认",
    body: "题目没看清, 拍下来再确认一次.\n用 /buddy/ 的拍照功能最稳.",
  }),
});

/** Used when the errorType isn't one of the known kid-facing types. */
export const GENERIC_FALLBACK = Object.freeze({
  title: "✏️ 再仔细看看",
  body: "看清楚题目要求, 再试一次.",
});

/**
 * Look up the explanation for an errorType.
 *
 * Behavior:
 *   - known errorType (one of the 8 entries) → its entry
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
