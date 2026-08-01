// web/write/client.js
//
// Client logic for the write app (issue #57 + v0.8 flow rewrite).
//
// Practice-view state machine (issue #65):
//
//   animating   → 笔顺重放 (animateCharacter, 一次 ~2.5s)
//     ↓
//   showing     → reference 完整显示, 倒计时 SHOW_MS=3s
//     ↓
//   writing     → 字消失, kid 用手指/pen 写, 支持撤销
//     ↓ (kid 点「提交」)
//   submitted   → compare mode (绿字 + 红笔) + 打分 (1-3 ⭐)
//                 出「重练」/「下一题」按钮
//     ↓
//     ├── 重练 → 清空 strokes, 回到 animating (同一字, 不前进 sessionIdx)
//     └── 下一题 → sessionIdx++, presentCurrent (下一字)
//
// Hanzi Writer is loaded as a global from the CDN <script> tag in
// index.html, so we read it from window.HanziWriter.
import { computeDisplayLevel } from "./grade.js";
import { scoreStrokes } from "./score.js";
import { paintPathsToCanvas, parseCTMString } from "./rasterize.js";
import { runShowFlow } from "./show-flow.js";
import { attachKidInput } from "./kid-input.js";
import { createWriteSession } from "./session.js";
import { attachHomeView } from "./home-view.js";

const HanziWriter = window.HanziWriter;
if (!HanziWriter) {
  console.error("[write] HanziWriter global not found — check the CDN <script> tag");
}

const API = "/api/write";
const STAGE_SIZE = 600;            // SVG viewBox size (matches HanziWriter default 600)
const SHOW_MS = 3000;              // how long the reference shows at full opacity
const COOLDOWN_MS = 30_000;        // matches grade.js default

// ----- DOM refs -----
const homeView = document.getElementById("home-view");
const practiceView = document.getElementById("practice-view");
const charsInput = document.getElementById("chars-input");
const addBtn = document.getElementById("add-btn");
const homeError = document.getElementById("home-error");
const wordList = document.getElementById("word-list");
const startBtn = document.getElementById("start-btn");
const stage = document.getElementById("stage");
const hanziTarget = document.getElementById("hanzi-target");
const kidSvg = document.getElementById("kid-svg");
const againBtn = document.getElementById("again-btn");
const undoBtn = document.getElementById("undo-btn");
const submitBtn = document.getElementById("submit-btn");
const retryBtn = document.getElementById("retry-btn");
const nextBtn = document.getElementById("next-btn");
const exitBtn = document.getElementById("exit-btn");
const statusEl = document.getElementById("status");
const scoreEl = document.getElementById("score");

// ----- Session state -----
// All session state is owned by ./session.js (refactor PR 7).
// Client.js reads via getters (.library / .session / .sessionIdx
// / .currentItem / .isDone) and mutates via .start() / .next()
// / .retry().
const session = createWriteSession({ initialLibrary: [] });
let phase = null;   // 'animating' | 'showing' | 'writing' | 'submitted'
let pendingTimers = [];  // {kind: 'showing'|'animate', timer} so we can cancel on retry

// ===========================================================================
//  Home view — load + render library (refactored to ./home-view.js)
// ===========================================================================

const homeView_ = attachHomeView({
  dom: { wordList, startBtn, charsInput, homeError, addBtn },
  api: API,
  fetch: window.StudyBuddy.fetch,
  onLibraryLoaded: (words) => {
    session.library = words;
  },
});
const loadLibrary = homeView_.loadLibrary;
const renderLibrary = homeView_.renderLibrary;
const addChars = homeView_.addChars;

addBtn.onclick = addChars;
charsInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") addChars();
});

startBtn.onclick = () => {
  if (session.library.length === 0) return;
  session.start();
  homeView.classList.add("hidden");
  practiceView.classList.add("active");
  presentCurrent();
};

// ===========================================================================
//  Practice view — Apple Pencil + Hanzi Writer
// ===========================================================================

