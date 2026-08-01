// web/write/show-flow.js
// =====================================================================
// Practice-view phase sequencer for the write app.
// =====================================================================
//
// v0.8.2 (issue #68): the v0.8.1 client.js had
//   setTimeout(doShowStuff, 100)
// inside startWord, with the comment "give HanziWriter 100ms to
// start". That was wrong on two counts:
//   (a) the timer fires regardless of whether animateCharacter is
//       done — on a 2.5s animation, the show window was opening
//       while the character was still being drawn (the "character
//       flickers" bug the user reported).
//   (b) the show window's "3s" was measured from that 100ms mark,
//       not from when the character was actually static.
//
// This module is the fix. It's a pure function: callers pass a
// HanziWriter-like `writer`, an `animDone` Promise (the
// `animateCharacter().onComplete` promise), a `showMs` window length,
// and callbacks for phase / opacity changes. It returns a `cancel`
// function that aborts any pending transitions.
//
// Timeline:
//   t=0               onPhase("animating")
//   animDone resolves onOpacity(level); onPhase("showing")
//   + showMs          writer.hideCharacter(); onPhase("writing")
//
// `cancel()` may be called any time. Calls already made are NOT
// rolled back (we don't track history); future transitions are
// suppressed.
// =====================================================================

/**
 * Run the practice-view show flow.
 *
 * @param {object}   args
 * @param {object}   args.writer       HanziWriter-like instance: must
 *                                     have `hideCharacter()`. The
 *                                     caller owns the
 *                                     `animateCharacter()` call and
 *                                     passes its done promise.
 * @param {Promise}  args.animDone     Resolves when the character
 *                                     animation finishes.
 * @param {number}   args.level        Opacity to settle to once the
 *                                     animation finishes. 1.0 = full.
 * @param {number}   args.showMs       How long the static character
 *                                     should be visible to the kid
 *                                     before the writing phase.
 * @param {function} args.onPhase      (phaseName) => void
 *                                     Called on every phase change.
 *                                     Phase names: animating, showing,
 *                                     writing.
 * @param {function} args.onOpacity    (opacity) => void
 *                                     Called once, when the animation
 *                                     finishes and we settle to
 *                                     `level`.
 * @returns {function(): void} cancel — call to abort any pending
 *                                  transitions.
 */
export function runShowFlow({ writer, animDone, level, showMs, onPhase, onOpacity }) {
  // Start: kid is watching the stroke replay.
  onPhase("animating");

  let cancelled = false;
  let showTimer = null;

  // When the animation finishes, settle to the per-attempt opacity
  // and start the 3s "look at the character" window. We chain on
  // `animDone` (not a magic-number setTimeout) so the show window
  // is in lock-step with the animation — even on slow devices
  // where animateCharacter takes longer.
  Promise.resolve(animDone).then(() => {
    if (cancelled) return;
    onOpacity(level);
    onPhase("showing");
    showTimer = setTimeout(() => {
      if (cancelled) return;
      // Tell HanziWriter to make the character disappear so the
      // kid can write. We do this BEFORE the writing phase so the
      // kid never sees a half-faded character.
      try {
        writer.hideCharacter();
      } catch {
        // If the writer is gone (kid navigated away), swallow —
        // onPhase("writing") still fires so the UI moves on.
      }
      onPhase("writing");
    }, showMs);
  });

  return function cancel() {
    cancelled = true;
    if (showTimer !== null) {
      clearTimeout(showTimer);
      showTimer = null;
    }
  };
}
