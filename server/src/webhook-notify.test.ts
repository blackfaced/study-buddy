// src/webhook-notify.test.ts
//
// Tests for the DingTalk webhook notification worker. The worker drains
// the shared outbox (server/data/nexus-outbox.jsonl) and POSTs each
// event to a DingTalk group-bot webhook as a short text message. A
// 60-second silence window dedupes bursts (e.g. 20 parent_notify from
// one buddy conversation).
//
// Test layers (bottom-up):
//   1. renderEntry / renderDigest     — pure text formatting
//   2. shouldNotify                    — silence window + state mutation
//   3. sendToDingTalk                  — wire format + failure handling
//   4. drainOutboxToWebhook            — integration: read → send → mark

import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  renderEntry,
  renderDigest,
  shouldNotify,
  sendToDingTalk,
  drainOutboxToWebhook,
  type WebhookState,
  type SendResult,
} from "./webhook-notify.js";

// ---------------------------------------------------------------------------
// 1. renderEntry
// ---------------------------------------------------------------------------

describe("renderEntry", () => {
  it("renders parent_notify as [HH:MM] childName / kind / first-reason-summary", () => {
    const text = renderEntry({
      id: "e1",
      ts: new Date("2026-08-03T08:51:38Z").getTime(),
      kind: "parent_notify",
      entityId: "child:default",
      payload: {
        childName: "小宝",
        reasons: [{ reason: "emotion", summary: '小宝 情绪是"anxious"，刚说："不想写作业"' }],
      },
    });
    // 08:51:38 UTC = 16:51:38 CST
    expect(text).toBe('[16:51] 小宝 / parent_notify / 不想写作业');
  });

  it("renders math_mistake as [HH:MM] childName / kind / problem=userAnswer", () => {
    const text = renderEntry({
      id: "e2",
      ts: new Date("2026-08-03T08:51:38Z").getTime(),
      kind: "math_mistake",
      entityId: "child:default",
      payload: {
        childName: "小宝",
        subject: "math",
        problem: "3 个 8，一共多少？",
        userAnswer: "34",
        correctAnswer: "24",
      },
    });
    expect(text).toBe("[16:51] 小宝 / math_mistake / 3×8=34 (24)");
  });

  it("renders game-session as [HH:MM] childName / kind / app Q correct", () => {
    const text = renderEntry({
      id: "e3",
      ts: new Date("2026-08-03T08:50:37Z").getTime(),
      kind: "game-session",
      entityId: "child:default",
      payload: {
        childName: "小宝",
        appId: "candy-math-island",
        totalQuestions: 9,
        correctCount: 7,
      },
    });
    expect(text).toBe("[16:50] 小宝 / game-session / candy 7/9");
  });

  it("falls back to entityId when childName missing", () => {
    const text = renderEntry({
      id: "e4",
      ts: 0, // epoch → CST 08:00
      kind: "parent_notify",
      entityId: "child:default",
      payload: { reasons: [{ reason: "x", summary: "test" }] },
    });
    expect(text).toContain("child:default");
    expect(text).toContain("test");
  });
});

// ---------------------------------------------------------------------------
// 2. renderDigest (60s window expiration summary)
// ---------------------------------------------------------------------------

describe("renderDigest", () => {
  it("aggregates N entries of the same kind: xN, last: <summary>", () => {
    const text = renderDigest(
      {
        id: "e5",
        ts: Date.now(),
        kind: "parent_notify",
        entityId: "child:default",
        payload: { childName: "小宝", reasons: [{ reason: "emotion", summary: "刚说：不想写作业" }] },
      },
      // lastSummary is what shouldNotify already extracted via extractParentNotifyCore.
      { count: 5, lastSummary: "快点结束" },
    );
    expect(text).toBe("x5, last: 快点结束");
  });
});

// ---------------------------------------------------------------------------
// 3. shouldNotify — silence window + state mutation
// ---------------------------------------------------------------------------

