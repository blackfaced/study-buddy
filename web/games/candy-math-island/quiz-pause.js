// web/games/candy-math-island/quiz-pause.js
//
// Pure helpers for the candy quiz pause feature (issue #83).
// Decoupled from DOM and from state shape so the renderer can
// wire it up however it likes.
//
// All functions are pure: same input → same output. They do NOT
// touch the DOM or call setInterval themselves. The caller (the
// quiz state machine) decides when to actually stop/restart the
// tick — that decision lives in state.paused.

/** Should the next tick() invocation decrement remainingMs? */
export function shouldTick(state) {
  return !state.paused;
}

/** Return a new state with paused toggled. Does not mutate. */
export function togglePause(state) {
  return { ...state, paused: !state.paused };
}

/** Return the button text for the current pause state. */
export function pauseButtonText(state) {
  return state.paused ? "继续" : "暂停";
}

/** Return the input/button-disabled flag. While paused the kid
 *  can't type or submit. The answer-input field and the keypad
 *  buttons should both be disabled. */
export function isInputDisabled(state) {
  return !!state.paused;
}
