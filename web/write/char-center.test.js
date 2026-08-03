// web/write/char-center.test.js
//
// Tests for the char-center module that visually centers the
// HanziWriter character on the stage grid, with scale-to-fit.
//
// Why this module exists (issue: phone "字看不全"): HanziWriter
// positions each glyph using its own metadata — different characters
// land in different parts of the 600×600 viewBox, and a wide
// character like "一" can span 90%+ of the viewBox. With the
// previous "padding:100" tuning, "一" still extended past the right
// edge of a 358-px phone stage by 100+ px, so the kid only saw
// part of the glyph. Worse, a fixed padding can't be right for
// every viewport — phone (~358 stage) and pad (~560 stage) need
// different scales.
//
// The right answer is to measure the rendered character and apply
// a CSS transform that fits it to the stage with margin and centers
// it on the grid. Tests below cover the pure-function path; the
// browser-only MutationObserver wait (centerWhenReady) is exercised
// in scripts/verify-write-app.js.
import { test } from "node:test";
import assert from "node:assert/strict";
import { centerCharacter } from "./char-center.js";

/** Build a tiny fake DOM node with given bbox + children. We model
 *  the minimal surface area centerCharacter uses: getBoundingClientRect
 *  + querySelector (to find the SVG and the transform group) + a
 *  writable .style for the layer's transform. No real DOM needed. */
function makeNode({
  tag = "div",
  bbox = { x: 0, y: 0, width: 0, height: 0 },
  children = [],
  style = {},
  parent = null,
  attrs = {},
} = {}) {
  // Real getBoundingClientRect returns a DOMRect with both
  // {x, y, width, height} AND {left, top, right, bottom}. The
  // production code reads .left and .top, so the fake must too —
  // the previous version omitted them and produced NaN offsets
  // in tests, the kind of mistake that JS-numeric NaNs slip past
  // the type checker in real DOM code too.
  const rect = {
    x: bbox.x, y: bbox.y, width: bbox.width, height: bbox.height,
    left: bbox.x, top: bbox.y,
    right: bbox.x + bbox.width, bottom: bbox.y + bbox.height,
  };
  // Per-node screenCTM. Defaults to identity (no transform), which
  // is the most boring case but lets the tests build progressively
  // more interesting scenarios.
  const screenCTM = attrs.screenCTM || { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
  // gCTM (the g's own transform in SVG user coord) defaults to
  // identity, which is the same as the screenCTM unless overridden.
  // In production the gCTM is whatever HanziWriter set via the
  // transform attribute (e.g. "translate(100, 451.56) scale(0.39)").
  const gCTM = attrs.gCTM || screenCTM;
  const node = {
    nodeType: 1,
    tagName: tag.toUpperCase(),
    style,
    attributes: { ...attrs },
    children: [],
    parent,
    // Real DOM exposes .parentElement; mirror it so production code
    // that reads .parentElement works against the fake.
    get parentElement() { return this.parent; },
    getBoundingClientRect: () => rect,
    getScreenCTM: () => screenCTM,
    getCTM: () => gCTM,
    setAttribute(name, val) { this.attributes[name] = val; },
    getAttribute(name) { return this.attributes[name] ?? null; },
    querySelector(sel) {
      // Just enough to find the HanziWriter SVG and its <g transform="...">.
      // NB: this reads node.children (the live list), not the parameter
      // shadow — makeNode mutates node.children after the closure is
      // built, so the closure must reference the live array.
      if (sel === "svg" || sel.startsWith("svg ")) {
        return node.children.find((c) => c.tagName === "SVG") || null;
      }
      if (sel.includes("g[transform]") || sel.startsWith("g")) {
        return node.children.find((c) => c.tagName === "G") || null;
      }
      return null;
    },
  };
  for (const c of children) {
    c.parent = node;
    node.children.push(c);
  }
  return node;
}

/** Convenience: build a stage with a wrapper layer that contains
 *  both hanziTarget and kidSvg (the production HTML structure after
 *  this PR). Returns the layer's transform string after centering
 *  (or "" if centerCharacter returned null). */
function setup({
  stageBbox = { x: 0, y: 0, width: 358, height: 358 },
  charBbox = { x: 50, y: 100, width: 100, height: 100 },
  gScreenCTM = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 },
  gCTM,  // optional; defaults to gScreenCTM
  margin,
} = {}) {
  const stage = makeNode({ tag: "div", bbox: stageBbox });
  // The g's screenCTM is the same as what production would see:
  // the g's own transform composed with all parent transforms.
  // For most tests the simpler identity case is fine.
  const g = makeNode({
    tag: "g", bbox: charBbox,
    attrs: { screenCTM: gScreenCTM, gCTM: gCTM ?? gScreenCTM },
  });
  const refSvg = makeNode({ tag: "svg", children: [g] });
  const hanziTarget = makeNode({ tag: "div", children: [refSvg] });
  const kidSvg = makeNode({ tag: "svg" });
  const layer = makeNode({ tag: "div", children: [hanziTarget, kidSvg] });
  return { stage, layer, hanziTarget, kidSvg, refSvg, g };
}

