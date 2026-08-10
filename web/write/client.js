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
//   submitted   → compare mode (绿字 + 红笔) + 可解释的规范书写档位
//                 出「重练」/「下一题」按钮；有纠错时先独立重写一次
//     ↓
//     ├── 重练 → 清空 strokes, 回到 animating (同一字, 不前进 sessionIdx)
//     └── 下一题 → sessionIdx++, presentCurrent (下一字)
//
// Hanzi Writer is loaded as a global from the CDN <script> tag in
// index.html, so we read it from window.HanziWriter.
import { computeDisplayLevel } from "./grade.js";
import { runShowFlow } from "./show-flow.js";
import { attachKidInput } from "./kid-input.js";
import { createWriteSession } from "./session.js";
import { attachHomeView } from "./home-view.js";
import { renderProgressHeader } from "./progress-header.js";
import { centerWhenReady, centerCharacter } from "./char-center.js";
import {
  createHandwritingCoach,
  referenceFromHanziData,
  VALIDATED_STROKE_ORDERS,
} from "./handwriting-coach.js";
import {
  buildVisualReviewPayload,
  childFacingVisualSuggestion,
} from "./visual-review.js";
import { presentationForAttempt } from "./attempt-presentation.js";

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
const prevBtn = document.getElementById("prev-btn");
const nextBtn = document.getElementById("next-btn");
const exitBtn = document.getElementById("exit-btn");
const statusEl = document.getElementById("status");
const scoreEl = document.getElementById("score");
const progressHeader = document.getElementById("progress-header");

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
// Issue #80: typing in the input clears any stale error/success
// message from a prior attempt, so the kid sees a clean slate
// instead of a red "没有新增" lingering from the previous try.
charsInput.addEventListener("input", homeView_._onInput);

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

