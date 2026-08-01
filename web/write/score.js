// web/write/score.js
// =====================================================================
// Write app scoring — pure functions, no DOM.
// =====================================================================
//
// Given a kid's per-stroke pixel mask and the reference character's
// per-stroke pixel mask (both are flat Uint8Array(SIZE*SIZE) where
// each byte is 0/1), decide a 1-3 star rating.
//
// Two dimensions, with explicit weights so the breakdown is auditable:
//
//   1. Stroke-count match (weight 0.4): did the kid write the right
//      number of strokes? 1.0 if kidStrokes == refStrokes, falls off
//      linearly with the gap (clamped at 0).
//
//   2. Shape IoU (weight 0.6): the kid's pixel mask intersected with
//      the reference's pixel mask, divided by their union. This is the
//      big change from v0.8 — v0.8 used bbox overlap which made
//      "write a big messy blob covering the whole 田字格" score higher
//      than "write a small accurate stroke" because it measured AREA
//      coverage rather than SHAPE overlap. IoU fixes that: a stray
//      blob off in the corner contributes to the union without
//      contributing to the intersection, so the kid's score is hurt
//      by ink they put in the wrong place. The reference's actual
//      pixel mask (rasterised from the HanziWriter SVG paths, not from
//      a bounding box) is what counts as "the correct shape".
//
// Star thresholds:
//   3 ★  total >= 0.7
//   2 ★  total >= 0.4
//   1 ★  otherwise (kid wrote something, but very off)
//
// All inputs are plain arrays of bytes so this module can be
// unit-tested in node --test (no DOM, no canvas).
// =====================================================================

/**
 * @param {object} input
 * @param {number}    input.kidStrokes  Number of strokes the kid drew
 * @param {number}    input.refStrokes  Number of strokes the reference has
 * @param {Uint8Array} input.kidBitmap  SIZE*SIZE bytes, 0/1
 * @param {Uint8Array} input.refBitmap  SIZE*SIZE bytes, 0/1
 * @param {number}    [input.size]     SIZE (defaults to kidBitmap.length, must match refBitmap)
 * @returns {{stars: 1|2|3, breakdown: {strokes: number, iou: number, total: number}}}
 */
export function scoreStrokes({ kidStrokes, refStrokes, kidBitmap, refBitmap, size }) {
  const actualSize = size || (kidBitmap ? kidBitmap.length : 0);
  // v0.1: if the reference is missing or degenerate, we can't really
  // score. Return 1 star (kid wrote SOMETHING, but we can't say
  // much about how it compares).
  if (!refBitmap || actualSize <= 0 || refStrokes <= 0) {
    return { stars: 1, breakdown: { strokes: 0, iou: 0, total: 0 } };
  }
  const strokesScore = strokeCountMatch(kidStrokes, refStrokes);
  const iouScore = bitmapIou(kidBitmap, refBitmap);
  const total = strokesScore * 0.4 + iouScore * 0.6;
  const stars = total >= 0.7 ? 3 : total >= 0.4 ? 2 : 1;
  return { stars, breakdown: { strokes: strokesScore, iou: iouScore, total } };
}

/** Linear falloff: 1.0 when equal, 0.0 when the gap reaches refStrokes. */
function strokeCountMatch(kid, ref) {
  if (ref <= 0) return kid === 0 ? 1 : 0;
  const gap = Math.abs(kid - ref) / ref;
  return clamp(1 - gap, 0, 1);
}

/**
 * IoU = intersection / union over two equal-size Uint8Array masks.
 * Returns 0 if either mask is empty.
 */
function bitmapIou(kid, ref) {
  if (!kid || !ref) return 0;
  if (kid.length !== ref.length) return 0;
  let inter = 0, union = 0;
  for (let i = 0; i < kid.length; i++) {
    const k = kid[i] & 1;
    const r = ref[i] & 1;
    if (k && r) inter++;
    if (k || r) union++;
  }
  if (union === 0) return 0;
  return inter / union;
}

function clamp(x, lo, hi) {
  return Math.max(lo, Math.min(hi, x));
}
