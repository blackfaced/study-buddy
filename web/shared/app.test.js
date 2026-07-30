// web/shared/app.test.js
//
// Unit tests for web/shared/app.js — the cross-app helpers.
// We can't `require` the file directly because it expects a real
// `window` global. Instead we vm.runInNewContext the file inside a
// freshly-built mock DOM per test, so the IIFE populates a clean
// `window.StudyBuddy` each time.
//
// Run with: node --test web/shared/app.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP_SRC = readFileSync(join(__dirname, "app.js"), "utf8");

/** Build a fresh mock window + DOM and load shared/app.js into it. */
function loadFresh() {
  const listeners = new WeakMap();
  const eventTarget = () => ({
    _listeners: [],
    addEventListener(type, fn) { this._listeners.push({ type, fn }); },
    removeEventListener(type, fn) {
      this._listeners = this._listeners.filter((l) => !(l.type === type && l.fn === fn));
    },
  });
  const makeEl = () => {
    const el = eventTarget();
    el.id = "el";
    el.focused = false;
    Object.defineProperty(el, "idempotent", { value: true });
    return el;
  };

  const speakCalls = [];
  const ss = {
    speak(u) { speakCalls.push(u); },
    cancel() {},
  };
  class SpeechSynthesisUtterance {
    constructor(text) { this.text = text; this.volume = 1; }
  }

  const document = {
    activeElement: null,
  };

  const fetchCalls = [];
  const fetchImpl = async (url, init) => {
    fetchCalls.push({ url, init });
    return new Response('{"ok":true}', { status: 200, headers: { "content-type": "application/json" } });
  };

  const window = {
    speechSynthesis: ss,
    StudyBuddy: undefined,
  };
  window.speechSynthesis = ss;

  const ctx = {
    window,
    document,
    SpeechSynthesisUtterance,
    fetch: fetchImpl,
    Response,
    setTimeout, clearTimeout,
    console,
    FormData: class FormData {},
    Blob: class Blob {},
  };
  vm.createContext(ctx);
  vm.runInContext(APP_SRC, ctx);

  return { ctx, window, document, ss, speakCalls, fetchCalls, makeEl, fetchImpl };
}

// =====================================================================
// warmupTTS
// =====================================================================

test("warmupTTS: speaks a silent utterance when speechSynthesis is present", () => {
  const env = loadFresh();
  env.window.StudyBuddy.warmupTTS();
  assert.equal(env.speakCalls.length, 1);
  const u = env.speakCalls[0];
  assert.equal(u.text, " ");
  assert.equal(u.volume, 0);
});

test("warmupTTS: no-op when speechSynthesis is missing", () => {
  const env = loadFresh();
  delete env.window.speechSynthesis;
  // Should not throw.
  env.window.StudyBuddy.warmupTTS();
  // speakCalls is the bound one on the deleted window.speechSynthesis; we
  // can't tell from outside whether the helper called it (the helper
  // guards on 'speechSynthesis' in window), but it must not throw.
});

test("warmupTTS: swallows exceptions from speak()", () => {
  const env = loadFresh();
  env.window.speechSynthesis.speak = () => { throw new Error("denied"); };
  // Must not throw.
  env.window.StudyBuddy.warmupTTS();
});

// =====================================================================
// fetch
// =====================================================================

test("fetch: sets Accept: application/json by default and parses JSON", async () => {
  const env = loadFresh();
  const data = await env.window.StudyBuddy.fetch("/api/x");
  assert.deepEqual(data, { ok: true });
  assert.equal(env.fetchCalls.length, 1);
  const call = env.fetchCalls[0];
  assert.equal(call.url, "/api/x");
  assert.equal(call.init.headers.Accept, "application/json");
});

test("fetch: serialises plain-object body and sets Content-Type", async () => {
  const env = loadFresh();
  await env.window.StudyBuddy.fetch("/api/y", { method: "POST", body: { a: 1 } });
  const call = env.fetchCalls[0];
  assert.equal(call.init.method, "POST");
  assert.equal(call.init.headers["Content-Type"], "application/json");
  assert.equal(call.init.body, '{"a":1}');
});

test("fetch: does not overwrite user-supplied Content-Type", async () => {
  const env = loadFresh();
  await env.window.StudyBuddy.fetch("/api/z", {
    method: "POST",
    headers: { "Content-Type": "application/x-custom" },
    body: { a: 1 },
  });
  assert.equal(env.fetchCalls[0].init.headers["Content-Type"], "application/x-custom");
});

test("fetch: leaves FormData body alone (no auto Content-Type)", async () => {
  const env = loadFresh();
  const fd = new env.ctx.FormData();
  await env.window.StudyBuddy.fetch("/api/upload", { method: "POST", body: fd });
  const call = env.fetchCalls[0];
  assert.strictEqual(call.init.body, fd);
  assert.equal(call.init.headers["Content-Type"], undefined);
});