function clearPendingTimers() {
  for (const t of pendingTimers) {
    if (typeof t.cancel === "function") t.cancel();
    else if (t.timer) clearTimeout(t.timer);
  }
  pendingTimers = [];
}

function presentCurrent() {
  if (session.isDone) {
    statusEl.textContent = "本轮结束，回主页";
    setPhase("done");
    setTimeout(exitToHome, 1500);
    return;
  }
  const item = session.currentItem;
  // v0.7 (issue #63): em-dash "—" rendered as a Chinese-glyph in some
  // mobile fonts, making the status read "第 1/5 字 — 一" like "字 一 一".
  // "·" middle dot is much safer.
  statusEl.textContent = `第 ${session.sessionIdx + 1} / ${session.session.length} 字 · ${item.char}`;
  startWord(item);
}

/** Centralised phase transition so buttons + timer handlers stay in sync. */
function setPhase(next) {
  phase = next;
  // Default button visibility per phase. Most start hidden and only
  // show for the relevant phase. `again` (笔顺重放) is the exception
  // — the kid can re-trigger it any time after the initial animation.
  againBtn.style.display = "";
  undoBtn.style.display = "none";
  submitBtn.style.display = "none";
  retryBtn.style.display = "none";
  nextBtn.style.display = "none";
  submitBtn.classList.remove("cta");
  retryBtn.classList.remove("cta");
  nextBtn.classList.remove("cta");
  // Note: we deliberately don't reset scoreEl.display here — the
  // submit handler sets it AFTER calling setPhase, and resetting
  // here would clobber the freshly-shown score. Clear it only on
  // entering animating/showing/writing (i.e. the start of a new
  // attempt, where old score should be gone).
  if (next !== "submitted" && scoreEl) {
    scoreEl.style.display = "none";
    scoreEl.textContent = "";
  }

  if (next === "animating" || next === "showing") {
    againBtn.textContent = "笔顺重放";
    submitBtn.textContent = "提交";
  } else if (next === "writing") {
    againBtn.textContent = "笔顺重放";
    undoBtn.style.display = "";
    submitBtn.style.display = "";
    submitBtn.classList.add("cta");   // prompt the kid to submit
  } else if (next === "submitted") {
    againBtn.style.display = "none";
    undoBtn.style.display = "none";
    submitBtn.style.display = "none";
    retryBtn.style.display = "";
    nextBtn.style.display = "";
    retryBtn.classList.add("cta");
  } else if (next === "done") {
    againBtn.style.display = "none";
    undoBtn.style.display = "none";
    submitBtn.style.display = "none";
    retryBtn.style.display = "none";
    nextBtn.style.display = "none";
  }
}

