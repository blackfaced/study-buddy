// web/write/char-center.js
// =====================================================================
// Visual centering of the HanziWriter character on the stage grid.
// =====================================================================
//
// Why this module exists (issue: phone "字看不全")
// -----------------------------------------------
// HanziWriter places each glyph inside a `<g transform="...">` using
// its own metadata. Different characters land in different parts of
// the 600×600 viewBox, and a wide character like "一" can span
// 90%+ of the viewBox width. With the previous "padding: 100" tuning
// the rendered character extended past the right edge of a 358-px
// phone stage by 100+ px, so the kid only saw part of the glyph.
// Worse, a fixed padding can't be right for every viewport — a
// ~358-px phone stage and a ~560-px iPad stage need different scales.
//
// What this module does
// ---------------------
// 1. Measures the HanziWriter <g>'s rendered screen bbox.
// 2. Computes a scale to fit the character into the stage with a
//    configurable margin (defaults to 10% on every side).
// 3. Computes a translate to land the (scaled) character on the
//    stage's grid center.
// 4. Applies `translate(...) scale(...)` to a wrapper element that
//    contains BOTH #hanzi-target and #kid-svg, so the reference
//    character and the kid's stroke layer move together — the kid's
//    strokes stay aligned with the reference even after the transform.
//
// Multi-viewport behavior
// -----------------------
// The same code handles phone / pad / desktop because it always
// re-measures the rendered bbox. A 358-px stage will scale wide
// characters down; a 560-px stage will leave them at 1×. Tall
// characters on a phone get scaled by their height instead of width.
// Tiny characters are never upscaled (scale caps at 1) so they keep
// their native pixel density.
//
// Failure modes (return null, don't throw)
// ----------------------------------------
// - No SVG mounted inside hanziTarget yet (HanziWriter hasn't run).
// - The SVG has no <g transform="..."> child (data not loaded).
// - The g's bbox is 0×0 (nothing to center).
// - kidSvg's parent is the stage (no wrapper) — we'd otherwise break
//   the kid's coordinate system by transforming one of the two.
//   Caller must add a wrapper layer; see index.html.
//
// Public API
// ----------
// - centerCharacter({ stage, hanziTarget, kidSvg, margin })
//     pure-function: measures + applies transform. Returns the
//     { dx, dy, scale, charBBox } or null on failure. Synchronous.
// - centerWhenReady({ ... })
//     async wrapper that uses MutationObserver to wait for the
//     HanziWriter data to load, then calls centerCharacter. Resolves
//     with the same value (or null on timeout). Browser-only — tests
//     exercise centerCharacter directly.
// =====================================================================

const DEFAULT_MARGIN = 0.1;  // 10% of stage dimension on each side

/**
 * Center the HanziWriter character on the stage.
 *
 * @param {object}  args
 * @param {Element} args.stage       The .practice-stage element.
 * @param {Element} args.hanziTarget The #hanzi-target div HanziWriter mounts into.
 * @param {Element} args.kidSvg      The #kid-svg element. Used to find the wrapper
 *                                   layer (kidSvg.parentElement) — must NOT be the
 *                                   stage itself, or we can't transform both
 *                                   hanzi-target and kid-svg together.
 * @param {number}  [args.margin=0.1] Fraction of stage dimension kept empty on
 *                                   each side. 0.1 = 10% margin.
 *
 * @returns {{dx:number,dy:number,scale:number,charBBox:DOMRect}|null}
 *          The transform that was applied (or null on failure).
 */
