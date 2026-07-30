// web/write/client.js
//
// Client logic for the write app (issue #57). Split from index.html
// for the same reasons the buddy chat refactor used modules — easier
// to read, no `const S` collisions, room to grow.
//
// Three views, toggled by toggling .hidden on the home / practice
// sections:
// - home:    word library management (manual entry, list, delete)
// - practice: Apple Pencil + Hanzi Writer overlay (the actual "training")
//
// Hanzi Writer is loaded as a global from the CDN <script> tag in
// index.html, so we read it from window.HanziWriter.
import { computeDisplayLevel } from "./grade.js";

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
const nextBtn = document.getElementById("next-btn");
const exitBtn = document.getElementById("exit-btn");
const statusEl = document.getElementById("status");

// ----- Session state -----
let library = [];   // [{ char, addedAt, addedBy, attemptCount }] from server
let session = [];   // [{ char, opacity, hanziWriterInstance, kidPath, startedAt }] for current session
let sessionIdx = 0;

// ===========================================================================
//  Home view — load + render library
// ===========================================================================

async function loadLibrary() {
  const res = await fetch(API + "/words");
  if (!res.ok) {
    homeError.textContent = "加载字库失败";
    return;
  }
  const data = await res.json();
  library = data.words || [];
  renderLibrary();
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
      await fetch(API + "/words/" + encodeURIComponent(w.char), { method: "DELETE" });
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
  const res = await fetch(API + "/words", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chars, addedBy: "parent" }),
  });
  if (!res.ok) {
    homeError.textContent = "添加失败";
    return;
  }
  const r = await res.json();
  charsInput.value = "";
  if (r.added === 0) {
    homeError.textContent = "没有新增（可能都是重复字或非汉字）";
  } else if (r.skipped > 0) {
    homeError.textContent = `新增 ${r.added} 个，跳过 ${r.skipped} 个重复`;
  }
  await loadLibrary();
}

addBtn.onclick = addChars;
charsInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") addChars();
});

startBtn.onclick = () => {
  if (library.length === 0) return;
  // Build a 5-char session from the library (round-robin if fewer).
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

function presentCurrent() {
  if (sessionIdx >= session.length) {
    statusEl.textContent = "本轮结束，回主页";
    setTimeout(exitToHome, 1500);
    return;
  }
  const item = session[sessionIdx];
  statusEl.textContent = `第 ${sessionIdx + 1} / ${session.length} 字 — ${item.char}`;
  startWord(item);
}

async function startWord(item) {
  // Clear previous instance + kid's strokes
  hanziTarget.innerHTML = "";
  kidSvg.innerHTML = "";
  // Build HanziWriter instance. width/height = STAGE_SIZE so it fills
  // the stage box. showCharacter: true (we manage opacity ourselves).
  const writer = HanziWriter.create(hanziTarget, item.char, {
    width: STAGE_SIZE,
    height: STAGE_SIZE,
    padding: 5,
    showCharacter: true,
    showOutline: false,
    strokeAnimationSpeed: 1,
    delayBetweenStrokes: 200,
  });
  item.writer = writer;

  // Decide opacity: see how many times this char was attempted before
  const now = Date.now();
  const level = computeDisplayLevel({
    attemptCount: item.attemptCount,
    lastShownAt: item.lastShownAt,
    now,
    cooldownMs: COOLDOWN_MS,
  });
  item.opacity = level;
  item.startedAt = now;
  // HanziWriter doesn't have a direct opacity API for showCharacter, so
  // we re-render via quiz() with the right number of strokes shown.
  // Simpler: show the full character at the computed opacity, hide via CSS.
  applyCharacterOpacity(level);

  // Show reference for SHOW_MS, then hide it and let kid write.
  setTimeout(() => {
    if (item.writer) item.writer.hideCharacter();
    statusEl.textContent = "字消失啦，开始写 ↓";
    enableKidInput();
  }, SHOW_MS);

  // Record lastShownAt for the next attempt's cooldown calc.
  item.lastShownAt = now;
  item.shownOpacity = level;
}

function applyCharacterOpacity(opacity) {
  // HanziWriter renders into hanziTarget. Find the rendered <svg> and
  // set opacity on its character path group. Falls back to inline style.
  const svg = hanziTarget.querySelector("svg");
  if (!svg) return;
  svg.style.opacity = String(opacity);
  svg.style.transition = "opacity 0.3s";
}

function enableKidInput() {
  // Apple Pencil via Pointer Events. iOS Safari fires pointer events
  // for both touch and pen. We collect (x, y) per stroke into an SVG
  // path element. pressure info is available but we ignore for v0.1.
  let activePath = null;
  let activeD = "";

  function getPos(e) {
    const rect = kidSvg.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * STAGE_SIZE;
    const y = ((e.clientY - rect.top) / rect.height) * STAGE_SIZE;
    return { x, y };
  }

  kidSvg.onpointerdown = (e) => {
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
  kidSvg.onpointerup = async (e) => {
    if (!activePath) return;
    e.preventDefault();
    const finishedPath = activeD;
    const finishedEl = activePath;
    activePath = null;
    finishedEl.setAttribute("opacity", "0.85");
    // Submit this attempt to the server.
    await submitAttempt(session[sessionIdx], finishedPath);
    // Show visual comparison: re-display the reference character (full
    // opacity this time, since we're now in "compare" mode, not
    // "training" mode).
    if (session[sessionIdx].writer) {
      session[sessionIdx].writer.showCharacter();
      applyCharacterOpacity(1.0);
    }
    statusEl.textContent = "原字 + 你写的 (绿底是原字，红笔是你写的)";
    // Wait a moment for the kid to see, then advance.
    setTimeout(() => {
      sessionIdx++;
      presentCurrent();
    }, 2500);
  };
}

async function submitAttempt(item, kidPath) {
  try {
    await fetch(API + "/attempts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ char: item.char, level: item.opacity, strokePath: kidPath }),
    });
  } catch (e) {
    console.error("[write] submitAttempt failed", e);
  }
}

againBtn.onclick = () => {
  const item = session[sessionIdx];
  if (!item || !item.writer) return;
  item.writer.animateCharacter();
};

nextBtn.onclick = () => {
  sessionIdx++;
  presentCurrent();
};

exitBtn.onclick = exitToHome;

function exitToHome() {
  practiceView.classList.remove("active");
  homeView.classList.remove("hidden");
  // Re-fetch library to update attempt counts
  loadLibrary();
}

// ----- Boot -----
loadLibrary();