async function startWord(item) {
  clearPendingTimers();
  // Clear previous instance + kid's strokes
  hanziTarget.innerHTML = "";
  kidSvg.innerHTML = "";
  if (scoreEl) { scoreEl.textContent = ""; scoreEl.style.display = "none"; }
  item.strokes = [];   // [{pathEl, d}] for the current attempt

  const writer = HanziWriter.create(hanziTarget, item.char, {
    width: STAGE_SIZE,
    height: STAGE_SIZE,
    padding: 5,
    showCharacter: true,
    showOutline: false,
    strokeColor: "#4caf50",
    radicalColor: "#388e3c",
    strokeAnimationSpeed: 1,
    delayBetweenStrokes: 200,
  });
  item.writer = writer;

  // v0.8.1 (issue #66): always show the reference at full opacity
  // for the first look. grade.js's computeDisplayLevel fades to 0
  // after 3+ attempts, which broke the v0.8 flow — if the kid
  // can't see the reference they can't compare, can't score, can't
  // learn. We still call computeDisplayLevel so we exercise the
  // module (and so a future re-introduction of the fade is a
  // one-line change), but the visual is locked to 1.0.
  const now = Date.now();
  computeDisplayLevel({
    attemptCount: item.attemptCount,
    lastShownAt: item.lastShownAt,
    now,
    cooldownMs: COOLDOWN_MS,
  });
  const level = 1.0;
  item.opacity = level;
  item.startedAt = now;
  item.lastShownAt = now;
  item.shownOpacity = level;
  applyCharacterOpacity(level);

  // v0.8.2 (issue #68): replace the inline setTimeout(100) hack with
  // runShowFlow. The v0.8.1 timing fired "showing" 100ms after
  // startWord was called, regardless of whether animateCharacter
  // had finished — on a 2.5s animation the kid saw the character
  // flicker because the show window was opening while strokes were
  // still being drawn. runShowFlow drives transitions off the
  // animDone promise, so the show window starts only when the
  // character is actually static. Tested in show-flow.test.js.
  setPhase("animating");
  statusEl.textContent = "看笔顺 ↓";
  applyCharacterOpacity(1.0);  // start fully visible during animation
  const animDone = new Promise((resolve) => {
    writer.animateCharacter({ onComplete: () => resolve() });
  });
  const cancel = runShowFlow({
    writer,
    animDone,
    level,
    showMs: SHOW_MS,
    onPhase: (next) => {
      setPhase(next);
      if (next === "showing") statusEl.textContent = "看 3 秒后字会消失";
      else if (next === "writing") {
        statusEl.textContent = "字消失啦，开始写 ↓";
      }
    },
    onOpacity: (op) => applyCharacterOpacity(op),
  });
  pendingTimers.push({ kind: "showflow", cancel });
  // Keep animDone around to avoid unhandled-rejection warnings if we
  // never await it (e.g. user navigates away mid-animate).
  animDone.catch(() => {});
}

function applyCharacterOpacity(opacity) {
  const svg = hanziTarget.querySelector("svg");
  if (!svg) return;
  svg.style.opacity = String(opacity);
  svg.style.transition = "opacity 0.3s";
}

// ===========================================================================
//  Kid input — pointer events, one SVG path per pointerdown-up
//  (extracted to ./kid-input.js — see that module for tests + API)
// ===========================================================================

const kidInput = attachKidInput({
  svg: kidSvg,
  stageSize: STAGE_SIZE,
  isWritingPhase: () => phase === "writing",
  onStroke: (s) => {
    // Route the completed stroke into the current session item.
    const item = session.currentItem;
    if (item) item.strokes.push(s);
  },
});
const enableKidInput = () => kidInput.attach();
const disableKidInput = () => kidInput.detach();

// ===========================================================================
//  Rasterise — kid + ref SVG paths → SIZE*SIZE bitmap masks for IoU
// ===========================================================================

/**
 * Rasterise both the kid's strokes and the reference character's
 * strokes into SIZE*SIZE bitmap masks so scoreStrokes() can compute
 * IoU (intersection over union).
 *
 * v0.8.1 (issue #66): this replaces the old "bbox overlap" approach
 * that scored messy-but-large ink higher than accurate-but-small
 * ink. IoU on the actual rasterised shape is what "did the kid
 * write the right shape" really means.
 *
 * Trick: HanziWriter's reference path has stroke-width="200" inside
 * a 600 viewBox, while the kid's strokes are 6 wide. If we naively
 * drawImage both, the ref is ~33× wider than the kid in pixels and
 * the IoU is dominated by the ref's area. We normalise both to
 * stroke-width 6 before rasterising so a 1-stroke-wide ref pixel
 * matches a 1-stroke-wide kid pixel.
 */