export function centerCharacter({ stage, hanziTarget, kidSvg, margin = DEFAULT_MARGIN }) {
  if (!stage || !hanziTarget) return null;

  // 1. Find the HanziWriter <g transform="..."> — that's the glyph
  //    container whose rendered bbox is the character's actual area.
  const svg = hanziTarget.querySelector("svg");
  if (!svg) return null;
  const g = svg.querySelector("g[transform]");
  if (!g) return null;

  // 2. Measure. A 0×0 bbox means the data hasn't been rendered yet
  //    (HanziWriter still fetching from the CDN) — caller can retry
  //    via centerWhenReady.
  const gRect = g.getBoundingClientRect();
  if (gRect.width === 0 || gRect.height === 0) return null;
  const stageRect = stage.getBoundingClientRect();
  if (stageRect.width === 0 || stageRect.height === 0) return null;

  // 3. Sanity-check the wrapper layer. The kid-svg must share a
  //    parent with hanzi-target so we can transform both at once.
  const layer = kidSvg && kidSvg.parentElement;
  if (!layer || layer === stage) return null;
  if (hanziTarget.parentElement !== layer) return null;

  // 4. Coords-system alignment (the whole point of the module).
  //    HanziWriter places the glyph at a character-specific position
  //    inside the SVG (e.g. "一" lands at user-coord (284, 294), not
  //    at the SVG center (300, 300)). The kid-svg, by contrast, has
  //    viewBox 0 0 600 600, so a tap at the SVG's visible center
  //    lands at viewBox (300, 300). Two different "centers" → the
  //    kid's ink and the reference ink don't overlap, IoU is ~0,
  //    and the score is meaningless. The fix: set the refSvg's
  //    viewBox so the g's center maps to viewBox (300, 300). Then
  //    both SVGs are in the same coord system, both "centers" are
  //    the same point, and the kid's stroke at viewBox (300, 300)
  //    aligns with the g's center.
  //
  //    The g's screenCTM maps g's-LOCAL coord to screen. The g's
  //    LOCAL coord is the coord system inside the g (before the
  //    g's own transform). To get the g's user-coord center (i.e.
  //    where the g's content actually is in SVG user space, after
  //    the g's transform is applied), we have to:
  //      a) invert gScreenCTM to find the g's local center, then
  //      b) apply the g's transform (g.getCTM() returns the g's
  //         transform in SVG user coord) to lift the local center
  //         into SVG user coord.
  //    The intermediate step is necessary because gScreenCTM and
  //    gCTM are different matrices — gScreenCTM includes all
  //    ancestor transforms, gCTM is just the g's own.
  const screenCTM = g.getScreenCTM();
  const gCTM = g.getCTM();
  if (!screenCTM || !gCTM) return null;
  // a) screen → g's local coord
  const sDet = screenCTM.a * screenCTM.d - screenCTM.b * screenCTM.c;
  if (sDet === 0) return null;
  const sInvA = screenCTM.d / sDet;
  const sInvB = -screenCTM.b / sDet;
  const sInvC = -screenCTM.c / sDet;
  const sInvD = screenCTM.a / sDet;
  const sInvE = (screenCTM.c * screenCTM.f - screenCTM.d * screenCTM.e) / sDet;
  const sInvF = (screenCTM.b * screenCTM.e - screenCTM.a * screenCTM.f) / sDet;
  const gCx = gRect.left + gRect.width / 2;
  const gCy = gRect.top + gRect.height / 2;
  // g's local center (pre g's own transform)
  const lCx = sInvA * gCx + sInvC * gCy + sInvE;
  const lCy = sInvB * gCx + sInvD * gCy + sInvF;
  // b) g's local center → SVG user coord via the g's transform
  const gux = gCTM.a * lCx + gCTM.c * lCy + gCTM.e;
  const guy = gCTM.b * lCx + gCTM.d * lCy + gCTM.f;
  // Set the SVG's viewBox so user-coord (gux, guy) lands at
  // viewBox (300, 300). The viewBox origin is (gux - 300, guy - 300).
  // We keep the viewBox square (600x600) so the SVG aspect matches
  // the kid-svg's 600x600 viewBox.
  svg.setAttribute("viewBox", `${gux - 300} ${guy - 300} 600 600`);

  // 5. Re-measure after the viewBox change. The g is now at the
  //    SVG's CSS center (which is the layer's local center, since
  //    the SVG fills the layer).
  const newGRect = g.getBoundingClientRect();
  if (newGRect.width === 0 || newGRect.height === 0) return null;

  // 6. Scale to fit. min() picks the binding axis (the one that's
  //    most crowded). Cap at 1 so tiny characters stay sharp instead
  //    of being upscaled into pixelated mush.
  const availW = stageRect.width * (1 - margin * 2);
  const availH = stageRect.height * (1 - margin * 2);
  const scale = Math.min(availW / newGRect.width, availH / newGRect.height, 1);

  // 7. Apply. The g is now at the CSS center, and the layer's
  //    transform-origin is also the layer's center (= CSS center,
  //    since the SVG fills the layer). A pure scale(s) around the
  //    center keeps the g at the layer's center (which is the
  //    stage's center in viewport). No translate needed.
  const dx = 0;
  const dy = 0;
  layer.style.transform = `translate(${dx}px, ${dy}px) scale(${scale})`;

  return { dx, dy, scale, charBBox: newGRect };
}

/**
 * Wait until the character data has loaded (HanziWriter populates
 * the SVG <g> with paths after fetching from the CDN asynchronously)
 * and then call centerCharacter. Resolves with the same value as
 * centerCharacter, or null if the timeout fires first.
 *
 * Browser-only — uses MutationObserver. Tests should exercise the
 * synchronous centerCharacter() directly.
 */
export function centerWhenReady({ stage, hanziTarget, kidSvg, margin, timeoutMs = 2000 }) {
  return new Promise((resolve) => {
    // First try immediately — on a hot cache (e.g. retry on the
    // same char) the data is already there and the MutationObserver
    // wouldn't fire (it doesn't trigger for pre-existing children).
    const immediate = centerCharacter({ stage, hanziTarget, kidSvg, margin });
    if (immediate) {
      resolve(immediate);
      return;
    }

    // Watch for path additions inside the SVG. The observer fires
    // for any subtree change, but we re-check the g's bbox each
    // time and resolve as soon as it's non-zero.
    const observer = new MutationObserver(() => {
      const result = centerCharacter({ stage, hanziTarget, kidSvg, margin });
      if (result) {
        observer.disconnect();
        resolve(result);
      }
    });
    observer.observe(hanziTarget, { childList: true, subtree: true });

    setTimeout(() => {
      observer.disconnect();
      resolve(null);
    }, timeoutMs);
  });
}
