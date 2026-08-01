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
//   - attachKidInput({ svg, stageSize, isWritingPhase, onStroke })
//     returns { attach(), detach(), __handlers }
//
//   - svg:             the kid's <svg> element (kid-svg in client.js)
//   - stageSize:       the SVG viewBox size (600 for HanziWriter)
//   - isWritingPhase:  () => bool — only accept input when the kid
//                      is in the "writing" phase of the state machine
//   - onStroke:        ({ pathEl, d }) => void — called once per
//                      completed stroke (pointerup or pointercancel)
//
// The exposed __handlers are for testing only — production code
// uses attach()/detach() to wire up the SVG's onpointerdown/move/up.
// =====================================================================

const SVG_NS = "http://www.w3.org/2000/svg";
const STROKE_COLOR = "#e74c3c";
const STROKE_WIDTH = "6";

/**
 * Build a new <path>-like element. In a browser this would use
 * document.createElementNS, but the rest of the app only needs
 * the setAttribute / getAttribute / appendChild surface, so we
 * use a plain object. That keeps the module testable without
 * a DOM and avoids the SVG-namespace-detached-node trap we hit
 * on iOS Safari (see the v0.8.1 score rewrite).
 */
function makePath(d) {
  const attrs = {
    d,
    stroke: STROKE_COLOR,
    "stroke-width": STROKE_WIDTH,
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
    fill: "none",
  };
  return {
    tagName: "path",
    namespace: SVG_NS,
    setAttribute(name, val) { attrs[name] = val; },
    getAttribute(name) { return attrs[name]; },
  };
}

export function attachKidInput({ svg, stageSize, isWritingPhase, onStroke }) {
  /** Active path being drawn right now. null between strokes. */
  let activePath = null;
  let activeD = "";

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