async function rasterizeStrokes(strokes, item) {
  const SIZE = 100;
  const c = document.createElement("canvas");
  c.width = SIZE;
  c.height = SIZE;
  const ctx = c.getContext("2d");
  ctx.imageSmoothingEnabled = false;  // sharp edges; we want pixel-accurate mask

  // Canvas is 100x100, SVG viewBox is 600x600. Scale 1/6 makes a
  // HanziWriter stroke-width="200" in 600 viewBox become 33 pixels
  // wide in the canvas, which dominates any kid stroke. We instead
  // draw both sides at a NORMALISED stroke width: the kid's 6
  // (6/600 * 100 = 1px) and the ref's 200 (200/600 * 100 = 33px)
  // would not be comparable. So we use the same Path2D + ctx.stroke
  // path for both, with the same line width and caps, and let the
  // d-strings themselves encode where ink goes.
  const scale = SIZE / STAGE_SIZE;

  // 1. Kid strokes. kid-svg is in the DOM with paths drawn by
  //    onpointerup. We re-rasterise from the d-strings so the
  //    bitmap is in the same coordinate system (600 viewBox) as
  //    the ref (after scale = 1/6). No CTM — the kid's paths are
  //    written in canvas coordinates directly.
  ctx.save();
  ctx.scale(scale, scale);
  ctx.strokeStyle = "#000";
  ctx.fillStyle = "#000";
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  const kidDs = strokes.map((s) => s.pathEl.getAttribute("d")).filter(Boolean);
  paintPathsToCanvas(ctx, kidDs, null, 6);
  ctx.restore();
  const kidBitmap = bitmapFromCanvas(ctx, SIZE);

  // 2. Ref strokes. v0.8.2 (issue #68): HanziWriter nests its paths
  //    inside <g transform="translate(...) scale(...)">. The raw d
  //    values are in unscaled SVG coordinates — without applying
  //    the transform, the bitmap lands at the wrong place and IoU
  //    is ~0 (the "score is always 0" bug the user caught on the
  //    iPad). We parse the transform string and apply it via
  //    ctx.transform. (Real <g>.getCTM() works in chromium but
  //    not in some mobile browsers, so we read the attribute and
  //    compute the matrix ourselves — this is what rasterize.js
  //    test-cases pin down.)
  ctx.clearRect(0, 0, SIZE, SIZE);
  let refStrokes = 0;
  const refSvg = hanziTarget ? hanziTarget.querySelector("svg") : null;
  if (refSvg) {
    refStrokes = refSvg.querySelectorAll("path").length;
    // Find the first <g> with a transform attribute; that's the
    // HanziWriter's glyph group. We compose any chained transforms.
    const g = refSvg.querySelector("g[transform]");
    const ctm = g ? parseCTMString(g.getAttribute("transform")) : null;
    ctx.save();
    ctx.scale(scale, scale);
    ctx.strokeStyle = "#000";
    ctx.fillStyle = "#000";
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    const refDs = Array.from(refSvg.querySelectorAll("path"))
      .map((p) => p.getAttribute("d"))
      .filter(Boolean);
    paintPathsToCanvas(ctx, refDs, ctm, 6);
    ctx.restore();
  }
  const refBitmap = bitmapFromCanvas(ctx, SIZE);

  return { kidBitmap, refBitmap, refStrokes, size: SIZE };
}

/** Convert a canvas's current RGBA pixels to a SIZE*SIZE 0/1 mask. */
function bitmapFromCanvas(ctx, size) {
  const data = ctx.getImageData(0, 0, size, size).data;
  const out = new Uint8Array(size * size);
  for (let i = 0, j = 0; i < data.length; i += 4, j++) {
    out[j] = data[i + 3] > 0 ? 1 : 0;
  }
  return out;
}

// ===========================================================================
//  Submit / Undo / Score
// ===========================================================================

function undoLastStroke() {
  const item = session.currentItem;
  if (!item || !item.strokes || item.strokes.length === 0) return;
  const last = item.strokes.pop();
  if (last && last.pathEl && last.pathEl.parentNode === kidSvg) {
    kidSvg.removeChild(last.pathEl);
  }
  // No redo, by user request. State change is one-way.
}

