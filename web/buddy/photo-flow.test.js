import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "photo-flow.js"), "utf8");

function setup(overrides = {}) {
  const events = [];
  const calls = { upload: 0, confirm: 0, cancel: 0, revoke: 0, saved: [], cleared: 0 };
  const window = {};
  vm.runInNewContext(source, vm.createContext({ window }));
  const deps = {
    onState: (state) => events.push(state),
    revokePreview: () => { calls.revoke += 1; },
    newDraftId: () => "draft_frontend_1",
    saveDraft: (sessionId, draftId) => calls.saved.push({ sessionId, draftId }),
    clearDraft: () => { calls.cleared += 1; },
    makeAbortController: () => new AbortController(),
    errorMessage: () => "分析失败，请重试",
    upload: async () => {
      calls.upload += 1;
      return { draftId: "draft_frontend_1", problemText: "2 + 2", expiresAt: 10 };
    },
    confirmDraft: async (_sessionId, _draftId, problemText) => {
      calls.confirm += 1;
      return { state: "confirmed", problemText };
    },
    cancelDraft: async () => { calls.cancel += 1; },
    restoreDraft: async () => ({
      state: "review",
      draftId: "draft_frontend_1",
      problemText: "2 + 2",
      expiresAt: 10,
    }),
    ...overrides,
  };
  return { flow: window.BuddyPhotoFlow.createPhotoFlow(deps), calls, events };
}

test("captured photo stays local until Analyze is chosen", async () => {
  const { flow, calls } = setup();
  flow.preview({ bytes: "local-only" }, "blob:preview");
  assert.equal(flow.state.phase, "preview");
  assert.equal(calls.upload, 0);
  await flow.analyze("session-1");
  assert.equal(calls.upload, 1);
  assert.equal(flow.state.phase, "review");
});

test("retake removes the browser preview without contacting the server", async () => {
  const { flow, calls } = setup();
  flow.preview({}, "blob:preview");
  assert.equal(await flow.retake("session-1"), true);
  assert.equal(calls.revoke, 1);
  assert.equal(calls.cancel, 0);
  assert.equal(flow.state.phase, "idle");
});

test("cancel after analysis deletes the server draft and local preview", async () => {
  const { flow, calls } = setup();
  flow.preview({}, "blob:preview");
  await flow.analyze("session-1");
  await flow.cancel("session-1");
  assert.equal(calls.cancel, 1);
  assert.equal(calls.revoke, 1);
  assert.equal(flow.state.phase, "idle");
});

test("double taps do not duplicate analyze or confirm calls", async () => {
  let finishUpload;
  const uploadPromise = new Promise((resolve) => { finishUpload = resolve; });
  const env = setup({ upload: async () => {
    env.calls.upload += 1;
    return uploadPromise;
  } });
  env.flow.preview({}, "blob:preview");
  const first = env.flow.analyze("session-1");
  const second = await env.flow.analyze("session-1");
  assert.equal(second, false);
  finishUpload({ draftId: "draft_frontend_1", problemText: "2 + 2", expiresAt: 10 });
  await first;
  assert.equal(env.calls.upload, 1);

  const accepted = env.flow.confirm("session-1", "2 + 2");
  const duplicate = await env.flow.confirm("session-1", "2 + 2");
  assert.equal(duplicate, false);
  await accepted;
  assert.equal(env.calls.confirm, 1);
});

test("cancel during analysis aborts upload and deletes the server draft", async () => {
  const env = setup({
    upload: async (_sessionId, _draftId, _blob, signal) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
    }),
  });
  env.flow.preview({}, "blob:preview");
  const analyzing = env.flow.analyze("session-1");
  assert.equal(env.flow.state.phase, "analyzing");
  assert.equal(await env.flow.cancel("session-1"), true);
  await analyzing;
  assert.equal(env.calls.cancel, 1);
  assert.equal(env.calls.revoke, 1);
  assert.equal(env.flow.state.phase, "idle");
});

test("retake during analysis cancels the server draft before returning to idle", async () => {
  const env = setup({
    upload: async (_sessionId, _draftId, _blob, signal) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
    }),
  });
  env.flow.preview({}, "blob:preview");
  const analyzing = env.flow.analyze("session-1");
  assert.equal(await env.flow.retake("session-1"), true);
  await analyzing;
  assert.equal(env.calls.cancel, 1);
  assert.equal(env.flow.state.phase, "idle");
});

test("refresh restores an analyzed draft for editing", async () => {
  const { flow } = setup();
  assert.equal(await flow.restore("session-1", "draft_frontend_1"), true);
  assert.equal(flow.state.phase, "review");
  assert.equal(flow.state.problemText, "2 + 2");
});

test("an upload retry after confirmation returns the durable receipt without reopening review", async () => {
  const { flow, calls } = setup({
    upload: async () => ({ state: "confirmed", mistakeId: 7, problemText: "2 + 2" }),
  });
  flow.preview({}, "blob:preview");
  assert.equal(await flow.analyze("session-1"), true);
  assert.equal(flow.state.phase, "confirmed");
  assert.equal(calls.revoke, 1);
});

test("provider failure returns to preview and keeps the image retakeable", async () => {
  const { flow, calls } = setup({ upload: async () => { throw new Error("provider"); } });
  flow.preview({}, "blob:preview");
  assert.equal(await flow.analyze("session-1"), false);
  assert.equal(flow.state.phase, "preview");
  assert.equal(flow.state.error, "分析失败，请重试");
  assert.equal(calls.revoke, 0);
});
