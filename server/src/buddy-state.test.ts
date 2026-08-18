// server/src/buddy-state.test.ts
//
// 验证 web/buddy/state.js 的纯函数 nextState()。
//
// state.js 是浏览器端脚本，但 nextState 是无副作用的纯函数，
// 我们用 jsdom 模拟 window 让 vitest 能直接 require 它。
//
// 如果改 state.js 破坏状态机转移规则（比如允许 idle 直接 end），
// 这个测试会立刻 fail。

import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const STATE_JS_PATH = resolve(__dirname, "../../web/buddy/state.js");

beforeAll(() => {
  // 提供一个最小 window 让 state.js 能挂载到 window.Buddy
  const fakeWindow: any = {};
  (globalThis as any).window = fakeWindow;
  const code = readFileSync(STATE_JS_PATH, "utf8");
  const fn = new Function("window", `${code}; return window.Buddy;`);
  const buddy = fn(fakeWindow);
  if (!buddy) throw new Error("state.js did not set window.Buddy");
  (globalThis as any).Buddy = buddy;
});

// Lazy accessors — beforeAll() must inject Buddy before these run.
// Hoisted to module scope because they don't capture any outer
// variables (just read from globalThis). oxlint: consistent-function-scoping.
const nextState = () => (globalThis as any).Buddy.state.nextState;
const restoredState = () => (globalThis as any).Buddy.state.restoredState;
const shouldShowCamera = () => (globalThis as any).Buddy.state.shouldShowCamera;
const buddyState = () => (globalThis as any).Buddy.state;

describe("buddy state machine (nextState)", () => {
  it("idle + start → writing", () => {
    expect(nextState()("idle", "start")).toBe("writing");
  });

  it("writing + start → writing (idempotent restart)", () => {
    expect(nextState()("writing", "start")).toBe("writing");
  });

  it("done + start → writing (重新开始)", () => {
    expect(nextState()("done", "start")).toBe("writing");
  });

  it("writing + end → done", () => {
    expect(nextState()("writing", "end")).toBe("done");
  });

  it("idle + end → idle (没有 writing 不能 end)", () => {
    expect(nextState()("idle", "end")).toBe("idle");
  });

  it("done + end → done (already done, no-op)", () => {
    expect(nextState()("done", "end")).toBe("done");
  });

  it("done + restart → writing", () => {
    expect(nextState()("done", "restart")).toBe("writing");
  });

  it("idle + restart → idle (nothing to restart)", () => {
    expect(nextState()("idle", "restart")).toBe("idle");
  });

  it("writing + restart → writing (already writing, no-op)", () => {
    expect(nextState()("writing", "restart")).toBe("writing");
  });

  it("unknown event → no transition", () => {
    expect(nextState()("writing", "bogus")).toBe("writing");
  });
});

describe("buddy session refresh state", () => {
  it("restores a homework session as writing", () => {
    expect(restoredState()("作业")).toBe("writing");
  });

  it("restores a conversation session as done/free-chat", () => {
    expect(restoredState()("聊天")).toBe("done");
  });

  it("keeps the camera hidden for a restored conversation", () => {
    expect(shouldShowCamera()("done")).toBe(false);
    expect(shouldShowCamera()("writing")).toBe(true);
  });
});

describe("buddy state object initial values", () => {
  it("starts in 'idle' state", () => {
    expect(buddyState().state).toBe("idle");
  });

  it("starts with videoMode = 'on'", () => {
    expect(buddyState().videoMode).toBe("on");
  });

  it("starts with currentFacing = 'environment' (后置，孩子用)", () => {
    expect(buddyState().currentFacing).toBe("environment");
    expect(buddyState().currentFacingMode).toBe("environment");
  });

  it("starts with no sessionId", () => {
    expect(buddyState().sessionId).toBeNull();
  });

  it("starts with synthUnlocked = false (iOS Safari TTS 未解锁)", () => {
    expect(buddyState().synthUnlocked).toBe(false);
  });
});
