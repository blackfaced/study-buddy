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
let library = [];   // [{ char, addedAt, addedBy, attemptCount }] from server
let session = [];   // current 5-char session
let sessionIdx = 0;
let phase = null;   // 'animating' | 'showing' | 'writing' | 'submitted'
let pendingTimers = [];  // {kind: 'showing'|'animate', timer} so we can cancel on retry

// ===========================================================================
//  Home view — load + render library
// ===========================================================================

async function loadLibrary() {
  try {
    // v0.7 (issue #21): use shared fetch.
    const data = await window.StudyBuddy.fetch(API + "/words");
    library = data.words || [];
    renderLibrary();
  } catch {
    homeError.textContent = "加载字库失败";
  }
}

function renderLibrary() {
  wordList.innerHTML = "";
  for (const w of library) {
    const cell = document.createElement("div");
    cell.className = "word-cell";
    cell.title = `练过 ${w.attemptCount} 次`;
    const ch = document.createElement("span");
    ch.textContent = w.char;
    cell.appendChild(ch);
    if (w.attemptCount > 0) {
      const c = document.createElement("span");
      c.className = "attempts";
      c.textContent = `×${w.attemptCount}`;
      cell.appendChild(c);
    }
    const del = document.createElement("button");
    del.textContent = "×";
    del.title = `删 "${w.char}"`;
    del.onclick = async () => {
      if (!confirm(`确定删 "${w.char}" 吗？历史练习也会一起删。`)) return;
      try {
        await window.StudyBuddy.fetch(API + "/words/" + encodeURIComponent(w.char), { method: "DELETE" });
      } catch { /* ignore — loadLibrary will re-render anyway */ }
      await loadLibrary();
    };
    cell.appendChild(del);
    wordList.appendChild(cell);
  }
  startBtn.disabled = library.length === 0;
}

async function addChars() {
  homeError.textContent = "";
  const chars = charsInput.value.trim();
  if (!chars) {
    homeError.textContent = "请输入要练的字";
    return;
  }
  try {
    const r = await window.StudyBuddy.fetch(API + "/words", {
      method: "POST",
      body: { chars, addedBy: "parent" },
    });
    charsInput.value = "";
    if (r.added === 0) {
      homeError.textContent = "没有新增（可能都是重复字或非汉字）";
    } else if (r.skipped > 0) {
      homeError.textContent = `新增 ${r.added} 个，跳过 ${r.skipped} 个重复`;
    }
    await loadLibrary();
  } catch {
    homeError.textContent = "添加失败";
  }
}

addBtn.onclick = addChars;
charsInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") addChars();
});

startBtn.onclick = () => {
  if (library.length === 0) return;
  session = [];
  for (let i = 0; i < 5; i++) {
    const w = library[i % library.length];
    session.push({ char: w.char, attemptCount: w.attemptCount, lastShownAt: null, opacity: 1.0 });
  }
  sessionIdx = 0;
  homeView.classList.add("hidden");
  practiceView.classList.add("active");
  presentCurrent();
};

// ===========================================================================
//  Practice view — Apple Pencil + Hanzi Writer
// ===========================================================================

function clearPendingTimers() {
  for (const t of pendingTimers) clearTimeout(t.timer);
  pendingTimers = [];
}

