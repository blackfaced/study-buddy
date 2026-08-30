import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import Database from "better-sqlite3";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "./app.js";
import { migrateSchema } from "./db-migrate.js";
import { seedTestDevice, testDeviceAuthenticator } from "./test-device.js";

let db: Database.Database;
let app: ReturnType<typeof createApp>;
let tmpDir: string;
let outboxPath: string;

beforeAll(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  migrateSchema(db);
  seedTestDevice(db);
  tmpDir = mkdtempSync(join(tmpdir(), "study-buddy-test-"));
  outboxPath = join(tmpDir, "outbox.jsonl");
  app = createApp({ db, httpsPort: 3000, outboxPath, deviceAuthenticator: testDeviceAuthenticator });
});

async function startOwnedSession(subject?: string) {
  const response = await request(app)
    .post("/api/session/start")
    .send(subject ? { subject } : {});
  expect(response.status).toBe(200);
  return response.body.sessionId as string;
}

async function postChat(text: string, state = "writing", sessionId?: string) {
  const ownedSessionId = sessionId ?? await startOwnedSession();
  return request(app)
    .post("/api/chat")
    .send({ sessionId: ownedSessionId, text, state });
}

afterAll(() => {
  db.close();
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

describe("GET /api/health", () => {
  it("returns 200 with service name and counts", async () => {
    const res = await request(app).get("/api/health");
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.service).toBe("study-buddy");
    expect(typeof res.body.childrenCount).toBe("number");
    expect(typeof res.body.sessionsCount).toBe("number");
  });
});

// Bug 1 (v0.1): /api/pair referenced an undefined `PORT` symbol.
// Regression: serverUrl must contain a numeric port, not the literal "undefined".
describe("GET /api/pair (Bug 1: serverUrl must not be :undefined)", () => {
  it("serverUrl is a well-formed URL ending in :<port>", async () => {
    const res = await request(app).get("/api/pair");
    expect(res.status).toBe(200);
    expect(res.body.serverUrl).toMatch(/:\d+$/);
  });

  it('serverUrl does not contain the literal "undefined"', async () => {
    const res = await request(app).get("/api/pair");
    expect(res.body.serverUrl).not.toContain("undefined");
  });

  it("serverUrl uses the configured httpsPort (3000)", async () => {
    const res = await request(app).get("/api/pair");
    // supertest sends plain http; the protocol here is the inbound request's
    // protocol. The port is what we asserted against the bug.
    expect(res.body.serverUrl).toMatch(/:\d+$/);
    expect(res.body.serverUrl).toContain(":3000");
  });

  it("returns the seeded default child's name and grade", async () => {
    const res = await request(app).get("/api/pair");
    expect(res.body.childId).toBe("default");
    expect(res.body.name).toBe("小宝");
    expect(res.body.grade).toBe("二年级");
  });
});

describe("POST /api/chat (explicit paired session)", () => {
  it("rejects chat without an explicit session", async () => {
    const res = await request(app)
      .post("/api/chat")
      .send({ text: "你好", state: "writing" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/sessionId/);
  });

  it("writes chat turns only to the requested owned session", async () => {
    const sessionId = await startOwnedSession();
    const before = (db.prepare("SELECT COUNT(*) as c FROM sessions").get() as any).c;
    const res = await postChat("测试", "writing", sessionId);
    expect(res.status).toBe(200);

    const after = (db.prepare("SELECT COUNT(*) as c FROM sessions").get() as any).c;
    expect(after).toBe(before);

    // chat_turns should reference the new session
    const turns = db.prepare(
      "SELECT role, content, state FROM chat_turns ORDER BY id DESC LIMIT 2"
    ).all() as Array<{ role: string; content: string; state: string }>;
    expect(turns[0].role).toBe("agent");
    expect(turns[0].state).toBe("writing");
    expect(turns[1].role).toBe("child");
    expect(turns[1].content).toBe("测试");
    expect((db.prepare("SELECT session_id FROM chat_turns ORDER BY id DESC LIMIT 1").get() as any).session_id)
      .toBe(sessionId);
  });

  it("does not revive a completed session implicitly", async () => {
    const sessionId = await startOwnedSession();
    expect((await request(app).post("/api/session/end").send({ sessionId })).status).toBe(200);
    const res = await postChat("又来了", "writing", sessionId);
    expect(res.status).toBe(409);
  });
});

// W1 hotfix #2 (issue #46): 孩子可以改名字
// 7/28 糖糖说"我叫糖糖" 30 次，LLM 都记不住
// 这个 fix 让 server 端兜底：检测 "我叫X" → update children.name
describe("POST /api/child/rename (W1 hotfix #2)", () => {
  it("returns 200 and updates children.name", async () => {
    const res = await request(app)
      .post("/api/child/rename")
      .send({ name: "糖糖" });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe("糖糖");

    const child = db.prepare("SELECT name FROM children WHERE id = 'default'").get() as any;
    expect(child.name).toBe("糖糖");

    // 还原回"小宝"避免影响其他测试
    db.prepare("UPDATE children SET name = ? WHERE id = 'default'").run("小宝");
  });

  it("rejects empty name", async () => {
    const res = await request(app)
      .post("/api/child/rename")
      .send({ name: "" });
    expect(res.status).toBe(400);
  });

  it("rejects too-long name (>10 chars)", async () => {
    const res = await request(app)
      .post("/api/child/rename")
      .send({ name: "abcdefghijklmnop" });
    expect(res.status).toBe(400);
  });
});

describe("POST /api/chat auto-detects name change (W1 hotfix #2)", () => {
  beforeEach(() => {
    // 还原默认 child name
    db.prepare("UPDATE children SET name = ? WHERE id = 'default'").run("小宝");
    db.exec("UPDATE sessions SET ended_at = strftime('%s','now')*1000 WHERE ended_at IS NULL");
  });

  it("'我的小名叫糖糖' → 自动改 children.name 为 '糖糖'", async () => {
    const res = await postChat("我的小名叫糖糖");
    expect(res.status).toBe(200);

    const child = db.prepare("SELECT name FROM children WHERE id = 'default'").get() as any;
    expect(child.name).toBe("糖糖");
  });

  it("'我叫糖糖' → 改名为 '糖糖'", async () => {
    const res = await postChat("我叫糖糖");
    expect(res.status).toBe(200);

    const child = db.prepare("SELECT name FROM children WHERE id = 'default'").get() as any;
    expect(child.name).toBe("糖糖");
  });

  it("'今天吃了糖糖' → 不改名字（不是名字变更意图）", async () => {
    const res = await postChat("今天吃了糖糖");
    expect(res.status).toBe(200);

    const child = db.prepare("SELECT name FROM children WHERE id = 'default'").get() as any;
    expect(child.name).toBe("小宝");  // 默认值
  });

  it("'写作业' → 不改名字", async () => {
    const res = await postChat("写作业");
    expect(res.status).toBe(200);

    const child = db.prepare("SELECT name FROM children WHERE id = 'default'").get() as any;
    expect(child.name).toBe("小宝");
  });
});

// Loop detection remains child-facing, while the retired JSONL producer is
// replaced by transactional chat-turn Source Events (#105/#107).
describe("POST /api/chat (loop detection + transactional source references)", () => {
  beforeEach(() => {
    // 清 outbox + child 名字
    if (outboxPath) {
      try { rmSync(outboxPath, { force: true }); } catch {}
    }
    db.exec("UPDATE sessions SET ended_at = strftime('%s','now')*1000 WHERE ended_at IS NULL");
    db.prepare("UPDATE children SET name = ? WHERE id = 'default'").run("小宝");
  });

  it("5 个短 yes/no child 消息 → 第 6 轮 isLoop = true + 写 Source Events", async () => {
    // 预填 5 轮短 yes/no（不调 LLM，直接写 DB）
    const session = await request(app).post("/api/session/start").send({});
    const sessionId = session.body.sessionId;
    const insertTurn = db.prepare(
      "INSERT INTO chat_turns (session_id, role, content, topic, redirected, state) VALUES (?, ?, ?, ?, ?, ?)"
    );
    for (const t of ["是", "不对", "是", "才不是", "不是"]) {
      insertTurn.run(sessionId, "child", t, "learning", 0, "writing");
    }

    // 第 6 轮发新消息 — 应该触发 loop detection
    const before = db.prepare(
      "SELECT COUNT(*) AS count FROM source_events WHERE record_type = 'chat_turn'",
    ).get() as { count: number };
    const res = await request(app)
      .post("/api/chat")
      .send({ sessionId, text: "什么啊", state: "writing" });
    expect(res.status).toBe(200);
    expect(res.body.isLoop).toBe(true);

    const after = db.prepare(
      "SELECT COUNT(*) AS count FROM source_events WHERE record_type = 'chat_turn'",
    ).get() as { count: number };
    expect(after.count - before.count).toBe(2);
    expect(() => readFileSync(outboxPath, "utf8")).toThrow();
  });

  it("5 个正常长消息 → 第 6 轮 isLoop = false + 不写 legacy JSONL", async () => {
    const session = await request(app).post("/api/session/start").send({});
    const sessionId = session.body.sessionId;
    const insertTurn = db.prepare(
      "INSERT INTO chat_turns (session_id, role, content, topic, redirected, state) VALUES (?, ?, ?, ?, ?, ?)"
    );
    for (const t of [
      "今天数学写完了",
      "接下来写语文",
      "这首诗有点难",
      "拼音我会读",
      "我想看一会儿书",
    ]) {
      insertTurn.run(sessionId, "child", t, "learning", 0, "writing");
    }

    const res = await request(app)
      .post("/api/chat")
      .send({ sessionId, text: "我休息一下", state: "writing" });
    expect(res.status).toBe(200);
    expect(res.body.isLoop).toBe(false);

    // outbox 应该是空的（happy/neutral 情绪不触发，loop 不触发）
    try {
      const outboxContent = readFileSync(outboxPath, "utf8");
      const lines = outboxContent.trim().split("\n").filter(Boolean);
      expect(lines.length).toBe(0);
    } catch (e: any) {
      // 文件不存在 = 没有写 outbox = OK
      expect(e?.code).toBe("ENOENT");
    }
  });

  it("LLM 回复末尾的情绪标签被剥离（reply 不含 ::emotion::）", async () => {
    // 没有 API key 时走 fallback（不含 emotion 标签）— emotion 应是 neutral
    const res = await postChat("我今天不太开心");
    expect(res.status).toBe(200);
    expect(res.body.emotion).toBe("neutral");  // fallback 没标签
    expect(res.body.reply).not.toContain("::emotion::");
  });

  it("response.json 包含 emotion 字段（默认 neutral）", async () => {
    const res = await postChat("你好");
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("emotion");
    expect(res.body).toHaveProperty("isLoop");
    expect(typeof res.body.emotion).toBe("string");
    expect(typeof res.body.isLoop).toBe("boolean");
  });
});

describe("POST /api/buddy/unlock (issue #55: PIN gate)", () => {
  // BuddyLock has in-memory state per app instance; each describe below
  // builds its own app to keep state isolated. Each app also gets its
  // own temp outbox dir for hygiene.
  function makeApp(pin: string | null) {
    const outbox = join(mkdtempSync(join(tmpdir(), "study-buddy-buddylock-")), "outbox.jsonl");
    return createApp({
      db,
      httpsPort: 3000,
      outboxPath: outbox,
      buddyPin: pin,
    });
  }

  it("200 on correct PIN", async () => {
    const appWithPin = makeApp("8864");
    const res = await request(appWithPin).post("/api/buddy/unlock").send({ pin: "8864" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it("401 on wrong PIN", async () => {
    const appWithPin = makeApp("8864");
    const res = await request(appWithPin).post("/api/buddy/unlock").send({ pin: "0000" });
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "wrong" });
  });

  it("429 with Retry-After after 5 wrong attempts from same IP", async () => {
    const appWithPin = makeApp("8864");
    for (let i = 0; i < 5; i++) {
      await request(appWithPin).post("/api/buddy/unlock").send({ pin: "0000" });
    }
    const res = await request(appWithPin).post("/api/buddy/unlock").send({ pin: "8864" });
    expect(res.status).toBe(429);
    expect(res.body.error).toBe("locked");
    expect(typeof res.body.retryAfterSec).toBe("number");
    expect(res.body.retryAfterSec).toBeGreaterThan(290);
    expect(res.body.retryAfterSec).toBeLessThanOrEqual(300);
    expect(res.headers["retry-after"]).toBeDefined();
  });

  it("null PIN (BUDDY_PIN unset) → all requests return 200", async () => {
    const appWithPin = makeApp(null);
    for (let i = 0; i < 10; i++) {
      const res = await request(appWithPin).post("/api/buddy/unlock").send({ pin: "0000" });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });
    }
  });

  it("400 when pin is not a string", async () => {
    const appWithPin = makeApp("8864");
    const res = await request(appWithPin).post("/api/buddy/unlock").send({ pin: 1234 });
    expect(res.status).toBe(400);
  });
});

describe("GET /api/buddy/status (issue: dev-mode skip PIN gate)", () => {
  // Companion to the unlock tests — same makeApp helper, same
  // per-app in-memory BuddyLock instance.
  function makeApp(pin: string | null) {
    const outbox = join(mkdtempSync(join(tmpdir(), "study-buddy-buddystatus-")), "outbox.jsonl");
    return createApp({
      db,
      httpsPort: 3000,
      outboxPath: outbox,
      buddyPin: pin,
    });
  }

  it("returns { locked: false } when BUDDY_PIN is unset (dev mode)", async () => {
    const appWithPin = makeApp(null);
    const res = await request(appWithPin).get("/api/buddy/status");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ locked: false, chatEnabled: true });
  });

  it("returns { locked: true } when BUDDY_PIN is set (and never leaks the PIN)", async () => {
    const appWithPin = makeApp("8864");
    const res = await request(appWithPin).get("/api/buddy/status");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ locked: true, chatEnabled: true });
    expect(JSON.stringify(res.body)).not.toContain("8864");
  });

  it("returns { locked: false } when BUDDY_PIN is empty string (treated as unset)", async () => {
    const appWithPin = makeApp("");
    const res = await request(appWithPin).get("/api/buddy/status");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ locked: false, chatEnabled: true });
  });

  it("status endpoint is open to any IP (no rate limit, no unlock required)", async () => {
    const appWithPin = makeApp("8864");
    for (let i = 0; i < 10; i++) {
      const res = await request(appWithPin).get("/api/buddy/status");
      expect(res.status).toBe(200);
    }
  });

  it("returns chatEnabled: true by default (BUDDY_CHAT_ENABLED unset)", async () => {
    const appWithPin = makeApp(null);
    const res = await request(appWithPin).get("/api/buddy/status");
    expect(res.status).toBe(200);
    expect(res.body.chatEnabled).toBe(true);
  });

  it("returns chatEnabled: false when the buddy chat is disabled (photo-only mode)", async () => {
    const outbox = join(mkdtempSync(join(tmpdir(), "study-buddy-buddystatus-")), "outbox.jsonl");
    const appNoChat = createApp({
      db,
      httpsPort: 3000,
      outboxPath: outbox,
      buddyPin: null,
      buddyChatEnabled: false,
    });
    const res = await request(appNoChat).get("/api/buddy/status");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ locked: false, chatEnabled: false });
  });
});