function presentCurrent(opts = {}) {
  if (session.isDone) {
    statusEl.textContent = "本轮结束，回主页";
    if (progressHeader) progressHeader.textContent = "";
    setPhase("done");
    setTimeout(exitToHome, 1500);
    return;
  }
  const item = session.currentItem;
  // v0.8.3 (issue #81): progress header is a SEPARATE persistent
  // element above the stage. It shows "第 N/M 字 · X" and stays
  // visible across all phases. The phase status (statusEl) keeps
  // its per-phase text — they don't compete for the same space.
  if (progressHeader) {
    const r = renderProgressHeader({
      sessionIdx: session.sessionIdx,
      total: session.session.length,
      char: item.char,
    });
    progressHeader.textContent = r.text;
  }
  startWord(item, opts);
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
  // v0.8.3 (issue #85): 上一字 only shows on submitted phase
  // (kid can review previous attempt) AND only if there's a
  // previous char to go to.
  if (prevBtn) {
    prevBtn.style.display = "none";
    prevBtn.disabled = !session.canGoPrev;
  }
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
    if (prevBtn && session.canGoPrev) {
      prevBtn.style.display = "";
      prevBtn.disabled = false;
    }
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

async function startWord(item, opts = {}) {
  clearPendingTimers();
  const presentation = presentationForAttempt(opts);
  // v0.8.3 (issue #85): when reviewing a previous char (keepStrokes),
  // don't clear item.strokes — we want to redraw the kid's ink
  // alongside the reference. The caller (prevBtn handler) passes
  // { keepStrokes: true }.
  const keepStrokes = !!opts.keepStrokes;
  // Clear previous instance + kid's strokes
  hanziTarget.innerHTML = "";
  kidSvg.innerHTML = "";
  if (scoreEl) { scoreEl.textContent = ""; scoreEl.style.display = "none"; }
  if (!keepStrokes) {
    item.strokes = [];   // [{pathEl, d, points}] for the current attempt
    item.process = createAttemptProcess({
      independentRetry: !!opts.independentRetry,
      followupRetry: !!opts.followupRetry,
    });
  }

  const writer = HanziWriter.create(hanziTarget, item.char, {
    width: STAGE_SIZE,
    height: STAGE_SIZE,
    // v0.8.2.2: padding 5 made "一" span 88% of the viewBox
    // horizontally (look "huge" on phones), and pushed the glyph
    // down past the visual center. v0.9 (PR #79): we now
    // dynamically re-center the character after HanziWriter mounts
    // (see centerWhenReady below), so the padding just needs to
    // keep the glyph from overflowing the SVG itself. 100 is a
    // safe middle ground — small enough that "一" still fits
    // inside the SVG bounds (was 152% wide at padding 5), large
    // enough that tall characters like "量" don't crowd the
    // edge. The visual centering on the stage grid is now the
    // char-center module's job, not padding's.
    padding: 100,
    showCharacter: presentation.showCharacter,
    showOutline: false,
    strokeColor: "#4caf50",
    radicalColor: "#388e3c",
    strokeAnimationSpeed: 1,
    delayBetweenStrokes: 200,
  });
  item.writer = writer;
  if (!keepStrokes) {
    item.coachPromise = HanziWriter.loadCharacterData(item.char)
      .then((characterData) =>
        createHandwritingCoach({
          reference: referenceFromHanziData(characterData, {
            stageSize: STAGE_SIZE,
            padding: 100,
            variantOrders: VALIDATED_STROKE_ORDERS[item.char] ?? [],
          }),
          stageSize: STAGE_SIZE,
        }),
      )
      .catch((error) => {
        console.warn("[write] reference unavailable", error);
        return createHandwritingCoach({ reference: { strokes: [] }, stageSize: STAGE_SIZE });
      });
    item.reviewQueue = Promise.resolve();
  }

  // v0.9 (issue: phone "字看不全"): center the character on the
  // stage grid and scale to fit. Different viewports (phone ~358
  // stage, pad ~560 stage) get different scales — same code path.
  // centerWhenReady waits for the HanziWriter data to load (CDN
  // fetch is async) before measuring. We don't await it here —
  // the animation can start in parallel and the transform gets
  // applied the moment the data arrives.
  centerWhenReady({ stage, hanziTarget, kidSvg, margin: 0.1 }).catch(() => {});

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

  if (!presentation.animateReference) {
    item.writer.hideCharacter();
    applyCharacterOpacity(0);
    setPhase(presentation.initialPhase);
    againBtn.style.display = "none";
    statusEl.textContent = presentation.status;
    return;
  }

  // v0.8.2 (issue #68): replace the inline setTimeout(100) hack with
  // runShowFlow. The v0.8.1 timing fired "showing" 100ms after
  // startWord was called, regardless of whether animateCharacter
  // had finished — on a 2.5s animation the kid saw the character
  // flicker because the show window was opening while strokes were
  // still being drawn. runShowFlow drives transitions off the
  // animDone promise, so the show window starts only when the
  // character is actually static. Tested in show-flow.test.js.
  setPhase(presentation.initialPhase);
  statusEl.textContent = presentation.status;
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

// SVG namespace — kid-input.js needs this to build real <path>
// elements via createElementNS. We pass it as the createElement
// dependency so the module never reaches for `document` directly
// (which keeps it testable without a DOM in node --test).
const SVG_NS = "http://www.w3.org/2000/svg";
const createSvgElement = (tag) => document.createElementNS(SVG_NS, tag);

function createAttemptProcess({ independentRetry = false, followupRetry = false } = {}) {
  return {
    orderErrors: 0,
    directionErrors: 0,
    rejectedStrokes: 0,
    uncertainStrokes: 0,
    errorsByStroke: {},
    hintCounts: [],
    strokeReviews: [],
    manualUndos: 0,
    undoEvents: [],
    independentRetry,
    followupRetry,
  };
}

const kidInput = attachKidInput({
  svg: kidSvg,
  stageSize: STAGE_SIZE,
  isWritingPhase: () => phase === "writing",
  onStroke: (s) => {
    const item = session.currentItem;
    if (!item) return;
    item.reviewQueue = (item.reviewQueue ?? Promise.resolve())
      .then(() => reviewCompletedStroke(item, s))
      .catch((error) => {
        console.error("[write] stroke review failed", error);
        // A system failure is not a child error. Keep the stroke and
        // let submit return an unscorable result if needed.
        item.strokes.push(s);
      });
  },
  createElement: createSvgElement,
});
const enableKidInput = () => kidInput.attach();
const disableKidInput = () => kidInput.detach();

async function reviewCompletedStroke(item, stroke) {
  const coach = await item.coachPromise;
  const process = item.process ?? (item.process = createAttemptProcess());
  const decision = coach.reviewStroke({
    acceptedStrokes: item.strokes.map((saved) => saved.points),
    candidate: stroke.points,
    errorCounts: process.errorsByStroke,
  });
  const reviewId = (process.strokeReviews?.length ?? 0) + 1;
  (process.strokeReviews ??= []).push({
    id: reviewId,
    path: stroke.d,
    points: stroke.points,
    verdict: decision.status,
    accepted: decision.accept,
    confidence: decision.confidence,
    reasonCode: decision.reason?.code ?? null,
    expectedStrokeIndex: decision.expectedStrokeIndex,
    matchedStrokeIndex: decision.matchedStrokeIndex,
    hintLevel: decision.hint?.level ?? null,
    expectedPoints: decision.hint?.points ?? null,
  });
  stroke.reviewId = reviewId;

  if (decision.accept) {
    item.strokes.push(stroke);
    if (decision.status === "uncertain") process.uncertainStrokes++;
    clearCoachOverlay();
    if (scoreEl) {
      scoreEl.style.display = "none";
      scoreEl.textContent = "";
      scoreEl.title = "";
    }
    statusEl.textContent = decision.status === "uncertain"
      ? decision.reason.message
      : `第 ${item.strokes.length} 笔写好了`;
    return;
  }

  removeStrokeElement(stroke);
  const index = decision.expectedStrokeIndex;
  process.errorsByStroke[index] = Number(process.errorsByStroke[index] ?? 0) + 1;
  process.rejectedStrokes++;
  process.hintCounts[index] = decision.hint?.level ?? 1;
  if (decision.reason.code === "stroke_order_wrong") process.orderErrors++;
  if (decision.reason.code === "stroke_direction_reversed") process.directionErrors++;
  renderCoachHint(decision);
  statusEl.textContent = decision.reason.message;
  if (decision.hint?.animate && typeof item.writer?.animateStroke === "function") {
    item.writer.animateStroke(index);
  }
}

function removeStrokeElement(stroke) {
  if (stroke?.pathEl?.parentNode === kidSvg) kidSvg.removeChild(stroke.pathEl);
}

function clearCoachOverlay() {
  for (const node of kidSvg.querySelectorAll("[data-coach-overlay]")) node.remove();
}

function renderCoachHint(decision) {
  clearCoachOverlay();
  const points = decision.hint?.points ?? [];
  if (points.length === 0) return;
  const path = createSvgElement("path");
  path.setAttribute("data-coach-overlay", "true");
  path.setAttribute(
    "d",
    points.map((point, index) => `${index === 0 ? "M" : "L"} ${point.x} ${point.y}`).join(" "),
  );
  path.setAttribute("fill", "none");
  path.setAttribute("stroke", "#ff9800");
  path.setAttribute("stroke-width", "12");
  path.setAttribute("stroke-linecap", "round");
  path.setAttribute("stroke-dasharray", decision.hint.level === 1 ? "18 14" : "none");
  path.setAttribute("opacity", "0.75");
  kidSvg.appendChild(path);

  if (decision.hint.showStart) {
    const start = points[0];
    const marker = createSvgElement("circle");
    marker.setAttribute("data-coach-overlay", "true");
    marker.setAttribute("cx", String(start.x));
    marker.setAttribute("cy", String(start.y));
    marker.setAttribute("r", "16");
    marker.setAttribute("fill", "#ff9800");
    marker.setAttribute("opacity", "0.9");
    kidSvg.appendChild(marker);
  }

  if (decision.hint.showDirection && points.length > 1) {
    const end = points[Math.min(points.length - 1, Math.max(1, Math.floor(points.length / 3)))];
    const start = points[0];
    const angle = Math.atan2(end.y - start.y, end.x - start.x);
    const tip = { x: end.x, y: end.y };
    const wing = 18;
    const arrow = createSvgElement("polygon");
    arrow.setAttribute("data-coach-overlay", "true");
    arrow.setAttribute(
      "points",
      [
        tip,
        { x: tip.x - wing * Math.cos(angle - 0.55), y: tip.y - wing * Math.sin(angle - 0.55) },
        { x: tip.x - wing * Math.cos(angle + 0.55), y: tip.y - wing * Math.sin(angle + 0.55) },
      ].map((point) => `${point.x},${point.y}`).join(" "),
    );
    arrow.setAttribute("fill", "#ff9800");
    kidSvg.appendChild(arrow);
  }
}

// ===========================================================================
//  Submit / Undo / Coach assessment
// ===========================================================================

function undoLastStroke() {
  const item = session.currentItem;
  if (!item || !item.strokes || item.strokes.length === 0) return;
  const last = item.strokes.pop();
  const process = item.process ?? (item.process = createAttemptProcess());
  process.manualUndos = Number(process.manualUndos ?? 0) + 1;
  (process.undoEvents ??= []).push({
    reviewId: last?.reviewId ?? null,
    path: last?.d ?? null,
    atStrokeIndex: item.strokes.length,
  });
  if (last && last.pathEl && last.pathEl.parentNode === kidSvg) {
    kidSvg.removeChild(last.pathEl);
  }
  // No redo, by user request. State change is one-way.
}

async function submitCurrent() {
  const item = session.currentItem;
  if (!item) return;
  await (item.reviewQueue ?? Promise.resolve());
  const strokes = item.strokes || [];
  const combined = strokes.map((s) => s.d).join(" ");
  const coach = await item.coachPromise;
  const assessment = coach.assess({
    strokes: strokes.map((stroke) => stroke.points),
    process: item.process ?? {},
  });

  if (!assessment.canSubmit) {
    renderAssessment(assessment);
    statusEl.textContent = assessment.primaryReason.message;
    if (assessment.nextStroke) {
      renderCoachHint({ hint: { level: 1, points: assessment.nextStroke } });
    }
    return;
  }

  renderAssessment(assessment);
  const persistedAssessment = {
    status: assessment.status,
    score: assessment.score,
    band: assessment.band,
    strokes: strokes.map((stroke) => stroke.points),
    breakdown: assessment.breakdown,
    reasons: assessment.reasons,
    process: item.process ?? {},
    algorithmVersion: assessment.algorithmVersion,
    nextAction: assessment.nextAction,
    retryOutcome: assessment.retryOutcome,
    reviewNeeded: assessment.reviewNeeded,
    modelReview: { status: assessment.reviewRecommended ? "pending" : "skipped" },
  };

  let attemptId = null;
  item.latestAttemptId = null;
  try {
    const saved = await window.StudyBuddy.fetch(API + "/attempts", {
      method: "POST",
      body: {
        char: item.char,
        level: item.opacity,
        strokePath: combined,
        assessment: persistedAssessment,
      },
    });
    attemptId = saved?.attemptId ?? null;
    item.latestAttemptId = attemptId;
  } catch (e) {
    console.error("[write] submitCurrent: attempt POST failed", e);
  }

  if (item.writer) {
    item.writer.showCharacter();
    applyCharacterOpacity(1.0);
  }
  disableKidInput();
  setPhase("submitted");
  item.requiresIndependentRetry = assessment.requiresIndependentRetry;
  item.requiresRewrite = assessment.requiresRetry;
  if (assessment.requiresIndependentRetry) {
    retryBtn.textContent = "独立再写一次";
    nextBtn.style.display = "none";
    statusEl.textContent = "改对了。现在不看提示，独立写一次";
  } else if (assessment.requiresRetry) {
    retryBtn.textContent = "重新观察再写一次";
    nextBtn.style.display = "none";
    statusEl.textContent = "位置偏得有点多，重新观察方格后再写一次";
  } else if (assessment.nextAction === "review_later") {
    statusEl.textContent = "这次先记下来，下次再练";
  } else {
    retryBtn.textContent = "重练";
    statusEl.textContent = "看完原因，可以重练或写下一个字";
  }

  if (assessment.reviewRecommended && attemptId) {
    void requestVisualReview(item, assessment, attemptId);
  }
}

function renderAssessment(assessment) {
  if (!scoreEl) return;
  scoreEl.style.display = "";
  const messages = [assessment.primaryReason?.message, assessment.secondaryReason?.message]
    .filter(Boolean);
  scoreEl.textContent = [assessment.band, ...messages].join(" · ");
  scoreEl.title = messages.join("；") || assessment.band;
  renderAssessmentOverlay(assessment.primaryReason?.overlay);
}

function renderAssessmentOverlay(overlay) {
  clearCoachOverlay();
  if (!overlay) return;
  if (overlay.kind === "translation") {
    const line = createSvgElement("line");
    line.setAttribute("data-coach-overlay", "true");
    line.setAttribute("x1", "300");
    line.setAttribute("y1", "300");
    line.setAttribute("x2", String(300 + overlay.dx));
    line.setAttribute("y2", String(300 + overlay.dy));
    line.setAttribute("stroke", "#ff9800");
    line.setAttribute("stroke-width", "12");
    line.setAttribute("stroke-linecap", "round");
    kidSvg.appendChild(line);
  } else if (overlay.kind === "bounds") {
    appendBoundsOverlay(overlay.expected, "#4caf50", "18 12");
    appendBoundsOverlay(overlay.actual, "#ff9800", "none");
  } else if (overlay.kind === "stroke") {
    const stroke = session.currentItem?.strokes?.[overlay.strokeIndex];
    if (stroke?.d) {
      const path = createSvgElement("path");
      path.setAttribute("data-coach-overlay", "true");
      path.setAttribute("d", stroke.d);
      path.setAttribute("fill", "none");
      path.setAttribute("stroke", "#ff9800");
      path.setAttribute("stroke-width", "18");
      path.setAttribute("stroke-linecap", "round");
      path.setAttribute("opacity", "0.55");
      kidSvg.insertBefore(path, kidSvg.firstChild);
    }
  } else if (overlay.kind === "character") {
    appendBoundsOverlay(overlay.expected, "#ff9800", "18 12");
  } else if (overlay.kind === "stroke-order" || overlay.kind === "stroke-direction") {
    renderCoachHint({
      hint: {
        level: overlay.kind === "stroke-direction" ? 2 : 1,
        points: overlay.points,
        showStart: overlay.kind === "stroke-direction",
        showDirection: overlay.kind === "stroke-direction",
      },
    });
  }
}

function appendBoundsOverlay(bounds, color, dash) {
  if (!bounds) return;
  const rect = createSvgElement("rect");
  rect.setAttribute("data-coach-overlay", "true");
  rect.setAttribute("x", String(bounds.minX));
  rect.setAttribute("y", String(bounds.minY));
  rect.setAttribute("width", String(Math.max(bounds.width, 1)));
  rect.setAttribute("height", String(Math.max(bounds.height, 1)));
  rect.setAttribute("fill", "none");
  rect.setAttribute("stroke", color);
  rect.setAttribute("stroke-width", "8");
  rect.setAttribute("stroke-dasharray", dash);
  rect.setAttribute("opacity", "0.8");
  kidSvg.appendChild(rect);
}

async function requestVisualReview(item, assessment, attemptId) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 4_000);
  try {
    const imageBase64 = captureAttemptImage(item.strokes ?? []);
    const payload = buildVisualReviewPayload({ assessment, imageBase64 });
    if (!payload) return;
    const review = await window.StudyBuddy.fetch(API + "/review", {
      method: "POST",
      signal: controller.signal,
      body: payload,
    });
    const suggestion = childFacingVisualSuggestion(assessment, review);
    if (
      session.currentItem === item &&
      item.latestAttemptId === attemptId &&
      phase === "submitted" &&
      suggestion
    ) {
      scoreEl.textContent += ` · ${suggestion}`;
    }
    await persistModelReview(attemptId, review);
  } catch (error) {
    console.info("[write] optional visual review skipped", error);
    try {
      await persistModelReview(attemptId, { status: "failed" });
    } catch {
      // Best effort: local coaching already completed and is authoritative.
    }
  } finally {
    clearTimeout(timeout);
  }
}

