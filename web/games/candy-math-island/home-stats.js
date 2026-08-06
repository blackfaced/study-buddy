// web/games/candy-math-island/home-stats.js
//
// Renders the candy home-page today-strip. Two states:
//
//   first-time (today == null OR today.totalQuestions == 0):
//     <div class="today-strip first-time">今天还没玩过~ 来挑战 60 秒吧！</div>
//
//   stats (today.totalQuestions > 0):
//     <div class="today-strip stats">
//       <span>今日 <b>7</b> 题</span>
//       <span>正确率 <b>78%</b></span>
//       <span>连玩 <b>1</b> 次</span>
//     </div>
//
// Pure function: no DOM, no fetch, just a transform. Caller wires the
// resulting HTML into document.getElementById("today-strip") via
// innerHTML or replaceChildren.

const FIRST_TIME_TEXT = "今天还没玩过~ 来挑战 60 秒吧！";

/**
 * @typedef {Object} TodayStat
 * @property {number} totalQuestions
 * @property {number} correctRate  0-100, may be 0 when totalQuestions==0
 * @property {number} sessionCount
 */

/**
 * @typedef {Object} HomeStrip
 * @property {"first-time"|"stats"} className
 * @property {string} html  HTML to inject into #today-strip
 */

/** Decide which state to render. Pure: same input → same output. */
export function renderHomeStrip(today) {
  if (!today || !today.totalQuestions || today.totalQuestions <= 0) {
    return {
      className: "first-time",
      html: `<div class="today-strip first-time">${FIRST_TIME_TEXT}</div>`,
    };
  }
  return {
    className: "stats",
    html: `<div class="today-strip stats">
      <span>今日 <b>${today.totalQuestions}</b> 题</span>
      <span>正确率 <b>${today.correctRate}%</b></span>
      <span>连玩 <b>${today.sessionCount}</b> 次</span>
    </div>`,
  };
}

// Expose on window so the inline <script> in index.html can call it
// without an import statement (which inline scripts can't do).
if (typeof window !== "undefined") {
  window.CandyHomeStats = { renderHomeStrip };
}
