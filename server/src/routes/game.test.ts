// server/src/routes/game.test.ts
//
// Tests for the game route module extracted from app.ts (PR 5 of
// the refactor series). The module owns:
//   - POST /api/game/mistake      — record a candy-math-island mistake
//   - GET  /api/game/weak-topics  — recent weak topics for a window
//   - POST /api/game/session      — record a finished time-mode run
//   - GET  /api/game/daily        — daily stats for the parent dashboard
//
// Tested in isolation. The data layer is the real game-sync.ts (already
// covered by game-sync.test.ts), so these tests focus on the HTTP
// surface: validation, status codes, and response shape.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import express from "express";
import request from "supertest";
import Database from "better-sqlite3";
import { migrateSchema } from "../db-migrate.js";
import { registerGameRoutes } from "./game.js";

let db: Database.Database;
let app: ReturnType<typeof express>;

beforeAll(() => {
  db = new Database(":memory:");
  migrateSchema(db);
});

afterAll(() => db.close());

beforeEach(() => {
  db.exec("DELETE FROM game_sessions");
  db.exec("DELETE FROM mistakes");
  db.exec("DELETE FROM sessions");

  app = express();
  app.use(express.json());
  registerGameRoutes(app, { db, logger: silentLogger(), outboxPath: "/tmp/test-outbox.jsonl" });
});

function silentLogger() {
  return { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
}

// --- POST /api/game/mistake -----------------------------------------

describe("POST /api/game/mistake", () => {
  it("records a mistake and returns the id", async () => {
    const res = await request(app)
      .post("/api/game/mistake")
      .send({
        childId: "default",
        subject: "math",
        problem: "2 + 2 = ?",
        errorType: "calculation",
        userAnswer: 5,
        correctAnswer: 4,
        level: 2,
      });
    expect(res.status).toBe(200);
    expect(res.body.mistakeId).toBeTruthy();
  });

  it("returns 400 when fields are missing or wrong type", async () => {
    const res = await request(app)
      .post("/api/game/mistake")
      .send({ childId: "default" });  // missing everything else
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/missing or invalid/);
  });

  it("returns 400 when userAnswer is a string", async () => {
    const res = await request(app)
      .post("/api/game/mistake")
      .send({
        childId: "default",
        subject: "math",
        problem: "2 + 2",
        errorType: "calculation",
        userAnswer: "five",  // wrong type
        correctAnswer: 4,
        level: 1,
      });
    expect(res.status).toBe(400);
  });
});

// --- GET /api/game/weak-topics --------------------------------------

describe("GET /api/game/weak-topics", () => {
  it("returns 200 with default 7-day window", async () => {
    const res = await request(app).get("/api/game/weak-topics");
    expect(res.status).toBe(200);
    expect(res.body.days).toBe(7);
    expect(Array.isArray(res.body.weakTopics)).toBe(true);
  });

  it("accepts a custom days query param", async () => {
    const res = await request(app).get("/api/game/weak-topics?days=30");
    expect(res.status).toBe(200);
    expect(res.body.days).toBe(30);
  });

  it("returns 400 for non-positive days", async () => {
    const r1 = await request(app).get("/api/game/weak-topics?days=0");
    expect(r1.status).toBe(400);
    const r2 = await request(app).get("/api/game/weak-topics?days=-5");
    expect(r2.status).toBe(400);
    const r3 = await request(app).get("/api/game/weak-topics?days=abc");
    expect(r3.status).toBe(400);
  });
});

// --- POST /api/game/session -----------------------------------------

describe("POST /api/game/session", () => {
  it("records a session and returns id + correctRate", async () => {
    const now = Date.now();
    const res = await request(app)
      .post("/api/game/session")
      .send({
        childId: "default",
        appId: "candy-math-island",
        durationSec: 600,
        totalQuestions: 10,
        correctCount: 8,
        startedAt: now - 600_000,
        endedAt: now,
      });
    expect(res.status).toBe(200);
    expect(res.body.sessionId).toBeTruthy();
    expect(res.body.correctRate).toBe(80);
  });

  it("returns 400 on validation errors thrown by recordGameSession", async () => {
    const res = await request(app)
      .post("/api/game/session")
      .send({
        childId: "default",
        appId: "candy-math-island",
        durationSec: 600,
        totalQuestions: 0,  // invalid
        correctCount: 0,
        startedAt: Date.now(),
        endedAt: Date.now(),
      });
    expect(res.status).toBe(400);
  });

  it("returns 400 on missing fields", async () => {
    const res = await request(app).post("/api/game/session").send({});
    expect(res.status).toBe(400);
  });
});

// --- GET /api/game/daily --------------------------------------------

describe("GET /api/game/daily", () => {
  it("returns 200 with default 7-day window", async () => {
    const res = await request(app).get("/api/game/daily");
    expect(res.status).toBe(200);
    expect(res.body.days).toBe(7);
    expect(Array.isArray(res.body.daily)).toBe(true);
  });

  it("accepts an appId filter", async () => {
    const res = await request(app).get("/api/game/daily?appId=candy-math-island");
    expect(res.status).toBe(200);
    expect(res.body.appId).toBe("candy-math-island");
  });

  it("returns 400 for non-positive days", async () => {
    const res = await request(app).get("/api/game/daily?days=0");
    expect(res.status).toBe(400);
  });
});
