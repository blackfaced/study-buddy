// web/buddy/photo-only.test.js
//
// Tests for the photo-only mode (BUDDY_CHAT_ENABLED=false): the buddy
// page hides the chat UI but keeps the 📷 mistake-capture button —
// photo capture is the mistake ledger's biggest intake source.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "photo-only.js"), "utf8");

function loadModule() {
  const window = {};
  vm.runInNewContext(source, vm.createContext({ window }));
  return window.BuddyPhotoOnly;
}

function stubEl(text) {
  const classes = new Set();
  return {
    style: {},
    textContent: text || "",
    classList: {
      add: (c) => classes.add(c),
      contains: (c) => classes.has(c),
    },
  };
}

function stubEls() {
  return {
    app: stubEl(),
    chat: stubEl(),
    input: stubEl(),
    sendBtn: stubEl(),
    photoBtn: stubEl(),
    videoToggle: stubEl("📷 开"),
    endBtn: stubEl("✅ 写完啦"),
    flipBtn: stubEl("🔄 翻转"),
    name: stubEl("小书童"),
    avatar: stubEl("📚"),
    pinHint: stubEl("这个聊天要大人先开个门"),
    permTitle: stubEl("小书童想看你~"),
    permHint: stubEl("需要打开摄像头才能陪你写作业哦"),
    photoStatus: stubEl("确认清楚后，再让小书童读题。"),
    serverTitle: stubEl("连不上小书童服务器"),
    doc: { title: "小书童 · v4" },
  };
}

test("applyPhotoOnlyMode hides the chat area, input and send button", () => {
  const BuddyPhotoOnly = loadModule();
  const els = stubEls();
  BuddyPhotoOnly.applyPhotoOnlyMode(els);
  assert.equal(els.chat.style.display, "none");
  assert.equal(els.input.style.display, "none");
  assert.equal(els.sendBtn.style.display, "none");
  assert.ok(els.app.classList.contains("photo-only"));
});

test("applyPhotoOnlyMode hides the chat-era video toggle and end-session buttons", () => {
  const BuddyPhotoOnly = loadModule();
  const els = stubEls();
  BuddyPhotoOnly.applyPhotoOnlyMode(els);
  // 开视频 drives the homework posture loop, 写完啦 ends a chat session —
  // neither means anything when the kid is only photographing mistakes.
  assert.equal(els.videoToggle.style.display, "none");
  assert.equal(els.endBtn.style.display, "none");
});

test("real user scenario: with chat hidden the kid still sees and can use the 📷 button", () => {
  const BuddyPhotoOnly = loadModule();
  const els = stubEls();
  BuddyPhotoOnly.applyPhotoOnlyMode(els);
  // The photo button must NOT be hidden or disabled — captureMistake
  // is bound to it and is the whole point of photo-only mode.
  assert.notEqual(els.photoBtn.style.display, "none");
  assert.equal(els.photoBtn.disabled, undefined);
});

test("real user scenario: camera flip stays — aiming the rear camera at a worksheet needs it", () => {
  const BuddyPhotoOnly = loadModule();
  const els = stubEls();
  BuddyPhotoOnly.applyPhotoOnlyMode(els);
  assert.notEqual(els.flipBtn.style.display, "none");
});

test("applyPhotoOnlyMode swaps the 小书童 chat branding for 拍错题 copy", () => {
  const BuddyPhotoOnly = loadModule();
  const els = stubEls();
  BuddyPhotoOnly.applyPhotoOnlyMode(els);
  assert.equal(els.name.textContent, "拍错题");
  assert.equal(els.avatar.textContent, "📷");
  assert.equal(els.doc.title, "拍错题");
  // Gate / permission copy must not sell a chat the kid no longer has.
  assert.ok(!els.pinHint.textContent.includes("聊天"));
  assert.ok(!els.permTitle.textContent.includes("小书童"));
  assert.ok(!els.permHint.textContent.includes("写作业"));
});

test("applyPhotoOnlyMode swaps the remaining 小书童 mentions in the capture flow", () => {
  const BuddyPhotoOnly = loadModule();
  const els = stubEls();
  BuddyPhotoOnly.applyPhotoOnlyMode(els);
  // The photo-review status line sits inside the 拍错题 flow itself —
  // it is the worst place for chat branding to leak through.
  assert.ok(!els.photoStatus.textContent.includes("小书童"));
  assert.ok(!els.serverTitle.textContent.includes("小书童"));
});

test("applyPhotoOnlyMode tolerates a minimal element set (old call sites)", () => {
  const BuddyPhotoOnly = loadModule();
  const els = { app: stubEl(), chat: stubEl(), input: stubEl(), sendBtn: stubEl() };
  BuddyPhotoOnly.applyPhotoOnlyMode(els);
  assert.equal(els.chat.style.display, "none");
});

test("portalEntry(false) returns the photo-capture copy for the portal entry", () => {
  const BuddyPhotoOnly = loadModule();
  const entry = BuddyPhotoOnly.portalEntry(false);
  assert.equal(entry.emoji, "📷");
  assert.equal(entry.title, "拍错题");
  assert.ok(entry.desc.length > 0);
  assert.ok(!entry.desc.includes("聊天"));
});

test("portalEntry(true) returns null so the portal keeps its static copy", () => {
  const BuddyPhotoOnly = loadModule();
  assert.equal(BuddyPhotoOnly.portalEntry(true), null);
});

test("portalEntry(undefined) returns null — an old server without the field keeps the default", () => {
  const BuddyPhotoOnly = loadModule();
  assert.equal(BuddyPhotoOnly.portalEntry(undefined), null);
});

test("welcomeCopy(false) returns null — photo-only mode must not greet the kid as 小书童", () => {
  const BuddyPhotoOnly = loadModule();
  // Found in acceptance 9/5: after the PIN gate the camera-permission
  // flow still spoke "你好呀！我是小书童" out loud — the chat area is
  // hidden but the TTS played anyway.
  assert.equal(BuddyPhotoOnly.welcomeCopy(false), null);
});

test("welcomeCopy(true/undefined) returns the chat welcome", () => {
  const BuddyPhotoOnly = loadModule();
  assert.ok(BuddyPhotoOnly.welcomeCopy(true).includes("小书童"));
  assert.ok(BuddyPhotoOnly.welcomeCopy(undefined).includes("小书童"));
});
