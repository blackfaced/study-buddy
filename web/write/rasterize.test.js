// web/write/rasterize.test.js
//
// Unit tests for the parts of rasterize.js that don't depend on a
// real canvas. The actual paint step is covered by
// scripts/verify-write-v082-iou.js (Playwright), because the canvas
// APIs we depend on (Path2D, ctx.transform) aren't available in
// node --test without a heavy DOM mock.
//
// What we test here:
//   - parseCTMString: translate, scale, matrix, chained
//   - the chained transform matches what HanziWriter actually emits
//     (which is the "in-the-wild" CTM that caused the v0.8.1 score=0
//     bug when we forgot to apply it)
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCTMString } from "./rasterize.js";

const I = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };  // identity

// --- Identity / empty --------------------------------------------------

test("parseCTMString: empty string is identity", () => {
  assert.deepEqual(parseCTMString(""), I);
});

test("parseCTMString: null is identity", () => {
  assert.deepEqual(parseCTMString(null), I);
});

test("parseCTMString: 'none' is identity", () => {
  assert.deepEqual(parseCTMString("none"), I);
});

// --- translate ---------------------------------------------------------

test("parseCTMString: translate(5, 50) gives e=5, f=50", () => {
  const m = parseCTMString("translate(5, 50)");
  assert.deepEqual(m, { a: 1, b: 0, c: 0, d: 1, e: 5, f: 50 });
});

test("parseCTMString: translate(7) defaults ty to 0", () => {
  const m = parseCTMString("translate(7)");
  assert.equal(m.e, 7);
  assert.equal(m.f, 0);
});

// --- scale -------------------------------------------------------------

test("parseCTMString: scale(2) gives a=d=2, others 0", () => {
  const m = parseCTMString("scale(2)");
  assert.deepEqual(m, { a: 2, b: 0, c: 0, d: 2, e: 0, f: 0 });
});

test("parseCTMString: scale(2, 3) gives a=2, d=3", () => {
  const m = parseCTMString("scale(2, 3)");
  assert.deepEqual(m, { a: 2, b: 0, c: 0, d: 3, e: 0, f: 0 });
});

// --- matrix ------------------------------------------------------------

test("parseCTMString: matrix(1,2,3,4,5,6) is identity-like but with rotation", () => {
  assert.deepEqual(parseCTMString("matrix(1,2,3,4,5,6)"), { a: 1, b: 2, c: 3, d: 4, e: 5, f: 6 });
});

// --- Chained: the HanziWriter case --------------------------------------

test("parseCTMString: HanziWriter's actual transform gives scale(0.576) + translate(5, 523)", () => {
  // HanziWriter emits `transform="translate(5, 523.5546875) scale(0.576171875, -0.576171875)"`
  // (per the d="M 25 421 ..." paths we saw in the live test).
  // parseCTMString composes left-to-right in CSS order: the rightmost
  // transform is applied first to the point. So a point (x, y) in the
  // path becomes:
  //   scale(0.576, -0.576) → (0.576x, -0.576y)
  //   translate(5, 523)    → (0.576x + 5, -0.576y + 523)
  // So the CTM matrix should be:
  //   a = 0.576, b = 0, c = 0, d = -0.576, e = 5, f = 523
  const m = parseCTMString("translate(5, 523.5546875) scale(0.576171875, -0.576171875)");
  assert.ok(Math.abs(m.a - 0.576171875) < 1e-9, `a got ${m.a}`);
  assert.equal(m.b, 0);
  assert.equal(m.c, 0);
  assert.ok(Math.abs(m.d - -0.576171875) < 1e-9, `d got ${m.d}`);
  assert.ok(Math.abs(m.e - 5) < 1e-9, `e got ${m.e}`);
  assert.ok(Math.abs(m.f - 523.5546875) < 1e-9, `f got ${m.f}`);
});

test("parseCTMString: chained translate + scale — the order matters", () => {
  // 'translate(100, 200) scale(2)' means: scale first, then translate.
  // So a point (1, 1) in path becomes (2, 2) after scale, then
  // (102, 202) after translate. CTM a=2, e=100.
  const m = parseCTMString("translate(100, 200) scale(2)");
  assert.equal(m.a, 2);
  assert.equal(m.e, 100);
  assert.equal(m.f, 200);
});

test("parseCTMString: 'scale(2) translate(100, 200)' composes to matrix(2,0,0,2,100,200)", () => {
  // SVG transform chain: "A B" means apply B first then A. So
  // "scale(2) translate(100, 200)" means translate first, then
  // scale: point (1, 1) → (101, 201) → (202, 402). The CTM is
  // M_translate * M_scale = matrix(2, 0, 0, 2, 100, 200).
  // (CSS transform-origin and shorthand ordering is different; this
  // is the SVG attribute interpretation.)
  const m = parseCTMString("scale(2) translate(100, 200)");
  assert.equal(m.a, 2);
  assert.equal(m.b, 0);
  assert.equal(m.c, 0);
  assert.equal(m.d, 2);
  assert.equal(m.e, 200);
  assert.equal(m.f, 400);
});

// --- Robustness --------------------------------------------------------

test("parseCTMString: unknown function falls back to identity", () => {
  const m = parseCTMString("rotate(45)");
  assert.deepEqual(m, I);
});

test("parseCTMString: empty translate args default to 0", () => {
  const m = parseCTMString("translate()");
  assert.deepEqual(m, I);
});

test("parseCTMString: multiple spaces between args are tolerated", () => {
  const m = parseCTMString("translate(  5,  50  )");
  assert.deepEqual(m, { a: 1, b: 0, c: 0, d: 1, e: 5, f: 50 });
});
