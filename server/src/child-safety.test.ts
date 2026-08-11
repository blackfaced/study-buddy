import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import Database from "better-sqlite3";
import { createApp } from "./app.js";
import { migrateSchema } from "./db-migrate.js";
import { classifyChildSafety } from "./child-safety.js";
import { createLogger, memorySink } from "./logger.js";
import { seedTestDevice, testDeviceAuthenticator } from "./test-device.js";

describe("bounded child-safety policy", () => {
  it.each([
    ["同学每天都欺负我", "bullying"],
    ["爸爸把我锁起来还打我", "abuse"],
    ["我不想活了", "self_harm"],
    ["有人让我脱衣服拍照", "sexual"],
    ["我喘不过气了", "severe_symptom"],
    ["有人问我要家庭地址和电话", "personal_info"],
  ])("classifies %s as %s", (text, category) => {
    expect(classifyChildSafety(text)).toMatchObject({ category });
  });

  it.each(["这道题难死了", "爸爸打电话给我", "我好烦不想写了", "我想玩我的世界"])(
    "does not escalate the ambiguous or ordinary phrase %s",
    (text) => expect(classifyChildSafety(text)).toBeNull(),
  );
});

describe("POST /api/chat safety path", () => {
  let db: Database.Database;
  let providerCalls = 0;
  let logMemory = memorySink();
  let logger = createLogger({ sinks: [logMemory.sink] });

  beforeAll(() => {
    db = new Database(":memory:");
    migrateSchema(db);
    seedTestDevice(db);
  });

  beforeEach(() => {
    db.prepare("DELETE FROM safety_incidents").run();
    db.prepare("DELETE FROM chat_turns").run();
    db.prepare("DELETE FROM sessions").run();
    providerCalls = 0;
    logMemory = memorySink();
    logger = createLogger({ sinks: [logMemory.sink] });
  });

  afterAll(() => db.close());

  function makeApp() {
    return createApp({
      db,
      deviceAuthenticator: testDeviceAuthenticator,
      logger,
      callMinimax: async () => {
        providerCalls += 1;
        return "普通回答";
      },
    });
  }

  async function send(text: string) {
    const app = makeApp();
    const started = await request(app).post("/api/session/start").send({ subject: "作业" });
    return request(app).post("/api/chat").send({
      sessionId: started.body.sessionId,
      text,
      state: "writing",
    });
  }

  it("handles a disclosure locally without MiniMax or normal chat evidence", async () => {
    const raw = "同学每天都欺负我，不让我回教室";
    const response = await send(raw);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ safetyHandled: true, safetyCategory: "bullying" });
    expect(response.body.reply).toContain("身边信任的大人");
    expect(providerCalls).toBe(0);
    expect(db.prepare("SELECT COUNT(*) AS count FROM chat_turns").get()).toEqual({ count: 0 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM source_events").get()).toEqual({ count: 0 });
    expect(db.prepare("SELECT category, urgency, status FROM safety_incidents").get()).toEqual({
      category: "bullying",
      urgency: "attention",
      status: "needs_attention",
    });
    expect(JSON.stringify(logMemory.entries())).not.toContain(raw);
    expect(JSON.stringify(response.body)).not.toContain(raw);
  });

  it("uses imminent-danger wording without claiming it contacted help", async () => {
    const response = await send("我现在喘不过气，胸口很痛");

    expect(response.body.safetyUrgency).toBe("imminent");
    expect(response.body.reply).toMatch(/120|110/);
    expect(response.body.reply).toContain("我不能替你联系");
    expect(providerCalls).toBe(0);
  });

  it("still returns local safety guidance when the minimized signal cannot be stored", async () => {
    db.exec(`CREATE TRIGGER fail_safety_insert BEFORE INSERT ON safety_incidents
      BEGIN SELECT RAISE(ABORT, 'synthetic storage failure'); END`);
    const raw = "我不想活了";
    const response = await send(raw);
    db.exec("DROP TRIGGER fail_safety_insert");

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ safetyHandled: true, safetyCategory: "self_harm" });
    expect(response.body.reply).toContain("身边信任的大人");
    expect(providerCalls).toBe(0);
    expect(db.prepare("SELECT COUNT(*) AS count FROM safety_incidents").get()).toEqual({ count: 0 });
    expect(JSON.stringify(logMemory.entries())).not.toContain(raw);
  });

  it("keeps ordinary frustration on the normal chat path", async () => {
    const response = await send("这道题太难了，我好烦");

    expect(response.body.safetyHandled).toBeUndefined();
    expect(response.body.reply).toBe("普通回答");
    expect(providerCalls).toBe(1);
    expect(db.prepare("SELECT COUNT(*) AS count FROM safety_incidents").get()).toEqual({ count: 0 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM chat_turns").get()).toEqual({ count: 2 });
  });
});