// -------------------------------------------------------------------
// Failure modes
// -------------------------------------------------------------------

test("centerCharacter: returns null when no SVG is mounted in hanziTarget", () => {
  const { stage, hanziTarget, kidSvg } = setup();
  // Force-empty hanziTarget (no SVG child).
  hanziTarget.children = [];
  const result = centerCharacter({ stage, hanziTarget, kidSvg });
  assert.equal(result, null);
});

test("centerCharacter: returns null when SVG has no <g transform> child", () => {
  const { stage, hanziTarget, kidSvg } = setup();
  // Strip the g child of the refSvg.
  hanziTarget.children[0].children = [];
  const result = centerCharacter({ stage, hanziTarget, kidSvg });
  assert.equal(result, null);
});

test("centerCharacter: returns null when g bbox is zero (data not loaded)", () => {
  const { stage, layer, hanziTarget, kidSvg } = setup({
    charBbox: { x: 0, y: 0, width: 0, height: 0 },
  });
  const result = centerCharacter({ stage, hanziTarget, kidSvg });
  assert.equal(result, null);
  // Layer transform must NOT have been touched on failure.
  assert.equal(layer.style.transform ?? "", "");
});

test("centerCharacter: returns null when kid-svg's parent is the stage (no wrapper)", () => {
  // If the production HTML hasn't been updated to add a wrapper
  // layer, we can't transform hanzi-target + kid-svg together (the
  // kid's coordinate system would be off). Refuse to silently break.
  const stage = makeNode({ tag: "div", bbox: { x: 0, y: 0, width: 358, height: 358 } });
  const g = makeNode({ tag: "g", bbox: { x: 50, y: 100, width: 100, height: 100 } });
  const refSvg = makeNode({ tag: "svg", children: [g] });
  const hanziTarget = makeNode({ tag: "div", children: [refSvg] });
  const kidSvg = makeNode({ tag: "svg" });
  // kid-svg's parent IS the stage (no wrapper).
  stage.children.push(kidSvg);
  kidSvg.parent = stage;
  const result = centerCharacter({ stage, hanziTarget, kidSvg });
  assert.equal(result, null);
});

// -------------------------------------------------------------------
// Success path — pure geometry
// -------------------------------------------------------------------

test("centerCharacter: applies transform to the wrapper layer (no translate needed)", () => {
  // The new design: set the refSvg's viewBox so the g's center lands
  // at viewBox (300, 300), matching the kid-svg's viewBox center.
  // The g then sits at the SVG's CSS center, which is also the
  // layer's local center, which is the stage's center after the
  // layer's transform-origin kicks in. Only a scale is needed on
  // the layer — no translate.
  const { stage, layer, hanziTarget, kidSvg } = setup();
  const result = centerCharacter({ stage, hanziTarget, kidSvg });
  assert.ok(result, "should return a result");
  assert.equal(result.dx, 0, "no translate x — g is at the CSS center");
  assert.equal(result.dy, 0, "no translate y — g is at the CSS center");
  assert.match(layer.style.transform, /^translate\(0px, 0px\) scale\((0(\.\d+)?|1(\.0+)?)\)$/);
});

