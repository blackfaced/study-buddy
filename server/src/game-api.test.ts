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
  // SB124-T01 PR-B: mistake_cases is now the source-of-truth for dedupe
  // so we must clear it (and the related closure-loop tables) too —
  // otherwise the next test's POST gets an idempotent-retry 200.
  db.exec("DELETE FROM game_sessions");
  db.exec("DELETE FROM learning_attempts");
  db.exec("DELETE FROM correction_obligations");
  db.exec("DELETE FROM mistake_cases");
  db.exec("DELETE FROM mistakes");
});

beforeEach(() => {
  // Reset between tests so aggregates are deterministic.
  db.prepare("UPDATE sessions SET ended_at = strftime('%s','now')*1000 WHERE ended_at IS NULL").run();
  db.exec("DELETE FROM learning_attempts");
  db.exec("DELETE FROM correction_obligations");
  db.exec("DELETE FROM mistake_cases");
  db.exec("DELETE FROM mistakes");
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

describe("POST /api/game/mistake (compat adapter)", () => {
  // The legacy game endpoint (issue #98 contract) is a long-lived
  // compat adapter over insertMistake(). T10's 410 retirement was
  // reversed: production game clients still call this route and
  // silently drop data on non-2xx. Full DB-level assertions live in
  // mistake-api.test.ts; here we guard the HTTP contract.
  it("records a valid mistake: 201 + created:true", async () => {
    const res = await request(app)
      .post("/api/game/mistake")
      .send({
        childId: "default",
        problem: "5 + 7 = ?",
        errorType: "carry",
        userAnswer: "11",
        correctAnswer: "12",
      });
    expect(res.status).toBe(201);
    expect(res.body.created).toBe(true);
    expect(typeof res.body.id).toBe("number");
    expect(typeof res.body.caseId).toBe("string");
  });

  it("returns 400 on missing required fields", async () => {
    const res = await request(app)
      .post("/api/game/mistake")
      .send({ childId: "default" });
    expect(res.status).toBe(400);
  });
});

describe("GET /api/game/weak-topics", () => {
  it("returns the aggregated weak topics across recent days", async () => {
    // Seed three carries via insertMistake (the same helper the
    // /api/game/mistake compat adapter delegates to — using it
    // directly keeps this test focused on the weak-topics
    // aggregation logic).
    const { insertMistake } = await import("./capture-service.js");
    for (let i = 0; i < 3; i++) {
      insertMistake(db, {
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
    // Use dynamic UTC timestamps anchored to today, so the test always lands
    // inside the 7-day window regardless of when CI runs. Previously this
    // test used `Date.now() - 24*3600*1000` for "yesterday", which broke
    // in CI when the runner hit 00:00 UTC (both "today" sessions and
    // "yesterday" ended up in the same localtime day → only 1 group).
    // A later variant hard-coded 2026-08-09/10, which aged out 7 days later
    // when the API's 7-day window started excluding them.
    const dayMs = 86_400_000;
    const nowMs = Date.now();
    const todayNoon = nowMs - (nowMs % dayMs) + 12 * 3_600_000;
    const yesterdayNoon = todayNoon - dayMs;
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
