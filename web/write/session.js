// web/write/session.js
// =====================================================================
// Write session state machine — extracted from client.js (PR 7).
// =====================================================================
//
// The "5 chars per session" + current-item-pointer logic. The rest
// of client.js (kid-input, startWord, submitCurrent) reads from
// this module and advances it.
//
// The state is held in a closure so each `createWriteSession()`
// call is independent (handy for tests).
//
// Public API:
//   createWriteSession({ initialLibrary })
//     .library       live list of available chars (read + write)
//     .session       current 5-item session (read-only externally;
//                    mutate items via currentItem, not the array)
//     .sessionIdx    index of the current item
//     .currentItem   shortcut for session[sessionIdx] (may be undefined)
//     .isDone        true when sessionIdx >= session.length OR
//                    session is empty
//     .start()       populate session from library
//     .next()        advance sessionIdx
//     .retry()       keep sessionIdx, clear currentItem.strokes
// =====================================================================

const SESSION_LENGTH = 5;

export function createWriteSession({ initialLibrary = [] } = {}) {
  let library = initialLibrary;
  let session = [];
  let sessionIdx = 0;

  function start() {
    if (library.length === 0) {
      session = [];
      sessionIdx = 0;
      return;
    }
    // Round-robin: if the library has < SESSION_LENGTH chars, wrap
    // so the kid always has a 5-item session to walk through.
    const next = [];
    for (let i = 0; i < SESSION_LENGTH; i++) {
      const w = library[i % library.length];
      next.push({
        char: w.char,
        attemptCount: w.attemptCount ?? 0,
        lastShownAt: null,
        opacity: 1.0,
        strokes: [],
      });
    }
    session = next;
    sessionIdx = 0;
  }

  function next() {
    if (sessionIdx < session.length) sessionIdx++;
  }

  function retry() {
    // Keep sessionIdx, reset the per-item scratch state. The
    // HanziWriter instance is re-created in startWord, so we
    // don't need to clear it here.
    const it = session[sessionIdx];
    if (it) it.strokes = [];
  }

  return {
    get library() { return library; },
    set library(v) { library = v; },
    get session() { return session; },
    get sessionIdx() { return sessionIdx; },
    get currentItem() { return session[sessionIdx]; },
    get isDone() { return sessionIdx >= session.length; },
    start,
    next,
    retry,
  };
}
