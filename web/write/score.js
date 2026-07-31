// web/write/score.js
// =====================================================================
// Write app scoring — pure functions, no DOM.
// =====================================================================
//
// Given a kid's per-stroke bounding boxes and the reference character's
// stroke count + bounding box, decide a 1-3 star rating.
//
// Two dimensions, with explicit weights so the breakdown is auditable:
//
//   1. Stroke-count match (weight 0.4): did the kid write the right
//      number of strokes? 1.0 if kidStrokes == refStrokes, falls off
//      linearly with the gap (clamped at 0).
//
//   2. Bbox overlap (weight 0.6): how much of the reference character
//      is "covered" by the union of the kid's stroke bboxes? Returns
//      a 0-1 ratio of intersection / reference area. Encourages the
//      kid to fill the 田字格 instead of writing in one corner.
//
// We intentionally leave out "stroke order" and "pressure" from the
// v0.1 score. Stroke order is a separate dimension worth a dedicated
// round (and the kid gets it for free from the animateCharacter
// preview). Pressure needs Apple Pencil + a real device to measure,
// and the user said "如果可以" — v0.2 if Pencil data is reliable.
//
// Star thresholds:
//   3 ★  total >= 0.7
//   2 ★  total >= 0.4
//   1 ★  otherwise (kid wrote something, but very off)
//
// All inputs are plain {x, y, w, h} objects so this module can be
// unit-tested in node --test (no DOM).
// =====================================================================

/**
 * @typedef {{x:number,y:number,w:number,h:number}} Bbox
 */

/**
 * @param {object} input
 * @param {number} input.kidStrokes  Number of strokes the kid drew
 * @param {number} input.refStrokes  Number of strokes the reference has
 * @param {Bbox[]}  input.kidBboxes  Kid's per-stroke bounding boxes
 * @param {Bbox}    input.refBbox    Reference character's bbox
 * @returns {{stars: 1|2|3, breakdown: {strokes: number, overlap: number, total: number}}}
 */
export function scoreStrokes({ kidStrokes, refStrokes, kidBboxes, refBbox }) {
  // v0.1: if the reference is missing or degenerate, we can't really
  // score. Return 1 star (kid wrote SOMETHING, but we can't say
  // much about how it compares).
  if (!refBbox || refBbox.w <= 0 || refBbox.h <= 0 || refStrokes <= 0) {
    return { stars: 1, breakdown: { strokes: 0, overlap: 0, total: 0 } };
  }
  const strokesScore = strokeCountMatch(kidStrokes, refStrokes);
  const overlapScore = bboxOverlap(kidBboxes, refBbox);
  const total = strokesScore * 0.4 + overlapScore * 0.6;
  const stars = total >= 0.7 ? 3 : total >= 0.4 ? 2 : 1;
  return { stars, breakdown: { strokes: strokesScore, overlap: overlapScore, total } };
}

/** Linear falloff: 1.0 when equal, 0.0 when the gap reaches refStrokes. */
function strokeCountMatch(kid, ref) {
  if (ref <= 0) return kid === 0 ? 1 : 0;
  const gap = Math.abs(kid - ref) / ref;
  return clamp(1 - gap, 0, 1);
}

/**
 * Union of kid bboxes, then intersect with ref bbox. Returns
 * intersection / ref area. If ref is missing or empty, returns 0.
 * (We compare against the reference area — not the union — so a kid
 * who writes everywhere gets a fair score, not penalized for "too
 * much ink".)
 */
function bboxOverlap(kidBboxes, ref) {
  if (!ref || ref.w <= 0 || ref.h <= 0) return 0;
  if (!kidBboxes || kidBboxes.length === 0) return 0;
  const union = unionBboxes(kidBboxes);
  const inter = intersectBbox(union, ref);
  const refArea = ref.w * ref.h;
  if (refArea <= 0) return 0;
  return clamp(inter.w * inter.h / refArea, 0, 1);
}

function unionBboxes(bs) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const b of bs) {
    if (!b) continue;
    if (b.x < minX) minX = b.x;
    if (b.y < minY) minY = b.y;
    if (b.x + b.w > maxX) maxX = b.x + b.w;
    if (b.y + b.h > maxY) maxY = b.y + b.h;
  }
  if (!isFinite(minX)) return { x: 0, y: 0, w: 0, h: 0 };
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

function intersectBbox(a, b) {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const r = Math.min(a.x + a.w, b.x + b.w);
  const bot = Math.min(a.y + a.h, b.y + b.h);
  if (r <= x || bot <= y) return { x: 0, y: 0, w: 0, h: 0 };
  return { x, y, w: r - x, h: bot - y };
}

function clamp(x, lo, hi) {
  return Math.max(lo, Math.min(hi, x));
}
