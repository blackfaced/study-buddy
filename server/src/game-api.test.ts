import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import Database from "better-sqlite3";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, APPS } from "./app.js";
import { migrateSchema } from "./db-migrate.js";

let db: Database.Database;
let app: ReturnType<typeof createApp>;
let outboxPath: string;

beforeAll(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  migrateSchema(db);
  outboxPath = join(mkdtempSync(join(tmpdir(), "game-api-")), "outbox.jsonl");
  app = createApp({ db, httpsPort: 3000, outboxPath });
});

afterAll(() => {
  db.close();
});

beforeEach(() => {
  // Clear game-related tables so tests don't see each other's rows.
  db.exec("DELETE FROM game_sessions");
  db.exec("DELETE FROM mistakes");
});

beforeEach(() => {
  // Reset between tests so aggregates are deterministic.
  db.prepare("UPDATE sessions SET ended_at = strftime('%s','now')*1000 WHERE ended_at IS NULL").run();
  db.prepare("DELETE FROM mistakes").run();
});

describe("GET /api/apps (platform registry)", () => {
  it("returns the registered apps list", async () => {
    const res = await request(app).get("/api/apps");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.apps)).toBe(true);
    expect(res.body.apps.length).toBeGreaterThan(0);
    const candy = res.body.apps.find((a: any) => a.id === "candy-math-island");
    expect(candy).toBeDefined();
    expect(candy.name).toBe("糖果口算岛");
    expect(candy.url).toBe("/games/candy-math-island/");
    expect(candy.status).toBe("ready");
  });

  it("APPS export matches the API response", () => {
    // sanity: same source of truth
    expect(APPS.length).toBeGreaterThan(0);
    expect(APPS.find((a) => a.id === "candy-math-island")).toBeDefined();
  });
});

