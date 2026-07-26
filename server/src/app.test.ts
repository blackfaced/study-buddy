import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import Database from "better-sqlite3";
import { createApp } from "./app.js";
import { migrateSchema } from "./db-migrate.js";

let db: Database.Database;
let app: ReturnType<typeof createApp>;

beforeAll(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  migrateSchema(db);
  app = createApp({ db, httpsPort: 3000 });
});

afterAll(() => {
  db.close();
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

// Bug fix (v0.6.1): after /api/session/end, /api/chat used to return
// 400 "no active session". Now it auto-creates a new session for the
// default child so the kid can keep chatting right after "写完啦".
describe("POST /api/chat (v0.6.1: auto-start session when none active)", () => {
  it("returns 200 (not 400) when no session is active", async () => {
    // No /api/session/start was called. Should still work.
    const res = await request(app)
      .post("/api/chat")
      .send({ text: "你好", state: "writing" });
    expect(res.status).toBe(200);
    expect(typeof res.body.reply).toBe("string");
  });

  it("auto-creates a session and writes chat_turns to it", async () => {
    // Clean up any sessions from previous tests
    db.exec("UPDATE sessions SET ended_at = strftime('%s','now')*1000 WHERE ended_at IS NULL");

    const before = (db.prepare("SELECT COUNT(*) as c FROM sessions").get() as any).c;
    const res = await request(app)
      .post("/api/chat")
      .send({ text: "测试", state: "writing" });
    expect(res.status).toBe(200);

    const after = (db.prepare("SELECT COUNT(*) as c FROM sessions").get() as any).c;
    expect(after).toBe(before + 1);

    // chat_turns should reference the new session
    const turns = db.prepare(
      "SELECT role, content, state FROM chat_turns ORDER BY id DESC LIMIT 2"
    ).all() as Array<{ role: string; content: string; state: string }>;
    expect(turns[0].role).toBe("agent");
    expect(turns[0].state).toBe("writing");
    expect(turns[1].role).toBe("child");
    expect(turns[1].content).toBe("测试");
  });

  it("reuses an existing active session (does not create a duplicate)", async () => {
    db.exec("UPDATE sessions SET ended_at = strftime('%s','now')*1000 WHERE ended_at IS NULL");
    // Start one session explicitly
    const start = await request(app).post("/api/session/start").send({});
    const sessionId = start.body.sessionId;

    const before = (db.prepare("SELECT COUNT(*) as c FROM sessions").get() as any).c;
    const res = await request(app)
      .post("/api/chat")
      .send({ text: "继续", state: "writing" });
    expect(res.status).toBe(200);

    const after = (db.prepare("SELECT COUNT(*) as c FROM sessions").get() as any).c;
    expect(after).toBe(before);  // no new session
    // chat_turns linked to the existing session
    const turn = db.prepare(
      "SELECT session_id FROM chat_turns ORDER BY id DESC LIMIT 1"
    ).get() as { session_id: string };
    expect(turn.session_id).toBe(sessionId);
  });

  it("after /api/session/end, the next chat auto-creates a new session", async () => {
    // End the current session
    await request(app).post("/api/session/end").send({});
    // Next chat should succeed (not 400)
    const res = await request(app)
      .post("/api/chat")
      .send({ text: "又来了", state: "writing" });
    expect(res.status).toBe(200);
  });
});