function persistModelReview(attemptId, modelReview) {
  return window.StudyBuddy.fetch(`${API}/attempts/${attemptId}/model-review`, {
    method: "PATCH",
    body: { modelReview },
  });
}

function captureAttemptImage(strokes) {
  const size = 300;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, size, size);
  ctx.strokeStyle = "#d7e2f2";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(size / 2, 0);
  ctx.lineTo(size / 2, size);
  ctx.moveTo(0, size / 2);
  ctx.lineTo(size, size / 2);
  ctx.stroke();
  ctx.save();
  ctx.scale(size / STAGE_SIZE, size / STAGE_SIZE);
  ctx.strokeStyle = "#111";
  ctx.lineWidth = 10;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  for (const stroke of strokes) {
    if (!stroke.d) continue;
    ctx.stroke(new Path2D(stroke.d));
  }
  ctx.restore();
  return canvas.toDataURL("image/jpeg", 0.82).split(",")[1] ?? "";
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
  const independentRetry = !!item?.requiresIndependentRetry;
  const followupRetry = !!item?.requiresRewrite;
  if (item) item.requiresIndependentRetry = false;
  if (item) item.requiresRewrite = false;
  enableKidInput();
  startWord(item, { independentRetry, followupRetry });
};

nextBtn.onclick = () => {
  if (phase !== "submitted") return;
  session.next();
  enableKidInput();
  presentCurrent();
};

