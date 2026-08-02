// web/write/kid-input.js
// =====================================================================
// Kid pointer input — extracted from client.js (refactor PR 6).
// =====================================================================
//
// Encapsulates "kid draws a stroke" — pointerdown→move→up produces
// an SVG <path> child + a d-string. The rest of the app reads
// `item.strokes` to rasterise + score the kid's work.
//
// Public API:
//   - attachKidInput({ svg, stageSize, isWritingPhase, onStroke, createElement })
//     returns { attach(), detach(), __handlers }
//
//   - svg:             the kid's <svg> element (kid-svg in client.js)
//   - stageSize:       the SVG viewBox size (600 for HanziWriter)
//   - isWritingPhase:  () => bool — only accept input when the kid
//                      is in the "writing" phase of the state machine
//   - onStroke:        ({ pathEl, d }) => void — called once per
//                      completed stroke (pointerup or pointercancel)
//   - createElement:   (tag) => SVGElement — factory for new <path>
//                      nodes. Production passes
//                      `document.createElementNS(SVG_NS, tag)`;
//                      tests pass a fake. Required.
//
// The exposed __handlers are for testing only — production code
// uses attach()/detach() to wire up the SVG's onpointerdown/move/up.
//
// History: PR #70 originally built path elements as plain JS objects
// (no DOM), so svg.appendChild(plainObject) threw on real browsers —
// kids could see the canvas but their strokes never appeared. This
// module now requires createElement so the production wiring always
// goes through the real DOM factory.
// =====================================================================

const SVG_NS = "http://www.w3.org/2000/svg";
const STROKE_COLOR = "#e74c3c";
const STROKE_WIDTH = "6";

/** Default for the browser: a real SVG-namespaced <path>. Tests
 *  must inject their own createElement (see kid-input.test.js). */
function defaultCreateElement(tag) {
  if (
    typeof document === "undefined" ||
    typeof document.createElementNS !== "function"
  ) {
    throw new Error(
      "kid-input: no document available; pass createElement explicitly " +
        "(production should pass document.createElementNS(SVG_NS, tag))",
    );
  }
  return document.createElementNS(SVG_NS, tag);
}

export function attachKidInput({
  svg,
  stageSize,
  isWritingPhase,
  onStroke,
  createElement,
}) {
  if (typeof createElement !== "function") {
    throw new Error("kid-input: createElement is required (see defaultCreateElement)");
  }
  const _createElement = createElement || defaultCreateElement;

  /** Active path being drawn right now. null between strokes. */
  let activePath = null;
  let activeD = "";

  function makePath(d) {
    // Real SVG-namespaced path element — the previous PR #70 refactor
    // built plain {tagName, setAttribute, ...} objects, which made
    // svg.appendChild throw on real browsers.
    const el = _createElement("path");
    el.setAttribute("d", d);
    el.setAttribute("stroke", STROKE_COLOR);
    el.setAttribute("stroke-width", STROKE_WIDTH);
    el.setAttribute("stroke-linecap", "round");
    el.setAttribute("stroke-linejoin", "round");
    el.setAttribute("fill", "none");
    return el;
  }

  function getPos(e) {
    const rect = svg.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * stageSize;
    const y = ((e.clientY - rect.top) / rect.height) * stageSize;
    return { x, y };
  }

  function onDown(e) {
    if (!isWritingPhase()) return;
    if (typeof e.preventDefault === "function") e.preventDefault();
    if (typeof svg.setPointerCapture === "function") {
      try { svg.setPointerCapture(e.pointerId); } catch { /* iOS quirk */ }
    }
    const p = getPos(e);
    activeD = `M ${p.x} ${p.y}`;
    activePath = makePath(activeD);
    svg.appendChild(activePath);
  }

  function onMove(e) {
    if (!activePath) return;
    if (typeof e.preventDefault === "function") e.preventDefault();
    const p = getPos(e);
    activeD += ` L ${p.x} ${p.y}`;
    activePath.setAttribute("d", activeD);
  }

  function finishStroke() {
    if (!activePath) return;
    onStroke({ pathEl: activePath, d: activeD });
    activePath.setAttribute("opacity", "0.85");
    activePath = null;
    activeD = "";
  }

  function onUp(_e) {
    if (typeof _e?.preventDefault === "function") _e.preventDefault();
    finishStroke();
  }

  function onCancel() {
    // Treat cancel like a stroke-end so the kid doesn't lose ink if
    // their palm briefly leaves the surface.
    finishStroke();
  }

  return {
    attach() {
      svg.onpointerdown = onDown;
      svg.onpointermove = onMove;
      svg.onpointerup = onUp;
      svg.onpointercancel = onCancel;
    },
    detach() {
      svg.onpointerdown = null;
      svg.onpointermove = null;
      svg.onpointerup = null;
      svg.onpointercancel = null;
    },
    /** @internal exposed for tests; not for production callers. */
    __handlers: { down: onDown, move: onMove, up: onUp, cancel: onCancel },
  };
}
