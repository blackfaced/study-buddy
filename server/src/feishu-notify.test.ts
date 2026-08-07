// src/feishu-notify.test.ts
//
// Tests for the Feishu webhook notification worker. Mirrors the
// DingTalk worker (webhook-notify.ts) but with Feishu wire format
// (msg_type vs msgtype) and required HMAC-SHA256 sign.

import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  renderEntry,
  renderDigest,
  shouldNotify,
  sendToFeishu,
  signFeishu,
  drainOutboxToFeishu,
  type WebhookState,
} from "./feishu-notify.js";

// ---------------------------------------------------------------------------
// 1. renderEntry
// ---------------------------------------------------------------------------

describe("renderEntry (Feishu)", () => {
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
    expect(text).toBe("[16:51] 小宝 / parent_notify / 不想写作业");
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
});

// ---------------------------------------------------------------------------
// 2. renderDigest
// ---------------------------------------------------------------------------

describe("renderDigest (Feishu)", () => {
  it("aggregates N entries of the same kind", () => {
    const text = renderDigest(
      { id: "e5", ts: Date.now(), kind: "parent_notify", entityId: "child:default",
        payload: { childName: "小宝", reasons: [{ reason: "emotion", summary: "刚说：快点结束" }] } },
      { count: 5, lastSummary: "快点结束" },
    );
    expect(text).toBe("x5, last: 快点结束");
  });
});

// ---------------------------------------------------------------------------
// 3. shouldNotify (60s silence window)
// ---------------------------------------------------------------------------