describe("POST /api/game/mistake (issue #98: auto-record, dedupe by child_id+problem)", () => {
  // T1 contract: string user/correct answer, dedupe via UNIQUE
  // (child_id, problem), returns {id, created} with 201/200.
  // The old {mistakeId} + outbox-write contract was retired when this
  // route moved from routes/game.ts to routes/mistake-api.ts. Outbox
  // writes are a separate concern (the Memory Nexus worker can read
  // straight from the mistakes table — see issue #34 follow-up).
  const validBody = {
    childId: "default",
    problem: "5 + 7 = ?",
    errorType: "carry",
    userAnswer: "11",
    correctAnswer: "12",
    source: "candy-math-island",
  };

  it("returns 201 and {id, created:true} on a first-time payload", async () => {
    const res = await request(app).post("/api/game/mistake").send(validBody);
    expect(res.status).toBe(201);
    expect(res.body.created).toBe(true);
    expect(typeof res.body.id).toBe("number");
  });

  it("persists the mistake with the user/correct answers and child_id", async () => {
    const res = await request(app).post("/api/game/mistake").send(validBody);
    const id = res.body.id as number;
    const row = db
      .prepare("SELECT * FROM mistakes WHERE id = ?")
      .get(id) as any;
    expect(row).toBeDefined();
    expect(row.child_id).toBe("default");
    expect(row.error_type).toBe("carry");
    expect(row.user_answer).toBe("11");
    expect(row.correct_answer).toBe("12");
  });

  it("returns 200 and {id, created:false} on a second identical call (idempotent)", async () => {
    const res1 = await request(app).post("/api/game/mistake").send(validBody);
    const res2 = await request(app).post("/api/game/mistake").send(validBody);
    expect(res1.status).toBe(201);
    expect(res2.status).toBe(200);
    expect(res2.body.created).toBe(false);
    expect(res2.body.id).toBe(res1.body.id);
  });

  it("returns 400 when required fields are missing", async () => {
    const res = await request(app).post("/api/game/mistake").send({ childId: "default" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/required/);
  });
});

describe("GET /api/game/weak-topics", () => {
  it("returns the aggregated weak topics across recent days", async () => {
    // Seed three carries via the new mistake-api contract (T1, #98):
    // string user/correct answer, source='game' so weak-topics can find them.
    for (let i = 0; i < 3; i++) {
      await request(app)
        .post("/api/game/mistake")
        .send({
          childId: "default",
          problem: `5+${i}`,
          errorType: "carry",
          userAnswer: "0",
          correctAnswer: "1",
          source: "game",
        });
    }
    const res = await request(app).get("/api/game/weak-topics?days=7");
    expect(res.status).toBe(200);
    expect(res.body.days).toBe(7);
    const carry = res.body.weakTopics.find((t: any) => t.errorType === "carry");
    expect(carry).toBeDefined();
    expect(carry.count).toBe(3);
  });

  it("defaults to 7 days when no ?days is given", async () => {
    const res = await request(app).get("/api/game/weak-topics");
    expect(res.status).toBe(200);
    expect(res.body.days).toBe(7);
  });

  it("returns 400 on a non-positive days value", async () => {
    const res = await request(app).get("/api/game/weak-topics?days=0");
    expect(res.status).toBe(400);
  });
});

describe("POST /api/game/session (v0.6 time-mode)", () => {
  it("records a finished session and returns the sessionId + correctRate", async () => {
    const startedAt = Date.now() - 60_000;
    const res = await request(app)
      .post("/api/game/session")
      .send({
        childId: "default",
        appId: "candy-math-island",
        durationSec: 60,
        totalQuestions: 10,
        correctCount: 8,
        startedAt,
        endedAt: Date.now(),
      });
    expect(res.status).toBe(200);
    expect(res.body.sessionId).toBeGreaterThan(0);
    expect(res.body.correctRate).toBe(80);
  });

  it("returns 400 when totalQuestions is 0 (validation in recordGameSession)", async () => {
    const res = await request(app)
      .post("/api/game/session")
      .send({
        childId: "default",
        appId: "candy-math-island",
        durationSec: 60,
        totalQuestions: 0,
        correctCount: 0,
        startedAt: Date.now() - 60_000,
        endedAt: Date.now(),
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/totalQuestions/);
  });

  it("returns 400 on missing required fields", async () => {
    const res = await request(app)
      .post("/api/game/session")
      .send({ childId: "default" });
    expect(res.status).toBe(400);
  });
});

describe("GET /api/game/daily (v0.6 daily aggregation)", () => {
  it("returns one row per day for recent sessions", async () => {
    // Use absolute UTC timestamps that are guaranteed to land on different
    // local-time days regardless of when the test runs. Previously this
    // test used `Date.now() - 24*3600*1000` for "yesterday", which broke
    // in CI when the runner hit 00:00 UTC (both "today" sessions and
    // "yesterday" ended up in the same localtime day → only 1 group).
    // Pick mid-day UTC timestamps so the localtime conversion always
    // lands on a unique YYYY-MM-DD.
    const todayNoon = Date.UTC(2026, 7, 10, 12, 0, 0);   // 2026-08-10 12:00 UTC
    const yesterdayNoon = Date.UTC(2026, 7, 9, 12, 0, 0); // 2026-08-09 12:00 UTC
    // Today: 2 sessions, 20 questions, 17 correct (85%)
    for (const [total, correct] of [[12, 9], [8, 8]] as const) {
      await request(app).post("/api/game/session").send({
        childId: "default",
        appId: "candy-math-island",
        durationSec: 60,
        totalQuestions: total,
        correctCount: correct,
        startedAt: todayNoon,
        endedAt: todayNoon + 60_000,
      });
    }
    // Yesterday: 1 session, 10 questions, 7 correct
    await request(app).post("/api/game/session").send({
      childId: "default",
      appId: "candy-math-island",
      durationSec: 60,
      totalQuestions: 10,
      correctCount: 7,
      startedAt: yesterdayNoon,
      endedAt: yesterdayNoon + 60_000,
    });

    // Use a 7-day window wide enough to include both dates regardless of
    // when the test runs. We use `Date.now() - 0` to bound the window to
    // "now" so the test stays in the 7-day window.
    void Date.now(); // (kept for future tightening if needed)
    const res = await request(app).get("/api/game/daily?days=7");
    expect(res.status).toBe(200);
    expect(res.body.days).toBe(7);
    expect(res.body.daily).toHaveLength(2);
    expect(res.body.daily[0].sessionCount).toBe(2);
    expect(res.body.daily[0].totalQuestions).toBe(20);
    expect(res.body.daily[0].correctCount).toBe(17);
    expect(res.body.daily[0].correctRate).toBe(85);
    expect(res.body.daily[1].sessionCount).toBe(1);
    expect(res.body.daily[1].totalQuestions).toBe(10);
    expect(res.body.daily[1].correctRate).toBe(70);
  });

  it("can filter by ?appId", async () => {
    const now = Date.now();
    await request(app).post("/api/game/session").send({
      childId: "default",
      appId: "candy-math-island",
      durationSec: 60,
      totalQuestions: 10,
      correctCount: 8,
      startedAt: now - 30_000,
      endedAt: now,
    });
    await request(app).post("/api/game/session").send({
      childId: "default",
      appId: "another-app",
      durationSec: 60,
      totalQuestions: 5,
      correctCount: 5,
      startedAt: now - 30_000,
      endedAt: now,
    });

    const candy = await request(app).get("/api/game/daily?appId=candy-math-island");
    expect(candy.body.daily[0].totalQuestions).toBe(10);

    const all = await request(app).get("/api/game/daily");
    expect(all.body.daily[0].totalQuestions).toBe(15);
  });

  it("returns [] when no sessions exist", async () => {
    const res = await request(app).get("/api/game/daily");
    expect(res.body.daily).toEqual([]);
  });

  it("returns 400 on a non-positive days value", async () => {
    const res = await request(app).get("/api/game/daily?days=0");
    expect(res.status).toBe(400);
  });
});
