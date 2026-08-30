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

function stubEl() {
  const classes = new Set();
  return {
    style: {},
    classList: {
      add: (c) => classes.add(c),
      contains: (c) => classes.has(c),
    },
  };
}

function stubEls() {
  return { app: stubEl(), chat: stubEl(), input: stubEl(), sendBtn: stubEl(), photoBtn: stubEl() };
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

test("real user scenario: with chat hidden the kid still sees and can use the 📷 button", () => {
  const BuddyPhotoOnly = loadModule();
  const els = stubEls();
  BuddyPhotoOnly.applyPhotoOnlyMode(els);
  // The photo button must NOT be hidden or disabled — captureMistake
  // is bound to it and is the whole point of photo-only mode.
  assert.notEqual(els.photoBtn.style.display, "none");
  assert.equal(els.photoBtn.disabled, undefined);
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