test("fetch: throws on non-2xx with status + text attached", async () => {
  const env = loadFresh();
  env.fetchImpl = async () =>
    new Response("boom", { status: 503, headers: { "content-type": "text/plain" } });
  env.ctx.fetch = env.fetchImpl;
  await assert.rejects(
    env.window.StudyBuddy.fetch("/api/x"),
    (err) => err.status === 503 && err.text === "boom" && /-> 503/.test(err.message),
  );
});

test("fetch: returns text for non-JSON responses", async () => {
  const env = loadFresh();
  env.fetchImpl = async () =>
    new Response("hello", { status: 200, headers: { "content-type": "text/plain" } });
  env.ctx.fetch = env.fetchImpl;
  const out = await env.window.StudyBuddy.fetch("/api/x");
  assert.equal(out, "hello");
});

// =====================================================================
// cameraPause
// =====================================================================

test("cameraPause: stops the stream on focus and runs onPause", () => {
  const env = loadFresh();
  const trigger = env.makeEl();
  const stopCalls = [];
  const fakeStream = { getTracks: () => [{ stop: () => stopCalls.push(1) }] };
  const pauses = [];
  const off = env.window.StudyBuddy.cameraPause({
    triggerEl: trigger,
    getStream: () => fakeStream,
    onPause: () => pauses.push(1),
  });
  trigger._listeners.find((l) => l.type === "focus").fn();
  assert.equal(stopCalls.length, 1);
  assert.equal(pauses.length, 1);
  off();
});

test("cameraPause: on blur, schedules openCamera after resumeDelayMs", async () => {
  const env = loadFresh();
  const trigger = env.makeEl();
  let openCalls = 0;
  let resumeCalls = 0;
  const openCamera = () => { openCalls++; return Promise.resolve(null); };
  const onResume = () => { resumeCalls++; };
  const off = env.window.StudyBuddy.cameraPause({
    triggerEl: trigger,
    getStream: () => null,
    openCamera,
    onResume,
    resumeDelayMs: 5,  // tiny delay so the test is fast
  });
  trigger._listeners.find((l) => l.type === "focus").fn();
  trigger._listeners.find((l) => l.type === "blur").fn();
  // Wait for the resume timer to fire.
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(openCalls, 1);
  assert.equal(resumeCalls, 1);
  off();
});

test("cameraPause: cancels pending resume if the user re-focuses before the timer fires", async () => {
  const env = loadFresh();
  const trigger = env.makeEl();
  let openCalls = 0;
  const openCamera = () => { openCalls++; return Promise.resolve(null); };
  const off = env.window.StudyBuddy.cameraPause({
    triggerEl: trigger,
    getStream: () => null,
    openCamera,
    resumeDelayMs: 5,
  });
  const focus = trigger._listeners.find((l) => l.type === "focus").fn;
  const blur = trigger._listeners.find((l) => l.type === "blur").fn;
  focus(); blur(); focus();   // focus again before resume fires
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(openCalls, 0, "openCamera should not be called after re-focus");
  off();
});

test("cameraPause: skips resume if document.activeElement is still the trigger", async () => {
  const env = loadFresh();
  const trigger = env.makeEl();
  let openCalls = 0;
  const openCamera = () => { openCalls++; return Promise.resolve(null); };
  const off = env.window.StudyBuddy.cameraPause({
    triggerEl: trigger,
    getStream: () => null,
    openCamera,
    resumeDelayMs: 5,
  });
  trigger._listeners.find((l) => l.type === "focus").fn();
  // Simulate "still focused" by setting activeElement.
  env.document.activeElement = trigger;
  trigger._listeners.find((l) => l.type === "blur").fn();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(openCalls, 0, "resume should be skipped when input is still focused");
  off();
});

test("cameraPause: off() removes listeners and clears pending timer", async () => {
  const env = loadFresh();
  const trigger = env.makeEl();
  let openCalls = 0;
  const openCamera = () => { openCalls++; return Promise.resolve(null); };
  const off = env.window.StudyBuddy.cameraPause({
    triggerEl: trigger,
    getStream: () => null,
    openCamera,
    resumeDelayMs: 5,
  });
  trigger._listeners.find((l) => l.type === "focus").fn();
  trigger._listeners.find((l) => l.type === "blur").fn();
  off();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(openCalls, 0, "off() should cancel the pending resume");
});

test("cameraPause: throws when triggerEl is missing", () => {
  const env = loadFresh();
  assert.throws(
    () => env.window.StudyBuddy.cameraPause({}),
    /triggerEl is required/,
  );
});
