// web/write/score.test.js
//
// Unit tests for web/write/score.js. No DOM dependency — bboxes are
// passed in as plain {x,y,w,h} so this runs under node --test.
import { test } from "node:test";
import assert from "node:assert/strict";
import { scoreStrokes } from "./score.js";

const REF = { x: 0, y: 0, w: 100, h: 100 };        // 100x100 reference char
const REF_BIG = { x: 0, y: 0, w: 200, h: 200 };   // bigger char

// --- Stroke-count match ---------------------------------------------------

test("strokes: perfect match gives strokes score 1.0", () => {
  const r = scoreStrokes({ kidStrokes: 3, refStrokes: 3, kidBboxes: [], refBbox: REF });
  assert.equal(r.breakdown.strokes, 1.0);
});

test("strokes: 1 off a 3-stroke char drops to ~0.67", () => {
  const r = scoreStrokes({ kidStrokes: 2, refStrokes: 3, kidBboxes: [], refBbox: REF });
  assert.ok(Math.abs(r.breakdown.strokes - (1 - 1/3)) < 1e-9, `got ${r.breakdown.strokes}`);
});

test("strokes: writing nothing is 0", () => {
  const r = scoreStrokes({ kidStrokes: 0, refStrokes: 3, kidBboxes: [], refBbox: REF });
  assert.equal(r.breakdown.strokes, 0);
});

test("strokes: way too many clamps at 0", () => {
  const r = scoreStrokes({ kidStrokes: 30, refStrokes: 3, kidBboxes: [], refBbox: REF });
  assert.equal(r.breakdown.strokes, 0);
});

// --- Bbox overlap ---------------------------------------------------------

test("overlap: full coverage of ref gives 1.0", () => {
  const r = scoreStrokes({
    kidStrokes: 3, refStrokes: 3,
    kidBboxes: [REF],
    refBbox: REF,
  });
  assert.equal(r.breakdown.overlap, 1.0);
});

test("overlap: half coverage of ref gives 0.5", () => {
  const half = { x: 0, y: 0, w: 50, h: 100 };   // covers 50% of ref area
  const r = scoreStrokes({
    kidStrokes: 3, refStrokes: 3,
    kidBboxes: [half],
    refBbox: REF,
  });
  assert.equal(r.breakdown.overlap, 0.5);
});

test("overlap: nothing written is 0", () => {
  const r = scoreStrokes({
    kidStrokes: 0, refStrokes: 3,
    kidBboxes: [],
    refBbox: REF,
  });
  assert.equal(r.breakdown.overlap, 0);
});

test("overlap: outside the ref bbox is 0", () => {
  const far = { x: 500, y: 500, w: 50, h: 50 };
  const r = scoreStrokes({
    kidStrokes: 1, refStrokes: 3,
    kidBboxes: [far],
    refBbox: REF,
  });
  assert.equal(r.breakdown.overlap, 0);
});

test("overlap: scattered strokes union covers more than each individually", () => {
  // 4 small strokes that together cover the ref
  const strokes = [
    { x: 0, y: 0, w: 50, h: 50 },
    { x: 50, y: 0, w: 50, h: 50 },
    { x: 0, y: 50, w: 50, h: 50 },
    { x: 50, y: 50, w: 50, h: 50 },
  ];
  const r = scoreStrokes({
    kidStrokes: 4, refStrokes: 4,
    kidBboxes: strokes,
    refBbox: REF,
  });
  assert.equal(r.breakdown.overlap, 1.0);
});

test("overlap: ref area dominates when kid union is bigger than ref", () => {
  // Kid writes 200x200 covering a 100x100 ref — should still be 1.0,
  // we use ref area as denominator (kid not penalized for ink).
  const huge = { x: 0, y: 0, w: 200, h: 200 };
  const r = scoreStrokes({
    kidStrokes: 1, refStrokes: 1,
    kidBboxes: [huge],
    refBbox: REF,
  });
  assert.equal(r.breakdown.overlap, 1.0);
});

// --- Star mapping --------------------------------------------------------

test("stars: perfect everything → 3 stars", () => {
  const r = scoreStrokes({
    kidStrokes: 3, refStrokes: 3,
    kidBboxes: [REF], refBbox: REF,
  });
  assert.equal(r.stars, 3);
  assert.ok(r.breakdown.total >= 0.7);
});

test("stars: right strokes but zero overlap → 1-2 stars (likely 2)", () => {
  const r = scoreStrokes({
    kidStrokes: 3, refStrokes: 3,
    kidBboxes: [], refBbox: REF,
  });
  // 1.0 * 0.4 + 0 * 0.6 = 0.4 → 2 stars
  assert.equal(r.stars, 2);
  assert.equal(r.breakdown.total, 0.4);
});

test("stars: only half overlap, no stroke match → 1 star", () => {
  const half = { x: 0, y: 0, w: 50, h: 100 };
  const r = scoreStrokes({
    kidStrokes: 30, refStrokes: 3,
    kidBboxes: [half], refBbox: REF,
  });
  // 0 * 0.4 + 0.5 * 0.6 = 0.3 → 1 star
  assert.equal(r.stars, 1);
});

test("stars: empty input → 1 star (kid wrote nothing)", () => {
  const r = scoreStrokes({
    kidStrokes: 0, refStrokes: 0,
    kidBboxes: [], refBbox: { x: 0, y: 0, w: 0, h: 0 },
  });
  assert.equal(r.stars, 1);
});

test("stars: decent strokes + decent overlap → 2 stars", () => {
  // 4 strokes vs 3 (score = 0.67), 0.5 overlap → 0.67*0.4 + 0.5*0.6 = 0.57
  const half = { x: 0, y: 0, w: 50, h: 100 };
  const r = scoreStrokes({
    kidStrokes: 4, refStrokes: 3,
    kidBboxes: [half], refBbox: REF,
  });
  assert.equal(r.stars, 2);
  assert.ok(r.breakdown.total > 0.4 && r.breakdown.total < 0.7);
});