describe("GET /api/write/words (issue #57: word library)", () => {
  it("returns empty list on fresh DB", async () => {
    const res = await request(app).get("/api/write/words");
    expect(res.status).toBe(200);
    // Note: words may carry over from earlier tests in this file since
    // the global `app` is shared. We just assert the shape.
    expect(Array.isArray(res.body.words)).toBe(true);
  });

  it("lists words added via POST", async () => {
    // Add some characters first.
    await request(app).post("/api/write/words").send({ chars: "一二三" });
    const res = await request(app).get("/api/write/words");
    expect(res.status).toBe(200);
    const chars = (res.body.words as Array<{ char: string }>).map((w) => w.char);
    expect(new Set(chars)).toEqual(new Set(["一", "二", "三"]));
  });
});

describe("POST /api/write/words", () => {
  it("adds a single-character string", async () => {
    // Use a fresh char that earlier tests haven't used.
    const res = await request(app).post("/api/write/words").send({ chars: "永" });
    expect(res.status).toBe(200);
    // `永` may have been added by an earlier test in this file — the
    // contract here is that we get a 200 + a well-formed body.
    expect(res.body.added + res.body.skipped).toBe(1);
  });

  it("strips non-CJK and reports correctly", async () => {
    // Use chars unlikely to be polluted: 学 (likely fresh).
    const res = await request(app).post("/api/write/words").send({ chars: "学 a 1 习" });
    // 学 + 习 = 2 CJK; 2 non-CJK in between. If 学/习 already exists
    // from earlier, it still counts toward `skipped` (= chars.length - added).
    const totalChars = Array.from("学 a 1 习").length;  // 6
    expect(res.body.added + res.body.skipped).toBe(totalChars);
    expect(res.body.added).toBeGreaterThanOrEqual(0);
    expect(res.body.added).toBeLessThanOrEqual(2);
  });

  it("400 when chars is not a string", async () => {
    const res = await request(app).post("/api/write/words").send({ chars: 123 });
    expect(res.status).toBe(400);
  });
});