// v0.8.3 (issue #85): 上一字 button — re-shows the previous char
// in submitted state (ref + kid ink visible). Does NOT clear the
// strokes — the whole point is for the kid to see what they wrote.
// Only enabled when session.canGoPrev (i.e. sessionIdx > 0).
prevBtn.onclick = () => {
  if (phase !== "submitted") return;
  if (!session.canGoPrev) return;
  session.prev();
  // Re-render the now-current item. startWord rebuilds the SVG
  // and redraws the saved strokes from item.strokes. Pass
  // { keepStrokes: true } so the kid's ink isn't wiped.
  enableKidInput();
  presentCurrent({ keepStrokes: true });
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

// v0.9 (PR #79): re-center the character on viewport resize.
// The stage is responsive (min(560px, 92vw)), so a phone going
// from portrait to landscape, or a URL bar collapsing/expanding,
// changes the stage size. The character was scaled for the old
// size; without re-centering it would float off the grid.
// Debounce so we don't run this on every pixel of a soft keyboard
// animation. We measure synchronously here (data is already
// loaded) — centerWhenReady's MutationObserver isn't needed.
let resizeTimer = null;
window.addEventListener("resize", () => {
  if (resizeTimer) clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    centerCharacter({ stage, hanziTarget, kidSvg, margin: 0.1 });
  }, 120);
});

// ----- Boot -----
enableKidInput();   // attach the input handlers; the phase check
                    // (`if (phase !== "writing") return;`) keeps them
                    // inert until the kid is allowed to draw.
loadLibrary();