describe("shouldNotify (Feishu 60s window)", () => {
  const baseEntry = {
    id: "e6", ts: Date.now(), kind: "parent_notify" as const,
    entityId: "child:default",
    payload: { childName: "小宝", reasons: [{ reason: "emotion", summary: "anxious - 不想写作业" }] },
  };
  const emptyState: WebhookState = { windows: {} };

  it("first event: notify=true with renderSingle", () => {
    const r = shouldNotify(baseEntry, emptyState, Date.now());
    expect(r.notify).toBe(true);
    expect(r.message).toContain("不想写作业");
  });

  it("second event within 60s: notify=false, count++", () => {
    const t0 = 1_000_000;
    const r1 = shouldNotify(baseEntry, emptyState, t0);
    const r2 = shouldNotify(baseEntry, r1.nextState, t0 + 30_000);
    expect(r2.notify).toBe(false);
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
    expect(r3.nextState.windows[key].count).toBe(1);
  });

  it("different kinds are NOT merged", () => {
    const t0 = 1_000_000;
    const e1 = { ...baseEntry, kind: "parent_notify" as const };
    const e2 = { ...baseEntry, kind: "math_mistake" as const, id: "e7" };
    const r1 = shouldNotify(e1, emptyState, t0);
    const r2 = shouldNotify(e2, r1.nextState, t0 + 5_000);
    expect(r1.notify).toBe(true);
    expect(r2.notify).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 4. signFeishu (HMAC-SHA256)
// ---------------------------------------------------------------------------

describe("signFeishu", () => {
  it("produces base64-encoded HMAC-SHA256 of 'timestamp\\nsecret'", () => {
    // Reference vector: timestamp "1234567890123", secret "test_secret"
    //   node -e "console.log(require('crypto').createHmac('sha256','test_secret').update('1234567890123\n').digest('base64'))"
    //   → "9OzMd7wSwI2xQOF5xfNmI+paUkZboIeKG9vuACmSXDc="
    const sig = signFeishu("1234567890123", "test_secret");
    expect(sig).toBe("9OzMd7wSwI2xQOF5xfNmI+paUkZboIeKG9vuACmSXDc=");
  });

  it("different secrets produce different signatures", () => {
    const a = signFeishu("1234567890123", "secret_a");
    const b = signFeishu("1234567890123", "secret_b");
    expect(a).not.toBe(b);
  });

  it("different timestamps produce different signatures", () => {
    const a = signFeishu("1234567890123", "secret");
    const b = signFeishu("9999999999999", "secret");
    expect(a).not.toBe(b);
  });
});

// ---------------------------------------------------------------------------
// 5. sendToFeishu — wire format + failure handling
// ---------------------------------------------------------------------------

describe("sendToFeishu", () => {
  it("skips silently when webhook URL is empty (no-op mode)", async () => {
    const r = await sendToFeishu({
      url: "",
      secret: "s",
      text: "hello",
      fetchFn: (() => { throw new Error("should not be called"); }) as typeof fetch,
    });
    expect(r.ok).toBe(true);
    expect(r.skipped).toBe(true);
  });

  it("POSTs {msg_type:'text',content:{text}} with sign in URL", async () => {
    const calls: { url: string; body: string; headers: Record<string, string> }[] = [];
    const fakeFetch: typeof fetch = (async (input: any, init?: any) => {
      calls.push({
        url: String(input),
        body: String(init?.body ?? ""),
        headers: (init?.headers ?? {}) as Record<string, string>,
      });
      return new Response(JSON.stringify({ StatusCode: 0, msg: "success" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    const r = await sendToFeishu({
      url: "https://open.feishu.cn/open-apis/bot/v2/hook/T-original-token",
      secret: "test_secret",
      text: "[16:51] 小宝 / parent_notify / 不想写作业",
      fetchFn: fakeFetch,
    });
    expect(r.ok).toBe(true);
    expect(calls).toHaveLength(1);
    // URL should have the original token AND timestamp + sign params
    expect(calls[0].url).toMatch(/^https:\/\/open\.feishu\.cn\/open-apis\/bot\/v2\/hook\/T-original-token/);
    expect(calls[0].url).toContain("timestamp=");
    expect(calls[0].url).toContain("sign=");
    // Body
    const parsed = JSON.parse(calls[0].body);
    expect(parsed.msg_type).toBe("text");
    expect(parsed.content.text).toBe("[16:51] 小宝 / parent_notify / 不想写作业");
  });

  it("returns ok=false on Feishu StatusCode != 0", async () => {
    const fakeFetch: typeof fetch = (async () =>
      new Response(JSON.stringify({ StatusCode: 230002, msg: "sign match fail" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof fetch;
    const r = await sendToFeishu({
      url: "https://open.feishu.cn/open-apis/bot/v2/hook/x",
      secret: "wrong",
      text: "x",
      fetchFn: fakeFetch,
    });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("230002");
  });

  it("returns ok=false on HTTP 4xx/5xx", async () => {
    const fakeFetch: typeof fetch = (async () =>
      new Response("forbidden", { status: 403 })) as typeof fetch;
    const r = await sendToFeishu({
      url: "https://open.feishu.cn/open-apis/bot/v2/hook/x",
      secret: "s",
      text: "x",
      fetchFn: fakeFetch,
    });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("403");
  });

  it("returns ok=false on fetch rejection", async () => {
    const fakeFetch: typeof fetch = (async () => {
      throw new Error("ECONNREFUSED");
    }) as typeof fetch;
    const r = await sendToFeishu({
      url: "https://open.feishu.cn/open-apis/bot/v2/hook/x",
      secret: "s",
      text: "x",
      fetchFn: fakeFetch,
    });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("ECONNREFUSED");
  });
});

// ---------------------------------------------------------------------------
// 6. drainOutboxToFeishu — integration
// ---------------------------------------------------------------------------

describe("drainOutboxToFeishu", () => {
  it("drains, signs, sends, marks successful; failures stay pending", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "feishu-notify-"));
    try {
      const outbox = join(tmp, "outbox.jsonl");
      const processed = join(tmp, "processed.jsonl");
      const statePath = join(tmp, "state.json");

      const e_ok = {
        id: "e_ok", ts: 1_700_000_000_000, kind: "parent_notify",
        entityId: "child:default",
        payload: { childName: "小宝", reasons: [{ reason: "emotion", summary: "happy - ok" }] },
      };
      const e_fail = {
        id: "e_fail", ts: 1_700_000_000_000, kind: "parent_notify",
        entityId: "child:default",
        payload: { childName: "小宝", reasons: [{ reason: "emotion", summary: "anxious - fail" }] },
      };
      const { appendFile } = await import("node:fs/promises");
      await appendFile(outbox, JSON.stringify(e_ok) + "\n" + JSON.stringify(e_fail) + "\n", "utf8");

      const fakeFetch: typeof fetch = (async (input: any, init?: any) => {
        const body = JSON.parse(String(init?.body ?? "{}"));
        if (body.content?.text?.includes("happy")) {
          return new Response(JSON.stringify({ StatusCode: 0 }), { status: 200 });
        }
        throw new Error("ECONNREFUSED");
      }) as typeof fetch;

      const r = await drainOutboxToFeishu({
        outboxPath: outbox,
        processedPath: processed,
        statePath,
        webhookUrl: "https://open.feishu.cn/open-apis/bot/v2/hook/T",
        webhookSecret: "test_secret",
        fetchFn: fakeFetch,
        now: () => 1_700_000_000_000,
      });
      expect(r.processed).toBe(1);
      expect(r.failed).toBe(1);
      expect(r.remaining).toBe(1);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("does nothing when outbox is empty", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "feishu-notify-"));
    try {
      const outbox = join(tmp, "outbox.jsonl");
      const processed = join(tmp, "processed.jsonl");
      const statePath = join(tmp, "state.json");

      let fetchCalled = false;
      const fakeFetch: typeof fetch = (async () => {
        fetchCalled = true;
        return new Response("{}", { status: 200 });
      }) as typeof fetch;

      const r = await drainOutboxToFeishu({
        outboxPath: outbox,
        processedPath: processed,
        statePath,
        webhookUrl: "https://open.feishu.cn/open-apis/bot/v2/hook/T",
        webhookSecret: "s",
        fetchFn: fakeFetch,
        now: () => 1_700_000_000_000,
      });
      expect(r.processed).toBe(0);
      expect(fetchCalled).toBe(false);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("skips entire drain when webhookUrl is empty (no-op mode)", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "feishu-notify-"));
    try {
      const outbox = join(tmp, "outbox.jsonl");
      const processed = join(tmp, "processed.jsonl");
      const statePath = join(tmp, "state.json");
      const { appendFile } = await import("node:fs/promises");
      await appendFile(outbox,
        JSON.stringify({ id: "e1", ts: 1, kind: "parent_notify", entityId: "child:default",
          payload: { childName: "小宝", reasons: [{ reason: "x", summary: "y" }] } }) + "\n",
        "utf8");
      const r = await drainOutboxToFeishu({
        outboxPath: outbox,
        processedPath: processed,
        statePath,
        webhookUrl: "",  // no-op
        webhookSecret: "s",
        fetchFn: (async () => new Response("{}", { status: 200 })) as typeof fetch,
        now: () => 1,
      });
      expect(r.processed).toBe(0);
      const { readFile } = await import("node:fs/promises");
      const still = (await readFile(outbox, "utf8")).trim();
      expect(still.length).toBeGreaterThan(0);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