test("centerCharacter: sets the refSvg's viewBox to put the g at viewBox center", () => {
  // Without the viewBox change, the g lands at a character-specific
  // user coord (e.g. 284, 294 for "一") and the kid's viewBox center
  // (300, 300) wouldn't overlap. Setting viewBox to
  // (gux - 300, guy - 300, 600, 600) shifts the g so it lands at
  // viewBox (300, 300) — matching the kid-svg's viewBox center.
  // We test this by checking the viewBox attribute is set.
  const { stage, hanziTarget, kidSvg, refSvg } = setup();
  centerCharacter({ stage, hanziTarget, kidSvg });
  const vb = refSvg.getAttribute("viewBox");
  assert.ok(vb, "viewBox should be set on the refSvg");
  // Format: "x y w h"
  const [x, y, w, h] = vb.split(/\s+/).map(Number);
  assert.equal(w, 600, "viewBox width should be 600");
  assert.equal(h, 600, "viewBox height should be 600");
});

test("centerCharacter: scale = 1 when character already fits in available area", () => {
  // 358 stage, 0.1 margin → 286.4 available. 100×100 char fits.
  const { stage, hanziTarget, kidSvg } = setup({
    charBbox: { x: 100, y: 100, width: 100, height: 100 },
  });
  const result = centerCharacter({ stage, hanziTarget, kidSvg });
  assert.equal(result.scale, 1);
});

test("centerCharacter: scale < 1 when character overflows available area", () => {
  // 358 stage, 0.1 margin → 286.4 available. 400×100 char overflows width.
  const { stage, hanziTarget, kidSvg } = setup({
    charBbox: { x: 0, y: 100, width: 400, height: 100 },
  });
  const result = centerCharacter({ stage, hanziTarget, kidSvg });
  assert.ok(result.scale < 1, `expected scale < 1, got ${result.scale}`);
  // availW/charW = 286.4/400 = 0.716
  // availH/charH = 286.4/100 = 2.864
  // min = 0.716
  assert.ok(Math.abs(result.scale - 0.716) < 0.01, `expected scale ~0.716, got ${result.scale}`);
});

test("centerCharacter: respects custom margin", () => {
  // 358 stage, 0.25 margin → 179 available. 200×200 char overflows.
  // scale = 179/200 = 0.895
  const { stage, hanziTarget, kidSvg } = setup({
    charBbox: { x: 79, y: 79, width: 200, height: 200 },
  });
  const result = centerCharacter({ stage, hanziTarget, kidSvg, margin: 0.25 });
  assert.ok(Math.abs(result.scale - 0.895) < 0.01, `expected scale ~0.895, got ${result.scale}`);
});

test("centerCharacter: never upscales (scale capped at 1)", () => {
  // Tiny character (50×50) in a 358 stage. The natural scale-up
  // would be 286.4/50 = 5.7× — we cap at 1 so the character keeps
  // its native pixel density instead of getting blocky.
  const { stage, hanziTarget, kidSvg } = setup({
    charBbox: { x: 150, y: 150, width: 50, height: 50 },
  });
  const result = centerCharacter({ stage, hanziTarget, kidSvg });
  assert.equal(result.scale, 1);
});

// -------------------------------------------------------------------
// Multi-viewport sanity (the whole point of the module)
// -------------------------------------------------------------------

test("centerCharacter: phone (390x844, stage ~358) scales wide char to fit", () => {
  // Simulates iPhone 12: 358-stage with a "一" that's 350 wide.
  // margin=0.1 → 286.4 available → scale = 286.4/350 = 0.818
  const { stage, hanziTarget, kidSvg } = setup({
    stageBbox: { x: 0, y: 0, width: 358, height: 358 },
    charBbox: { x: 4, y: 167, width: 350, height: 24 },
  });
  const result = centerCharacter({ stage, hanziTarget, kidSvg });
  assert.ok(result.scale < 1, `phone wide char should scale down, got ${result.scale}`);
  assert.ok(result.scale > 0.7, `phone wide char scale should still be > 0.7, got ${result.scale}`);
});

test("centerCharacter: pad (768x1024, stage 560) leaves more room for the same char", () => {
  // Simulates iPad: 560-stage with the same "一" (350 wide) drawn
  // at the same proportion. 0.1 margin → 448 available → scale = 1
  // (350 < 448) → no scale needed. Different viewport, different
  // verdict on whether to scale.
  const { stage, hanziTarget, kidSvg } = setup({
    stageBbox: { x: 0, y: 0, width: 560, height: 560 },
    charBbox: { x: 4, y: 167, width: 350, height: 24 },
  });
  const result = centerCharacter({ stage, hanziTarget, kidSvg });
  assert.equal(result.scale, 1, "wide char fits the pad stage with no scaling needed");
});