async function submitCurrent() {
  const item = session.currentItem;
  if (!item) return;
  const strokes = item.strokes || [];
  // Concatenate all stroke d-strings into one path the server can
  // accept (we use SVG's M..L space — multiple subpaths work).
  const combined = strokes.map((s) => s.d).join(" ");

  // 1. Compute the score client-side. v0.8.1 (issue #66): switched
  //    from "bbox overlap of the kid's union vs the ref's bbox" to
  //    "IoU of the rasterised kid path vs the rasterised ref path".
  //    v0.8's bbox overlap made "draw a big messy blob covering the
  //    whole 田字格" beat "draw a small accurate stroke", because it
  //    measured AREA coverage, not SHAPE similarity. The iPad live
  //    test caught it — kid wrote ugly but scored 3★, dad wrote
  //    accurately but scored 1★. Rasterising both sides to a 100×100
  //    canvas and computing intersection-over-union reflects what
  //    "matches" actually means.
  const { kidBitmap, refBitmap, refStrokes, size } = rasterizeStrokes(strokes, item);
  const { stars, breakdown } = scoreStrokes({
    kidStrokes: strokes.length,
    refStrokes: Math.max(refStrokes, 1),  // if writer gave 0, pretend 1 so 0 kid → 0 score
    kidBitmap,
    refBitmap,
    size,
  });
  showScore(stars, breakdown);

  // 2. Submit the attempt to the server. Best-effort — a server
  //    failure shouldn't block the visual compare flow.
  try {
    await window.StudyBuddy.fetch(API + "/attempts", {
      method: "POST",
      body: { char: item.char, level: item.opacity, strokePath: combined },
    });
  } catch (e) {
    console.error("[write] submitCurrent: attempt POST failed", e);
  }

  // 3. Compare mode: re-show the reference at full opacity next to
  //    the kid's strokes. Disable further input.
  if (item.writer) {
    item.writer.showCharacter();
    applyCharacterOpacity(1.0);
  }
  disableKidInput();
  setPhase("submitted");
  statusEl.textContent = `对比看完了？点「重练」或「下一题」`;
}

function showScore(stars, breakdown) {
  if (!scoreEl) return;
  scoreEl.style.display = "";
  const star = "★";
  const empty = "☆";
  scoreEl.textContent = `${star.repeat(stars)}${empty.repeat(3 - stars)}  ${(breakdown.total * 100).toFixed(0)} 分`;
  scoreEl.title = `笔画数 ${(breakdown.strokes * 100).toFixed(0)} · 形状重合 ${(breakdown.iou * 100).toFixed(0)}`;
}

// ===========================================================================
//  Button wiring
// ===========================================================================

againBtn.onclick = () => {
  // "笔顺重放" — re-animate the current character on demand.
  if (phase === "writing" || phase === "animating" || phase === "showing" || phase === "submitted") {
    const item = session.currentItem;
    if (item && item.writer) {
      // Re-show reference at full opacity during the replay, then drop
      // back to opacity 0 so the kid can keep writing.
      applyCharacterOpacity(1.0);
      item.writer.animateCharacter();
      // If the kid was already writing, drop the reference again
      // after the animation so they can continue.
      if (phase === "writing" || phase === "animating" || phase === "showing") {
        // best-effort: the user can keep writing over the animation.
      }
    }
  }
};

undoBtn.onclick = () => {
  if (phase !== "writing") return;
  undoLastStroke();
};

submitBtn.onclick = () => {
  if (phase !== "writing") return;
  submitCurrent();
};

retryBtn.onclick = () => {
  // "重练" — clear kid strokes, restart the same char (no advance).
  if (phase !== "submitted") return;
  const item = session.currentItem;
  if (item) item.attemptCount = (item.attemptCount || 0) + 1;  // attempts++; opacity goes down next time
  enableKidInput();
  startWord(item);
};

nextBtn.onclick = () => {
  if (phase !== "submitted") return;
  session.next();
  enableKidInput();
  presentCurrent();
};

exitBtn.onclick = () => {
  clearPendingTimers();
  exitToHome();
};

function exitToHome() {
  clearPendingTimers();
  disableKidInput();
  practiceView.classList.remove("active");
  homeView.classList.remove("hidden");
  loadLibrary();
}

// ----- Boot -----
enableKidInput();   // attach the input handlers; the phase check
                    // (`if (phase !== "writing") return;`) keeps them
                    // inert until the kid is allowed to draw.
loadLibrary();
