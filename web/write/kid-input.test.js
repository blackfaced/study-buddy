// web/write/kid-input.test.js
//
// Tests for the kid-input module extracted from client.js (PR 6 of
// the refactor series). The module encapsulates pointer-event
// capture for the kid's drawable SVG: one stroke = one
// pointerdown→move→up cycle, producing an SVG <path> child and a
// d-string the rest of the app can rasterise + score.
//
// We test in node with a minimal mock of the SVG element +
// PointerEvent. The DOM side-effects are real (we use JSDOM
// semantics via the built-in `document` global in node 22's test
// runner). The rest of the write app's state (phase, session,
// strokes) is mocked as callbacks so the module is testable
// without a browser.
import { test } from "node:test";
import assert from "node:assert/strict";
import { attachKidInput } from "./kid-input.js";

/** Hand-rolled SVG-namespaced <path> factory used by tests. Returns
 *  objects with setAttribute / getAttribute / a tagName + namespace
 *  marker so the production SVG.appendChild check would accept them
 *  in a real browser (and so our test fakeSvg validates Node shape,
 *  mirroring what real DOM does). */
function makeFakePathEl() {
  const attrs = {};
  return {
    tagName: "path",
    namespace: "http://www.w3.org/2000/svg",
    nodeType: 1,
    children: [],
    textContent: "",
    appendChild(c) {
      if (!c || typeof c.nodeType !== "number" || typeof c.appendChild !== "function") {
        throw new TypeError(
          "Failed to execute 'appendChild' on 'Node': parameter 1 is not of type 'Node'.",
        );
      }
      this.children.push(c);
      return c;
    },
    setAttribute(name, val) { attrs[name] = val; },
    getAttribute(name) { return attrs[name]; },
  };
}

function makeFakeCreateElement() {
  const calls = [];
  function createElement(tag) {
    calls.push(tag);
    return makeFakePathEl();
  }
  return { createElement, calls };
}

/**
 * Build a minimal mock of the kid-svg element. The appendChild
 * enforces Node-shape (mirrors real DOM) so PR #70's plain-object
 * makePath bug would have been caught by this test.
 */
function makeSvg() {
  const svg = {
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 600, height: 600 }),
    setPointerCapture: () => {},
    paths: [],
    childNodes: [],
    addEventListener: () => {},
  };
  // Enforce Node shape on appendChild like the real DOM does.
  svg.appendChild = (el) => {
    if (!el || typeof el.nodeType !== "number" || typeof el.appendChild !== "function") {
      throw new TypeError(
        "Failed to execute 'appendChild' on 'Node': parameter 1 is not of type 'Node'.",
      );
    }
    svg.paths.push(el);
    svg.childNodes.push(el);
    return el;
  };
  return svg;
}

function makePointerEvent(clientX, clientY) {
  return {
    clientX,
    clientY,
    pointerId: 1,
    preventDefault: () => {},
  };
}

function makeDeps(overrides = {}) {
  return {
    svg: makeSvg(),
    stageSize: 600,
    isWritingPhase: () => true,
    onStroke: () => {},
    createElement: makeFakeCreateElement().createElement,
    ...overrides,
  };
}

// --- pointerdown creates a path ------------------------------------

test("kid-input: pointerdown in writing phase creates a path with M command", () => {
  const deps = makeDeps();
  const kid = attachKidInput(deps);
  let lastCreated = null;
  // We can hook the SVG's appendChild to capture the path.
  deps.svg.appendChild = (el) => {
    lastCreated = el;
    deps.svg.paths.push(el);
    deps.svg.childNodes.push(el);
  };

  kid.attach();
  const ev = makePointerEvent(300, 300);
  // Drive the event via the internal handler. We need to expose
  // it for testability — see kid-input.js where it's stored
  // on the kid object.
  kid.__handlers.down(ev);

  assert.ok(lastCreated, "should have created a path");
  assert.match(lastCreated.getAttribute("d"), /^M 300 300/);
  assert.equal(lastCreated.getAttribute("stroke"), "#e74c3c");
  assert.equal(lastCreated.getAttribute("stroke-width"), "6");
  assert.equal(lastCreated.getAttribute("stroke-linecap"), "round");
  assert.equal(lastCreated.getAttribute("fill"), "none");
});

// --- pointerdown outside writing phase is a no-op ------------------

test("kid-input: pointerdown outside writing phase is ignored", () => {
  const deps = makeDeps({ isWritingPhase: () => false });
  let appendCount = 0;
  deps.svg.appendChild = () => appendCount++;
  const kid = attachKidInput(deps);
  kid.attach();

  kid.__handlers.down(makePointerEvent(100, 100));
  assert.equal(appendCount, 0, "should not create a path when not in writing phase");
});

// --- pointermove extends the path ----------------------------------

test("kid-input: pointermove adds an L command to the active path's d", () => {
  const deps = makeDeps();
  let activePath = null;
  deps.svg.appendChild = (el) => { activePath = el; };
  const kid = attachKidInput(deps);
  kid.attach();

  kid.__handlers.down(makePointerEvent(100, 100));
  assert.match(activePath.getAttribute("d"), /^M 100 100/);

  kid.__handlers.move(makePointerEvent(200, 200));
  assert.match(activePath.getAttribute("d"), /L 200 200/);

  kid.__handlers.move(makePointerEvent(300, 250));
  assert.match(activePath.getAttribute("d"), /L 200 200 L 300 250/);
});