test("centerCharacter: phone (358) and pad (560) compute different scales for same char", () => {
  // A 400-wide char that doesn't fit in either stage should still
  // get a different (smaller) scale on the phone than on the pad —
  // proving the same module adapts to viewport.
  const phone = setup({
    stageBbox: { x: 0, y: 0, width: 358, height: 358 },
    charBbox: { x: 0, y: 0, width: 400, height: 200 },
  });
  const pad = setup({
    stageBbox: { x: 0, y: 0, width: 560, height: 560 },
    charBbox: { x: 0, y: 0, width: 400, height: 200 },
  });
  const phoneRes = centerCharacter(phone);
  const padRes = centerCharacter(pad);
  assert.ok(phoneRes.scale < padRes.scale, `phone scale (${phoneRes.scale}) should be smaller than pad scale (${padRes.scale})`);
});

// -------------------------------------------------------------------
// Coords-system alignment (the actual reason this module exists)
// -------------------------------------------------------------------

test("centerCharacter: accounts for the g's own transform when computing viewBox", () => {
  // If the g has a non-identity transform (which all HanziWriter
  // glyphs do), the g's center in SVG user coord is NOT the g's
  // local-coord center — it's transformed by the g's CTM. We need
  // to apply the g's own transform to the local center to get the
  // user-coord center, then set the viewBox accordingly.
  //
  // g's screen bbox: x=50, y=50, w=100, h=100 → screen center (100, 100)
  // gScreenCTM = identity → g's local center = (100, 100)
  // gCTM (the g's own transform) = translate(100, 50) → g's local
  //   (100, 100) maps to user (100 + 100, 100 + 50) = (200, 150)
  // viewBox origin = (200 - 300, 150 - 300) = (-100, -150)
  const { stage, hanziTarget, kidSvg, refSvg } = setup({
    charBbox: { x: 50, y: 50, width: 100, height: 100 },
    gCTM: { a: 1, b: 0, c: 0, d: 1, e: 100, f: 50 },
  });
  centerCharacter({ stage, hanziTarget, kidSvg });
  const vb = refSvg.getAttribute("viewBox");
  const [vx, vy] = vb.split(/\s+/).map(Number);
  assert.equal(vx, -100, `viewBox.x should be -100 (gUserX - 300), got ${vx}`);
  assert.equal(vy, -150, `viewBox.y should be -150 (gUserY - 300), got ${vy}`);
});

test("centerCharacter: respects non-identity g screenCTM and gCTM when computing viewBox", () => {
  // Real HanziWriter scenario: g has both a screenCTM (composed of
  // all parent transforms + the g's own) and a separate gCTM (just
  // the g's own transform in SVG user coord).
  //
  // g's screen center = (100, 100) (from bbox)
  // gScreenCTM = (2, 0, 0, 2, 10, 20) → g's local center = ((100-10)/2, (100-20)/2) = (45, 40)
  // gCTM (g's own transform) = translate(50, 25) → user coord = (45+50, 40+25) = (95, 65)
  // viewBox origin = (95 - 300, 65 - 300) = (-205, -235)
  const { stage, hanziTarget, kidSvg, refSvg } = setup({
    charBbox: { x: 50, y: 50, width: 100, height: 100 },
    gScreenCTM: { a: 2, b: 0, c: 0, d: 2, e: 10, f: 20 },
    gCTM: { a: 1, b: 0, c: 0, d: 1, e: 50, f: 25 },
  });
  centerCharacter({ stage, hanziTarget, kidSvg });
  const vb = refSvg.getAttribute("viewBox");
  const [vx, vy] = vb.split(/\s+/).map(Number);
  assert.equal(vx, -205, `viewBox.x should be -205 (95 - 300), got ${vx}`);
  assert.equal(vy, -235, `viewBox.y should be -235 (65 - 300), got ${vy}`);
});

// -------------------------------------------------------------------
// Idempotence (re-centering should be deterministic, not cumulative)
// -------------------------------------------------------------------

test("centerCharacter: calling twice with same input produces the same result", () => {
  const { stage, hanziTarget, kidSvg } = setup({
    charBbox: { x: 50, y: 100, width: 100, height: 100 },
  });
  const first = centerCharacter({ stage, hanziTarget, kidSvg });
  const second = centerCharacter({ stage, hanziTarget, kidSvg });
  assert.deepEqual(first, second, "results should be identical on re-call");
});
