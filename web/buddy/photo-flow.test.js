import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "photo-flow.js"), "utf8");
const itemsSource = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "photo-items.js"), "utf8");

function setup(overrides = {}) {
  const events = [];
  const calls = { upload: 0, confirm: 0, cancel: 0, revoke: 0, saved: [], cleared: 0 };
  const window = {};
  vm.runInNewContext(itemsSource, vm.createContext({ window }));
  vm.runInNewContext(source, vm.createContext({ window }));
  const deps = {
    extractItems: window.BuddyPhotoItems.extractItems,
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
    confirmDraft: async (_sessionId, _draftId, itemIndex) => {
      calls.confirm += 1;
      return { state: "confirmed", itemIndex };
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

  const accepted = env.flow.confirmItem("session-1", 0);
  const duplicate = await env.flow.confirmItem("session-1", 0);
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

test("analyze result with confidence 'ok' lands the review state as confidence 'ok'", async () => {
  const { flow } = setup({
    upload: async () => ({
      draftId: "draft_frontend_1", problemText: "1 + 1 = ?", expiresAt: 10, confidence: "ok",
    }),
  });
  flow.preview({}, "blob:preview");
  assert.equal(await flow.analyze("session-1"), true);
  assert.equal(flow.state.phase, "review");
  assert.equal(flow.state.confidence, "ok");
  assert.equal(flow.state.problemText, "1 + 1 = ?");
});

test("analyze result with confidence 'low' (无法识别) lands the review state as confidence 'low'", async () => {
  const { flow } = setup({
    upload: async () => ({
      draftId: "draft_frontend_1", problemText: "无法识别", expiresAt: 10, confidence: "low",
    }),
  });
  flow.preview({}, "blob:preview");
  assert.equal(await flow.analyze("session-1"), true);
  assert.equal(flow.state.phase, "review");
  assert.equal(flow.state.confidence, "low");
  assert.equal(flow.state.problemText, "无法识别");
});

test("analyze result without confidence field defaults to 'ok' (backward compat)", async () => {
  const { flow } = setup({
    upload: async () => ({
      draftId: "draft_frontend_1", problemText: "1 + 1 = ?", expiresAt: 10,
      // no `confidence` field
    }),
  });
  flow.preview({}, "blob:preview");
  assert.equal(await flow.analyze("session-1"), true);
  assert.equal(flow.state.confidence, "ok");
});

// --- Multi-item review state (拍错题 v2: one card per wrong spot) ---

test("analyze stores every split item on the review state", async () => {
  const { flow } = setup({
    upload: async () => ({
      draftId: "draft_frontend_1",
      problemText: "8+5=?",
      expiresAt: 10,
      items: [
        { problem: "8+5=?", userAnswer: "12", correctAnswer: "13", subject: "math", errorType: "进位错误", reasoning: "个位满十未进位" },
        { problem: "9+7=?", userAnswer: "15", correctAnswer: "16", subject: "math", errorType: "", reasoning: "" },
      ],
    }),
  });
  flow.preview({}, "blob:preview");
  assert.equal(await flow.analyze("session-1"), true);
  assert.equal(flow.state.items.length, 2);
  assert.equal(flow.state.items[0].problem, "8+5=?");
  assert.equal(flow.state.items[1].correctAnswer, "16");
});

test("analyze without an items array falls back to one item from problemText (legacy draft)", async () => {
  const { flow } = setup();
  flow.preview({}, "blob:preview");
  assert.equal(await flow.analyze("session-1"), true);
  assert.equal(flow.state.items.length, 1);
  assert.equal(flow.state.items[0].problem, "2 + 2");
});

test("restore stores the draft's items so a refresh re-renders every card", async () => {
  const { flow } = setup({
    restoreDraft: async () => ({
      state: "review",
      draftId: "draft_frontend_1",
      problemText: "8+5=?",
      expiresAt: 10,
      items: [
        { problem: "8+5=?", subject: "math" },
        { problem: "9+7=?", subject: "math" },
      ],
    }),
  });
  assert.equal(await flow.restore("session-1", "draft_frontend_1"), true);
  assert.equal(flow.state.items.length, 2);
  assert.equal(flow.state.items[1].problem, "9+7=?");
});

// --- confirmItem: per-item confirm keeps the draft open until all done ---

function setupTwoItems(overrides = {}) {
  const confirmCalls = [];
  const env = setup({
    upload: async () => ({
      draftId: "draft_frontend_1",
      problemText: "8+5=?",
      expiresAt: 10,
      items: [
        { problem: "8+5=?", userAnswer: "12", correctAnswer: "13", subject: "math" },
        { problem: "9+7=?", userAnswer: "15", correctAnswer: "16", subject: "math" },
      ],
    }),
    confirmDraft: async (sessionId, draftId, itemIndex) => {
      confirmCalls.push({ sessionId, draftId, itemIndex });
      return { state: "confirmed", itemIndex };
    },
    ...overrides,
  });
  return { ...env, confirmCalls };
}

test("confirmItem posts the right itemIndex and greys only that card; the draft stays open", async () => {
  const env = setupTwoItems();
  env.flow.preview({}, "blob:preview");
  await env.flow.analyze("session-1");

  assert.equal(await env.flow.confirmItem("session-1", 1), true);
  assert.deepEqual(env.confirmCalls, [{ sessionId: "session-1", draftId: "draft_frontend_1", itemIndex: 1 }]);
  assert.equal(env.flow.state.phase, "review", "one item still open — draft must stay in review");
  assert.equal(env.flow.state.items[1].confirmed, true);
  assert.equal(env.flow.state.items[0].confirmed, undefined);
  assert.equal(env.calls.cleared, 0, "sessionStorage draft stays until every item is recorded");
});

test("confirming the last open item closes the draft and clears the saved draft", async () => {
  const env = setupTwoItems();
  env.flow.preview({}, "blob:preview");
  await env.flow.analyze("session-1");
  await env.flow.confirmItem("session-1", 0);
  assert.equal(await env.flow.confirmItem("session-1", 1), true);
  assert.equal(env.flow.state.phase, "confirmed");
  assert.equal(env.calls.cleared, 1);
  assert.equal(env.calls.revoke, 1, "preview object URL released");
});

test("confirmItem failure keeps the card open and stores the error copy on that item", async () => {
  const env = setupTwoItems({
    confirmDraft: async () => { throw new Error("boom"); },
  });
  env.flow.preview({}, "blob:preview");
  await env.flow.analyze("session-1");
  assert.equal(await env.flow.confirmItem("session-1", 0), false);
  assert.equal(env.flow.state.phase, "review");
  assert.equal(env.flow.state.items[0].confirmed, undefined);
  assert.equal(env.flow.state.items[0].error, "分析失败，请重试");
  assert.equal(env.flow.state.items[1].error, undefined, "the other card is untouched");
});

test("confirmItem on an already-confirmed item is a no-op (防重复点)", async () => {
  const env = setupTwoItems();
  env.flow.preview({}, "blob:preview");
  await env.flow.analyze("session-1");
  await env.flow.confirmItem("session-1", 0);
  assert.equal(await env.flow.confirmItem("session-1", 0), false);
  assert.equal(env.confirmCalls.length, 1);
});

test("confirmItem outside the review phase is rejected", async () => {
  const env = setupTwoItems();
  assert.equal(await env.flow.confirmItem("session-1", 0), false);
  assert.equal(env.confirmCalls.length, 0);
});

// --- reviseItem: 家长输入"要求"，LLM 改写这一条（issue #220） ---

function setupOneItemToRevise(overrides = {}) {
  const reviseCalls = [];
  const env = setup({
    upload: async () => ({
      draftId: "draft_frontend_1",
      problemText: "8+5=?",
      expiresAt: 10,
      items: [{ problem: "8+5=?", userAnswer: "12", correctAnswer: "13", subject: "math", reasoning: "" }],
    }),
    reviseDraft: async (sessionId, draftId, index, instruction) => {
      reviseCalls.push({ sessionId, draftId, index, instruction });
      return { index, item: { problem: "8+5=?", userAnswer: "12", correctAnswer: "13", subject: "chinese", reasoning: "改好了" } };
    },
    ...overrides,
  });
  return { ...env, reviseCalls };
}

test("reviseItem posts the instruction and swaps in the revised item fields", async () => {
  const env = setupOneItemToRevise();
  env.flow.preview({}, "blob:preview");
  await env.flow.analyze("session-1");
  assert.equal(await env.flow.reviseItem("session-1", 0, "学科改成语文"), true);
  assert.deepEqual(env.reviseCalls, [
    { sessionId: "session-1", draftId: "draft_frontend_1", index: 0, instruction: "学科改成语文" },
  ]);
  assert.equal(env.flow.state.items[0].subject, "chinese");
  assert.equal(env.flow.state.items[0].reasoning, "改好了");
  assert.equal(env.flow.state.phase, "review");
});

test("reviseItem failure keeps the old fields and shows the error copy on that card", async () => {
  const env = setupOneItemToRevise({
    reviseDraft: async () => { throw new Error("502"); },
  });
  env.flow.preview({}, "blob:preview");
  await env.flow.analyze("session-1");
  assert.equal(await env.flow.reviseItem("session-1", 0, "改"), false);
  assert.equal(env.flow.state.items[0].subject, "math", "fields unchanged after a failed revise");
  assert.equal(env.flow.state.items[0].error, "分析失败，请重试");
});

test("reviseItem on a confirmed item is a no-op", async () => {
  const env = setupOneItemToRevise();
  env.flow.preview({}, "blob:preview");
  await env.flow.analyze("session-1");
  await env.flow.confirmItem("session-1", 0);
  assert.equal(env.flow.state.phase, "confirmed");
  assert.equal(await env.flow.reviseItem("session-1", 0, "改"), false);
  assert.equal(env.reviseCalls.length, 0);
});
