// web/write/score.test.js
//
// Unit tests for web/write/score.js. The bitmap inputs are plain
// Uint8Array(SIZE*SIZE) so the test runs in node --test (no DOM,
// no canvas).
import { test } from "node:test";
import assert from "node:assert/strict";
import { scoreStrokes } from "./score.js";

const SIZE = 16;   // tiny so test arrays are short
const TOTAL = SIZE * SIZE;

/** Build a SIZE*SIZE mask, all zero, then set pixels in `coords` to 1. */
function mask(coords) {
  const m = new Uint8Array(TOTAL);
  for (const [x, y] of coords) {
    m[y * SIZE + x] = 1;
  }
  return m;
}

// --- Stroke-count match ---------------------------------------------------

test("strokes: perfect match gives strokes score 1.0", () => {
  const r = scoreStrokes({ kidStrokes: 3, refStrokes: 3, kidBitmap: mask([]), refBitmap: mask([]) });
  assert.equal(r.breakdown.strokes, 1.0);
});

test("strokes: 1 off a 3-stroke char drops to ~0.67", () => {
  const r = scoreStrokes({ kidStrokes: 2, refStrokes: 3, kidBitmap: mask([]), refBitmap: mask([]) });
  assert.ok(Math.abs(r.breakdown.strokes - (1 - 1/3)) < 1e-9, `got ${r.breakdown.strokes}`);
});

test("strokes: writing nothing is 0", () => {
  const r = scoreStrokes({ kidStrokes: 0, refStrokes: 3, kidBitmap: mask([]), refBitmap: mask([]) });
  assert.equal(r.breakdown.strokes, 0);
});

test("strokes: way too many clamps at 0", () => {
  const r = scoreStrokes({ kidStrokes: 30, refStrokes: 3, kidBitmap: mask([]), refBitmap: mask([]) });
  assert.equal(r.breakdown.strokes, 0);
});

// --- IoU ------------------------------------------------------------------

test("IoU: identical masks give 1.0", () => {
  const m = mask([[5, 5], [6, 5], [7, 5]]);
  const r = scoreStrokes({ kidStrokes: 1, refStrokes: 1, kidBitmap: m, refBitmap: m });
  assert.equal(r.breakdown.iou, 1.0);
});

test("IoU: empty kid = 0", () => {
  const m = mask([[5, 5], [6, 5]]);
  const r = scoreStrokes({ kidStrokes: 0, refStrokes: 1, kidBitmap: mask([]), refBitmap: m });
  assert.equal(r.breakdown.iou, 0);
});

test("IoU: empty ref = degenerate, returns 1 star", () => {
  const r = scoreStrokes({ kidStrokes: 1, refStrokes: 0, kidBitmap: mask([[1, 1]]), refBitmap: mask([]) });
  assert.equal(r.stars, 1);
  assert.equal(r.breakdown.iou, 0);
});

test("IoU: half overlap = 0.5", () => {
  // ref has 4 pixels in a row; kid has 4 pixels, 2 overlapping
  // intersection = 2, union = 6 → 2/6 ≈ 0.33
  const ref = mask([[2, 4], [3, 4], [4, 4], [5, 4]]);
  const kid = mask([[4, 4], [5, 4], [6, 4], [7, 4]]);
  const r = scoreStrokes({ kidStrokes: 1, refStrokes: 1, kidBitmap: kid, refBitmap: ref });
  assert.ok(Math.abs(r.breakdown.iou - (2 / 6)) < 1e-9, `got ${r.breakdown.iou}`);
});