function presentCurrent() {
  if (sessionIdx >= session.length) {
    statusEl.textContent = "本轮结束，回主页";
    setPhase("done");
    setTimeout(exitToHome, 1500);
    return;
  }
  const item = session[sessionIdx];
  // v0.7 (issue #63): em-dash "—" rendered as a Chinese-glyph in some
  // mobile fonts, making the status read "第 1/5 字 — 一" like "字 一 一".
  // "·" middle dot is much safer.
  statusEl.textContent = `第 ${sessionIdx + 1} / ${session.length} 字 · ${item.char}`;
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

  // Decided opacity from grade.js
  const now = Date.now();
  const level = computeDisplayLevel({
    attemptCount: item.attemptCount,
    lastShownAt: item.lastShownAt,
    now,
    cooldownMs: COOLDOWN_MS,
  });
  item.opacity = level;
  item.startedAt = now;
  item.lastShownAt = now;
  item.shownOpacity = level;
  applyCharacterOpacity(level);

  // v0.8 (issue #65): always auto-animate on entering a new char, then
  // show the static reference for SHOW_MS, then hide so the kid writes.
  setPhase("animating");
  statusEl.textContent = "看笔顺 ↓";
  // Re-show the character at full opacity for the animation, then
  // settle to the per-attempt level (could be 0.5/0 for re-attempts).
  applyCharacterOpacity(1.0);
  const animDone = new Promise((resolve) => {
    writer.animateCharacter({
      onComplete: () => resolve(),
    });
  });
  const t1 = setTimeout(() => {
    applyCharacterOpacity(level);
    setPhase("showing");
    statusEl.textContent = "看 3 秒后字会消失";
    const t2 = setTimeout(() => {
      if (phase !== "showing") return; // user already advanced/retryed
      writer.hideCharacter();
      statusEl.textContent = "字消失啦，开始写 ↓";
      setPhase("writing");
    }, SHOW_MS);
    pendingTimers.push({ kind: "showing", timer: t2 });
  }, 100);  // give HanziWriter 100ms to start
  pendingTimers.push({ kind: "animating", timer: t1 });
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
// ===========================================================================

function enableKidInput() {
  let activePath = null;
  let activeD = "";

  function getPos(e) {
    const rect = kidSvg.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * STAGE_SIZE;
    const y = ((e.clientY - rect.top) / rect.height) * STAGE_SIZE;
    return { x, y };
  }

  kidSvg.onpointerdown = (e) => {
    if (phase !== "writing") return;
    e.preventDefault();
    kidSvg.setPointerCapture(e.pointerId);
    const p = getPos(e);
    activeD = `M ${p.x} ${p.y}`;
    activePath = document.createElementNS("http://www.w3.org/2000/svg", "path");
    activePath.setAttribute("d", activeD);
    activePath.setAttribute("stroke", "#e74c3c");
    activePath.setAttribute("stroke-width", "6");
    activePath.setAttribute("stroke-linecap", "round");
    activePath.setAttribute("stroke-linejoin", "round");
    activePath.setAttribute("fill", "none");
    kidSvg.appendChild(activePath);
  };

  kidSvg.onpointermove = (e) => {
    if (!activePath) return;
    e.preventDefault();
    const p = getPos(e);
    activeD += ` L ${p.x} ${p.y}`;
    activePath.setAttribute("d", activeD);
  };

  kidSvg.onpointerup = (e) => {
    if (!activePath) return;
    e.preventDefault();
    const item = session[sessionIdx];
    item.strokes.push({ pathEl: activePath, d: activeD });
    activePath.setAttribute("opacity", "0.85");
    activePath = null;
    activeD = "";
  };

  kidSvg.onpointercancel = () => {
    // Treat cancel like a stroke-end so the kid doesn't lose ink if
    // their palm briefly leaves the surface.
    if (activePath) {
      const item = session[sessionIdx];
      item.strokes.push({ pathEl: activePath, d: activeD });
      activePath.setAttribute("opacity", "0.85");
      activePath = null;
      activeD = "";
    }
  };
}

function disableKidInput() {
  kidSvg.onpointerdown = null;
  kidSvg.onpointermove = null;
  kidSvg.onpointerup = null;
  kidSvg.onpointercancel = null;
}

// ===========================================================================
//  Submit / Undo / Score
// ===========================================================================

function undoLastStroke() {
  const item = session[sessionIdx];
  if (!item || !item.strokes || item.strokes.length === 0) return;
  const last = item.strokes.pop();
  if (last && last.pathEl && last.pathEl.parentNode === kidSvg) {
    kidSvg.removeChild(last.pathEl);
  }
  // No redo, by user request. State change is one-way.
}

async function submitCurrent() {
  const item = session[sessionIdx];
  if (!item) return;
  const strokes = item.strokes || [];
  // Concatenate all stroke d-strings into one path the server can
  // accept (we use SVG's M..L space — multiple subpaths work).
  const combined = strokes.map((s) => s.d).join(" ");

  // 1. Compute the score client-side. We do this in the client because
  //    the bbox math needs the rendered SVG (HanziWriter's bbox is in
  //    its own SVG node, not exposed via the server).
  const kidBboxes = strokes
    .map((s) => s.pathEl.getBBox())
    .filter((b) => b && b.width > 0 && b.height > 0)
    .map((b) => ({ x: b.x, y: b.y, w: b.width, h: b.height }));
  // Reference bbox: HanziWriter renders the character at full viewBox
  // when showCharacter=true. We can ask the writer for the character's
  // intrinsic bbox via quiz/options, but the simplest reliable read is
  // the union of the rendered stroke paths in the writer's SVG.
  let refBbox = null;
  let refStrokes = 0;
  if (item.writer) {
    const refSvg = hanziTarget.querySelector("svg");
    if (refSvg) {
      const paths = refSvg.querySelectorAll("path");
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      paths.forEach((p) => {
        try {
          const b = p.getBBox();
          if (b.width <= 0 || b.height <= 0) return;
          if (b.x < minX) minX = b.x;
          if (b.y < minY) minY = b.y;
          if (b.x + b.width > maxX) maxX = b.x + b.width;
          if (b.y + b.height > maxY) maxY = b.y + b.height;
          refStrokes++;
        } catch { /* getBBox can throw on detached nodes */ }
      });
      if (isFinite(minX)) {
        refBbox = { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
      }
    }
  }

  const { stars, breakdown } = scoreStrokes({
    kidStrokes: strokes.length,
    refStrokes: Math.max(refStrokes, 1),  // if writer gave 0, pretend 1 so 0 kid → 0 score
    kidBboxes,
    refBbox,
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
  scoreEl.title = `笔画数 ${(breakdown.strokes * 100).toFixed(0)} · 重合度 ${(breakdown.overlap * 100).toFixed(0)}`;
}

// ===========================================================================
//  Button wiring
// ===========================================================================

againBtn.onclick = () => {
  // "笔顺重放" — re-animate the current character on demand.
  if (phase === "writing" || phase === "animating" || phase === "showing" || phase === "submitted") {
    const item = session[sessionIdx];
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
  const item = session[sessionIdx];
  if (item) item.attemptCount = (item.attemptCount || 0) + 1;  // attempts++; opacity goes down next time
  enableKidInput();
  startWord(item);
};

nextBtn.onclick = () => {
  if (phase !== "submitted") return;
  sessionIdx++;
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
