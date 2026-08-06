// web/write/progress-header.js
//
// Persistent "第 N/M 字 · X" indicator for the write-app practice
// view. Solves issue #81: kid loses track of progress because the
// only feedback is the bottom-right status text, which gets
// overwritten on every phase transition.
//
// The header is a SEPARATE DOM element from the phase status —
// the phase status (animating / showing / writing / submitted)
// keeps its own text. The header just shows where the kid is in
// the session, all the time, in the same place.
//
// API:
//   renderProgressHeader({ sessionIdx, total, char }) -> { text, className }
//   The caller wires `text` to a dedicated #progress-header element.
//
// Pure: same input → same output. No DOM, no fetch.

/**
 * @param {{sessionIdx: number, total: number, char: string}} args
 * @returns {{text: string, className: string}}
 */
export function renderProgressHeader({ sessionIdx, total, char }) {
  if (typeof total !== "number" || total <= 0) {
    return { text: "", className: "progress-header empty" };
  }
  // Defensive: clamp sessionIdx to [0, total]
  const idx = Math.max(0, Math.min(sessionIdx, total - 1));
  const text = `第 ${idx + 1} / ${total} 字 · ${char}`;
  return { text, className: "progress-header" };
}