// --- pointermove without active path is a no-op -------------------

test("kid-input: pointermove without active path is ignored", () => {
  const deps = makeDeps();
  const kid = attachKidInput(deps);
  kid.attach();
  // No down → no move should crash.
  assert.doesNotThrow(() => kid.__handlers.move(makePointerEvent(100, 100)));
});

// --- pointerup completes the stroke (calls onStroke) -------------

test("kid-input: pointerup calls onStroke with the d-string + path element", () => {
  const strokes = [];
  const deps = makeDeps({ onStroke: (s) => strokes.push(s) });
  let activePath = null;
  deps.svg.appendChild = (el) => { activePath = el; };
  const kid = attachKidInput(deps);
  kid.attach();

  kid.__handlers.down(makePointerEvent(100, 100));
  kid.__handlers.move(makePointerEvent(200, 200));
  kid.__handlers.up(makePointerEvent(200, 200));

  assert.equal(strokes.length, 1);
  assert.match(strokes[0].d, /M 100 100 L 200 200/);
  assert.deepEqual(strokes[0].points, [
    { x: 100, y: 100 },
    { x: 200, y: 200 },
  ]);
  assert.equal(strokes[0].pathEl, activePath);
  assert.equal(activePath.getAttribute("opacity"), "0.85");
});

// --- pointercancel also completes the stroke ----------------------

test("kid-input: pointercancel completes the active stroke (palm-leaves-surface case)", () => {
  const strokes = [];
  const deps = makeDeps({ onStroke: (s) => strokes.push(s) });
  const kid = attachKidInput(deps);
  kid.attach();

  kid.__handlers.down(makePointerEvent(100, 100));
  kid.__handlers.move(makePointerEvent(200, 200));
  // No `up` — kid's palm lifted; cancel fires instead.
  kid.__handlers.cancel();

  assert.equal(strokes.length, 1, "cancel should also count as a stroke completion");
  assert.match(strokes[0].d, /M 100 100 L 200 200/);
});

// --- coordinate scaling -------------------------------------------

test("kid-input: clientX/clientY are scaled to stageSize", () => {
  const deps = makeDeps({
    // svg is 300px wide, stage is 600 viewBox → 2x scale-up.
    svg: {
      ...makeSvg(),
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 300, height: 300 }),
    },
  });
  let created = null;
  deps.svg.appendChild = (el) => { created = el; };
  const kid = attachKidInput(deps);
  kid.attach();
  kid.__handlers.down(makePointerEvent(150, 150));  // 50% of svg → 300,300 in stage
  assert.match(created.getAttribute("d"), /^M 300 300/);
});

// --- detach removes handlers --------------------------------------

test("kid-input: detach() sets all SVG pointer handlers to null", () => {
  const deps = makeDeps();
  const kid = attachKidInput(deps);
  kid.attach();
  assert.ok(typeof deps.svg.onpointerdown === "function", "attach should wire onpointerdown");
  kid.detach();
  assert.equal(deps.svg.onpointerdown, null, "detach should null onpointerdown");
  assert.equal(deps.svg.onpointermove, null, "detach should null onpointermove");
  assert.equal(deps.svg.onpointerup, null, "detach should null onpointerup");
  assert.equal(deps.svg.onpointercancel, null, "detach should null onpointercancel");
});

// --- createElement DI (regression: PR #70 plain-object makePath) --

test("kid-input: createElement is required and used to build path nodes", () => {
  // Regression: PR #70 built paths as plain {tagName, setAttribute, ...}
  // objects. svg.appendChild(plainObject) threw on the real DOM and
  // the kid saw no ink. The fix routes makePath through a createElement
  // dependency, so production wires document.createElementNS and the
  // test fake must be used.
  assert.throws(
    () => attachKidInput({ svg: makeSvg(), stageSize: 600, isWritingPhase: () => true, onStroke: () => {} }),
    /createElement is required/,
    "should refuse to attach without a createElement dependency",
  );

  const { createElement, calls } = makeFakeCreateElement();
  const deps = makeDeps({ createElement });
  const kid = attachKidInput(deps);
  kid.attach();
  kid.__handlers.down(makePointerEvent(100, 100));
  kid.__handlers.up(makePointerEvent(100, 100));
  assert.equal(calls.length, 1, "createElement should be called once per pointerdown");
  assert.equal(calls[0], "path", "createElement should build a 'path' element");
});

test("kid-input: real-DOM SVG.appendChild would accept the path returned by createElement (regression)", () => {
  // The PR #70 bug was that makePath returned a plain object so real
  // SVG.appendChild threw "parameter 1 is not of type 'Node'". With
  // createElement producing a Node-shape object, the SVG accepts it
  // and the stroke lands in the DOM tree.
  const { createElement } = makeFakeCreateElement();
  const deps = makeDeps({ createElement });
  const kid = attachKidInput(deps);
  kid.attach();
  kid.__handlers.down(makePointerEvent(100, 100));
  // If createElement returned a plain object, deps.svg.appendChild
  // would throw "parameter 1 is not of type 'Node'" (mirroring real
  // DOM). With Node-shape, the path is appended cleanly.
  assert.equal(deps.svg.paths.length, 1, "SVG should hold the newly created path");
  const el = deps.svg.paths[0];
  assert.equal(el.namespace, "http://www.w3.org/2000/svg", "path must be SVG-namespaced");
  assert.equal(typeof el.appendChild, "function", "path must be a real Node (has appendChild)");
});