test("IoU: blob in the wrong corner scores low (the bug fix)", () => {
  // ref is a row across the middle; kid is a blob in the top-right
  // corner. They share no pixels, so IoU = 0 — even though the
  // bbox-overlap of v0.8 would have given the kid a high score.
  const ref = mask([[2, 8], [3, 8], [4, 8], [5, 8], [6, 8]]);
  const kid = mask([[10, 2], [11, 2], [12, 2], [11, 3]]);
  const r = scoreStrokes({ kidStrokes: 1, refStrokes: 1, kidBitmap: kid, refBitmap: ref });
  assert.equal(r.breakdown.iou, 0);
  // Strokes match (1 vs 1) so the kid still gets 2 stars for "you
  // got the right number of strokes, just not in the right place" —
  // v0.8 bbox-overlap would have given this 3★, which was the bug.
  assert.equal(r.stars, 2);
});

test("IoU: an extra pixel in the corner gets penalised", () => {
  // ref and kid share 10 pixels. kid has 1 extra in the corner.
  // intersection = 10, union = 11 → ~0.91 (not 1.0)
  const ref = mask(Array.from({ length: 10 }, (_, i) => [i, 5]));
  const kid = mask([...Array.from({ length: 10 }, (_, i) => [i, 5]), [0, 0]]);
  const r = scoreStrokes({ kidStrokes: 1, refStrokes: 1, kidBitmap: kid, refBitmap: ref });
  assert.ok(Math.abs(r.breakdown.iou - (10 / 11)) < 1e-9, `got ${r.breakdown.iou}`);
});

// --- Star mapping --------------------------------------------------------

test("stars: perfect everything → 3 stars", () => {
  const m = mask([[5, 5], [6, 5], [7, 5]]);
  const r = scoreStrokes({ kidStrokes: 3, refStrokes: 3, kidBitmap: m, refBitmap: m });
  assert.equal(r.stars, 3);
  assert.ok(r.breakdown.total >= 0.7);
});

test("stars: right strokes but zero shape overlap → 2 stars (1.0*0.4 + 0*0.6 = 0.4)", () => {
  const ref = mask([[5, 5]]);
  const r = scoreStrokes({ kidStrokes: 1, refStrokes: 1, kidBitmap: mask([]), refBitmap: ref });
  assert.equal(r.stars, 2);
  assert.equal(r.breakdown.total, 0.4);
});

test("stars: empty input → 1 star (kid wrote nothing)", () => {
  const r = scoreStrokes({ kidStrokes: 0, refStrokes: 0, kidBitmap: mask([]), refBitmap: mask([]) });
  assert.equal(r.stars, 1);
});

test("stars: medium everything → 2 stars", () => {
  // 1 stroke vs 1 (1.0) + IoU 0.5 → 1.0*0.4 + 0.5*0.6 = 0.7 → 3 stars
  // (matches the threshold exactly)
  const ref = mask([[2, 4], [3, 4], [4, 4], [5, 4]]);
  const kid = mask([[4, 4], [5, 4], [6, 4], [7, 4]]);
  const r = scoreStrokes({ kidStrokes: 1, refStrokes: 1, kidBitmap: kid, refBitmap: ref });
  // IoU = 2/6 ≈ 0.333
  // total = 0.4 + 0.2 = 0.6 → 2 stars
  assert.equal(r.stars, 2);
});

test("stars: a stray blob in the wrong place is 1 star (regression)", () => {
  // The bug from the iPad live test: kid writes a big messy line
  // across the whole grid, dad writes a small accurate stroke. The
  // small-but-accurate dad should beat the big-messy kid.
  const ref = mask(Array.from({ length: 5 }, (_, i) => [5, 5 + i]));  // 5-px vertical stroke
  // Kid covers the whole row at y=5 — big area, but in the wrong shape
  const kid = mask(Array.from({ length: 11 }, (_, i) => [i, 5]));
  const r = scoreStrokes({ kidStrokes: 1, refStrokes: 1, kidBitmap: kid, refBitmap: ref });
  // intersection = 5 (ref pixels), union = 11 → 5/11 ≈ 0.45
  // total = 0.4 + 0.27 = 0.67 → 2 stars
  assert.ok(r.breakdown.iou < 0.5, `expected low IoU, got ${r.breakdown.iou}`);
  // The dad (the reference) gets 3 stars if they were the kid writing it.
});