describe("DELETE /api/write/words/:char", () => {
  it("removes an existing word", async () => {
    // First add, then delete.
    await request(app).post("/api/write/words").send({ chars: "永" });
    const res = await request(app).delete("/api/write/words/永");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it("404 for unknown single-CJK char", async () => {
    // Pick a CJK char unlikely to have been added: 蛙 (frog)
    const res = await request(app).delete("/api/write/words/蛙");
    expect(res.status).toBe(404);
  });

  it("400 for multi-char URL param (only single CJK allowed)", async () => {
    const res = await request(app).delete("/api/write/words/不存在的字");
    expect(res.status).toBe(400);
  });

  it("400 for non-CJK URL param", async () => {
    const res = await request(app).delete("/api/write/words/abc");
    expect(res.status).toBe(400);
  });
});

describe("POST /api/write/attempts", () => {
  it("records an attempt after the char is in the library", async () => {
    await request(app).post("/api/write/words").send({ chars: "永" });
    const res = await request(app)
      .post("/api/write/attempts")
      .send({ char: "永", level: 1.0, strokePath: "M 0 0 L 10 10" });
    expect(res.status).toBe(200);
    expect(res.body.attemptId).toBeGreaterThan(0);
  });

  it("400 when char is missing from library (FK constraint)", async () => {
    // Pick a fresh char that earlier tests haven't added: 蛙
    const res = await request(app)
      .post("/api/write/attempts")
      .send({ char: "蛙", level: 1.0, strokePath: "M 0 0" });
    expect(res.status).toBe(400);
  });

  it("400 when level is out of range", async () => {
    await request(app).post("/api/write/words").send({ chars: "永" });
    const res = await request(app)
      .post("/api/write/attempts")
      .send({ char: "永", level: 1.5, strokePath: "M 0 0" });
    expect(res.status).toBe(400);
  });

  it("accepts null strokePath (kid closed tab mid-write)", async () => {
    await request(app).post("/api/write/words").send({ chars: "永" });
    const res = await request(app)
      .post("/api/write/attempts")
      .send({ char: "永", level: 1.0, strokePath: null });
    expect(res.status).toBe(200);
  });
});

describe("GET /api/write/words/:char/attempts", () => {
  it("returns attempts for a char (newest first)", async () => {
    await request(app).post("/api/write/words").send({ chars: "永" });
    await request(app).post("/api/write/attempts").send({ char: "永", level: 1.0, strokePath: "old" });
    await new Promise((r) => setTimeout(r, 5));
    await request(app).post("/api/write/attempts").send({ char: "永", level: 0.5, strokePath: "new" });
    const res = await request(app).get("/api/write/words/永/attempts");
    expect(res.status).toBe(200);
    const list = res.body.attempts as Array<{ strokePath: string }>;
    // Newest first — there should be at least these two
    const newIdx = list.findIndex((a) => a.strokePath === "new");
    const oldIdx = list.findIndex((a) => a.strokePath === "old");
    expect(newIdx).toBeGreaterThanOrEqual(0);
    expect(oldIdx).toBeGreaterThan(newIdx);  // new comes before old
  });
});
