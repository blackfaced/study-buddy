// web/write/rasterize.js
// =====================================================================
// Rasterise SVG paths to a bitmap mask for IoU scoring.
// =====================================================================
//
// Pure-function helpers for turning SVG `<path>` d-strings into a
// pixel mask. Lives in its own module so we can unit-test the parts
// that don't depend on canvas APIs (the rest is integration-tested via
// Playwright).
//
// Why this exists separately from client.js: v0.8.1's IoU bug came
// from reading HanziWriter's d-strings and stroking them with no
// transform. The d-strings are in unscaled SVG coordinates (e.g.
// "M 25 421 L 920 401") but the visible character is in
// <g transform="translate(5, 523) scale(0.576, -0.576)">. Without
// applying the transform, the rasterised "ref" lands at the
// raw-coordinate position, far away from where HanziWriter actually
// drew it — IoU ~0, score ~0.
//
// Helpers in this module:
//   - parseCTMString(svg)            read transform attribute → CTM object
//   - transformFromMatrix(a,b,c,d,e,f) — pass-through (just documents intent)
//   - paintPathsToCanvas(ctx, paths, ctm, lineWidth) — actual paint (DOM)
//
// CTM in SVG is the matrix [a c e; b d f; 0 0 1] that maps SVG user
// coordinates → parent coordinates. A transform="translate(5, 50)
// scale(2)" gives a=2, b=0, c=0, d=2, e=5, f=50 (after multiplication).
//
// The test below pins down the single most common case: scale + translate
// only. Rotations and skews aren't supported by HanziWriter.
// =====================================================================

/**
 * Parse an SVG `transform="..."` attribute string into a CTM
 * object: {a, b, c, d, e, f}. Supports the chain
 *   translate(tx, ty) | scale(sx[, sy]) | matrix(a, b, c, d, e, f)
 * Functions compose left-to-right (matrix multiplication in standard
 * CSS order: the rightmost transform is applied first to the point).
 *
 * @param {string} s
 * @returns {{a:number,b:number,c:number,d:number,e:number,f:number}}
 */
export function parseCTMString(s) {
  if (!s) return { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
  // Start as identity.
  let M = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
  const re = /(matrix|translate|scale)\(([^)]+)\)/g;
  let match;
  while ((match = re.exec(s)) !== null) {
    const fn = match[1];
    const args = match[2].split(/[ ,]+/).filter(Boolean).map(Number);
    M = compose(M, fnMatrix(fn, args));
  }
  return M;
}

/** Multiply two CTMs: out = A * B. (a,b,c,d,e,f) as 2D affine matrix. */
function compose(A, B) {
  return {
    a: A.a * B.a + A.c * B.b,
    b: A.b * B.a + A.d * B.b,
    c: A.a * B.c + A.c * B.d,
    d: A.b * B.c + A.d * B.d,
    e: A.a * B.e + A.c * B.f + A.e,
    f: A.b * B.e + A.d * B.f + A.f,
  };
}

/** Build the CTM for a single transform function. */
function fnMatrix(fn, args) {
  switch (fn) {
    case "translate": {
      const [tx = 0, ty = 0] = args;
      return { a: 1, b: 0, c: 0, d: 1, e: tx, f: ty };
    }
    case "scale": {
      const [sx = 1, sy = sx] = args;
      return { a: sx, b: 0, c: 0, d: sy, e: 0, f: 0 };
    }
    case "matrix": {
      const [a = 1, b = 0, c = 0, d = 1, e = 0, f = 0] = args;
      return { a, b, c, d, e, f };
    }
    default:
      // Unknown function: identity (no-op).
      return { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
  }
}

/**
 * Apply a CTM to a canvas 2D context. Mutates the context's current
 * transform. Call ctx.save() / ctx.restore() around this if you need
 * to undo it.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {{a,b,c,d,e,f}} ctm
 */
export function applyCTM(ctx, ctm) {
  ctx.transform(ctm.a, ctm.b, ctm.c, ctm.d, ctm.e, ctm.f);
}

/**
 * Paint a list of d-strings onto the given canvas context as stroked
 * paths, with the optional CTM applied first. The `lineWidth` is the
 * final stroke width in **device space** (canvas pixels), regardless
 * of whether a CTM is applied. Internally we convert it to user
 * units by dividing by the CTM's uniform scale factor, so that:
 *
 *   - With no ctm, lineWidth=1 → 1 device pixel stroke.
 *   - With ctm scale 0.576 (HanziWriter's glyph transform), lineWidth=1
 *     → 1 device pixel stroke, same as the no-ctm case.
 *
 * This matters for IoU scoring: without the normalization the ref's
 * stroke ends up at 0.576px (or whatever |ctm.d| is) while the kid's
 * is 1px, so the kid's stroke contributes proportionally more to the
 * mask area and the IoU never reaches 1.0 even for a perfect match.
 *
 * Example:
 *   paintPathsToCanvas(ctx, ["M 0 0 L 100 100"], {a:0.5,b:0,c:0,d:0.5,e:0,f:0}, 6)
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {string[]} dStrings
 * @param {{a,b,c,d,e,f}|null} ctm
 * @param {number} deviceLineWidth  stroke width in device pixels
 */
export function paintPathsToCanvas(ctx, dStrings, ctm, deviceLineWidth) {
  ctx.save();
  // Convert device lineWidth to user units. For a pure scale ctm
  // (which is all HanziWriter emits), |ctm.a| is the scale factor.
  // We use Math.hypot(a, b) to also handle a future rotated ctm.
  const scale = ctm ? Math.hypot(ctm.a, ctm.b) || 1 : 1;
  ctx.lineWidth = deviceLineWidth / scale;
  if (ctm) applyCTM(ctx, ctm);
  for (const d of dStrings) {
    if (!d) continue;
    try {
      ctx.stroke(new Path2D(d));
    } catch (e) {
      // Malformed d, skip.
    }
  }
  ctx.restore();
}