describe("shouldNotify (60s silence window)", () => {
  const baseEntry = {
    id: "e6",
    ts: Date.now(),
    kind: "parent_notify" as const,
    entityId: "child:default",
    payload: { childName: "小宝", reasons: [{ reason: "emotion", summary: "anxious - 不想写作业" }] },
  };
  const emptyState: WebhookState = { windows: {} };

  it("first event: notify=true with renderSingle, state written", () => {
    const r = shouldNotify(baseEntry, emptyState, Date.now());
    expect(r.notify).toBe(true);
    expect(r.message).toBeDefined();
    expect(r.message).toContain("不想写作业");
    expect(r.nextState.windows).toBeDefined();
  });

  it("second event within 60s same kind+entity+summary: notify=false, count++", () => {
    const t0 = 1_000_000;
    const r1 = shouldNotify(baseEntry, emptyState, t0);
    const r2 = shouldNotify(baseEntry, r1.nextState, t0 + 30_000);
    expect(r1.notify).toBe(true);
    expect(r2.notify).toBe(false);
    // count should be 2
    const key = Object.keys(r2.nextState.windows)[0];
    expect(r2.nextState.windows[key].count).toBe(2);
  });

  it("third event after 60s: notify=true with renderDigest, state reset", () => {
    const t0 = 1_000_000;
    const r1 = shouldNotify(baseEntry, emptyState, t0);
    const r2 = shouldNotify(baseEntry, r1.nextState, t0 + 30_000);
    const r3 = shouldNotify(baseEntry, r2.nextState, t0 + 90_000);
    expect(r3.notify).toBe(true);
    expect(r3.message).toMatch(/^x\d+, last:/);
    const key = Object.keys(r3.nextState.windows)[0];
    expect(r3.nextState.windows[key].count).toBe(1); // reset
  });

  it("different kinds (parent_notify vs math_mistake) are NOT merged", () => {
    const t0 = 1_000_000;
    const e1 = { ...baseEntry, kind: "parent_notify" as const };
    const e2 = { ...baseEntry, kind: "math_mistake" as const, id: "e7" };
    const r1 = shouldNotify(e1, emptyState, t0);
    const r2 = shouldNotify(e2, r1.nextState, t0 + 5_000);
    expect(r1.notify).toBe(true);
    expect(r2.notify).toBe(true);
  });

  it("different childId are NOT merged", () => {
    const t0 = 1_000_000;
    const e1 = { ...baseEntry, entityId: "child:a" };
    const e2 = { ...baseEntry, entityId: "child:b", id: "e8" };
    const r1 = shouldNotify(e1, emptyState, t0);
    const r2 = shouldNotify(e2, r1.nextState, t0 + 5_000);
    expect(r1.notify).toBe(true);
    expect(r2.notify).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 4. sendToDingTalk — wire format + failure handling
// ---------------------------------------------------------------------------

describe("sendToDingTalk", () => {
  it("skips silently when webhook URL is empty (no-op mode)", async () => {
    const r = await sendToDingTalk({
      url: "",
      text: "hello",
      fetchFn: (() => {
        throw new Error("should not be called");
      }) as typeof fetch,
    });
    expect(r.ok).toBe(true);
    expect(r.skipped).toBe(true);
  });

  it("POSTs {msgtype:'text',text:{content}} JSON to the webhook URL", async () => {
    const calls: { url: string; body: string; headers: Record<string, string> }[] = [];
    const fakeFetch: typeof fetch = (async (input: any, init?: any) => {
      calls.push({
        url: String(input),
        body: String(init?.body ?? ""),
        headers: (init?.headers ?? {}) as Record<string, string>,
      });
      return new Response(JSON.stringify({ errcode: 0, errmsg: "ok" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    const r = await sendToDingTalk({
      url: "https://oapi.dingtalk.com/robot/send?access_token=T",
      text: "[16:51] 小宝 / parent_notify / 不想写作业",
      fetchFn: fakeFetch,
    });
    expect(r.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://oapi.dingtalk.com/robot/send?access_token=T");
    expect(calls[0].headers["Content-Type"]).toBe("application/json");
    const parsed = JSON.parse(calls[0].body);
    expect(parsed.msgtype).toBe("text");
    expect(parsed.text.content).toBe("[16:51] 小宝 / parent_notify / 不想写作业");
  });

  it("returns ok=false on DingTalk errorCode != 0", async () => {
    const fakeFetch: typeof fetch = (async () =>
      new Response(JSON.stringify({ errcode: 310000, errmsg: "sign not match" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof fetch;
    const r = await sendToDingTalk({
      url: "https://oapi.dingtalk.com/robot/send?access_token=T",
      text: "x",
      fetchFn: fakeFetch,
    });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("310000");
  });

  it("returns ok=false on HTTP 4xx/5xx", async () => {
    const fakeFetch: typeof fetch = (async () =>
      new Response("forbidden", { status: 403 })) as typeof fetch;
    const r = await sendToDingTalk({
      url: "https://oapi.dingtalk.com/robot/send?access_token=T",
      text: "x",
      fetchFn: fakeFetch,
    });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("403");
  });

  it("returns ok=false on fetch rejection (network error)", async () => {
    const fakeFetch: typeof fetch = (async () => {
      throw new Error("ECONNREFUSED");
    }) as typeof fetch;
    const r = await sendToDingTalk({
      url: "https://oapi.dingtalk.com/robot/send?access_token=T",
      text: "x",
      fetchFn: fakeFetch,
    });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("ECONNREFUSED");
  });
});

// ---------------------------------------------------------------------------
// 5. drainOutboxToWebhook — integration: read → send → mark
// ---------------------------------------------------------------------------

describe("drainOutboxToWebhook", () => {
  it("drains, sends, marks successful entries as processed; failures stay pending", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "webhook-notify-"));
    try {
      const outbox = join(tmp, "outbox.jsonl");
      const processed = join(tmp, "processed.jsonl");
      const statePath = join(tmp, "state.json");

      // Two entries: e_ok (will succeed), e_fail (network error)
      const e_ok = {
        id: "e_ok",
        ts: 1_700_000_000_000,
        kind: "parent_notify",
        entityId: "child:default",
        payload: { childName: "小宝", reasons: [{ reason: "emotion", summary: "happy - ok" }] },
      };
      const e_fail = {
        id: "e_fail",
        ts: 1_700_000_000_000,
        kind: "parent_notify",
        entityId: "child:default",
        payload: { childName: "小宝", reasons: [{ reason: "emotion", summary: "anxious - fail" }] },
      };
      // Write directly to outbox (bypass appendOutbox for brevity)
      const { appendFile } = await import("node:fs/promises");
      await appendFile(outbox, JSON.stringify(e_ok) + "\n" + JSON.stringify(e_fail) + "\n", "utf8");

      // Fake fetch: succeed for "ok" summary, fail for "fail" summary
      const fakeFetch: typeof fetch = (async (input: any, init?: any) => {
        const body = JSON.parse(String(init?.body ?? "{}"));
        if (body.text?.content?.includes("happy")) {
          return new Response(JSON.stringify({ errcode: 0 }), { status: 200 });
        }
        throw new Error("ECONNREFUSED");
      }) as typeof fetch;

      const r = await drainOutboxToWebhook({
        outboxPath: outbox,
        processedPath: processed,
        statePath,
        webhookUrl: "https://oapi.dingtalk.com/robot/send?access_token=T",
        fetchFn: fakeFetch,
        // Use a far-apart second event time so dedupe window doesn't suppress
        now: () => 1_700_000_000_000,
      });

      expect(r.processed).toBe(1);
      expect(r.failed).toBe(1);
      expect(r.remaining).toBe(1);

      // Outbox should still contain e_fail
      const { readFile } = await import("node:fs/promises");
      const remaining = (await readFile(outbox, "utf8")).trim().split("\n").map((l) => JSON.parse(l));
      expect(remaining.map((e) => e.id)).toEqual(["e_fail"]);

      // processed file should contain e_ok
      const processedContent = (await readFile(processed, "utf8")).trim().split("\n").map((l) => JSON.parse(l));
      expect(processedContent.map((e) => e.id)).toEqual(["e_ok"]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("does nothing when outbox is empty", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "webhook-notify-"));
    try {
      const outbox = join(tmp, "outbox.jsonl"); // does not exist
      const processed = join(tmp, "processed.jsonl");
      const statePath = join(tmp, "state.json");

      let fetchCalled = false;
      const fakeFetch: typeof fetch = (async () => {
        fetchCalled = true;
        return new Response("{}", { status: 200 });
      }) as typeof fetch;

      const r = await drainOutboxToWebhook({
        outboxPath: outbox,
        processedPath: processed,
        statePath,
        webhookUrl: "https://oapi.dingtalk.com/robot/send?access_token=T",
        fetchFn: fakeFetch,
        now: () => 1_700_000_000_000,
      });
      expect(r.processed).toBe(0);
      expect(r.failed).toBe(0);
      expect(fetchCalled).toBe(false);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("skips entire drain when webhookUrl is empty (no-op mode)", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "webhook-notify-"));
    try {
      const outbox = join(tmp, "outbox.jsonl");
      const processed = join(tmp, "processed.jsonl");
      const statePath = join(tmp, "state.json");

      const { appendFile } = await import("node:fs/promises");
      await appendFile(
        outbox,
        JSON.stringify({
          id: "e1",
          ts: 1,
          kind: "parent_notify",
          entityId: "child:default",
          payload: { childName: "小宝", reasons: [{ reason: "x", summary: "y" }] },
        }) + "\n",
        "utf8",
      );

      const r = await drainOutboxToWebhook({
        outboxPath: outbox,
        processedPath: processed,
        statePath,
        webhookUrl: "", // no-op
        fetchFn: (async () => new Response("{}", { status: 200 })) as typeof fetch,
        now: () => 1,
      });
      // In no-op mode we neither send nor mark, so the entry stays in outbox
      expect(r.processed).toBe(0);
      const { readFile } = await import("node:fs/promises");
      const still = (await readFile(outbox, "utf8")).trim();
      expect(still.length).toBeGreaterThan(0);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
