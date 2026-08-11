// server/src/routes/session.test.ts
//
// Tests for the session route module extracted from app.ts (PR 3 of
// the refactor series). The module owns:
//   - POST /api/session/start
//   - POST /api/session/end
//   - GET /api/session/active
//
// Tested in isolation with a fresh mini express app + in-memory SQLite.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import express from "express";
import request from "supertest";
import Database from "better-sqlite3";
import { migrateSchema } from "../db-migrate.js";
import { registerSessionRoutes } from "./session.js";
import { seedTestDevice, testDeviceAuthenticator } from "../test-device.js";

let db: Database.Database;
let app: ReturnType<typeof express>;

beforeAll(() => {
  db = new Database(":memory:");
  migrateSchema(db);
});

afterAll(() => db.close());

beforeEach(() => {
  // Wipe the session-scoped tables so each test starts with a
  // known-empty state. Children + settings survive (they're
  // seeded by migrateSchema, and tests don't mutate them).
  db.exec("DELETE FROM chat_turns");
  db.exec("DELETE FROM posture_events");
  db.exec("DELETE FROM sessions");
  seedTestDevice(db);

  app = express();
  app.use(express.json());
  registerSessionRoutes(app, {
    db,
    logger: silentLogger(),
    auth: testDeviceAuthenticator,
  });
});

function silentLogger() {
  return { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
}

// --- POST /api/session/start -----------------------------------------

describe("POST /api/session/start", () => {
  it("creates a new session and returns its id", async () => {
    const res = await request(app).post("/api/session/start").send({ childId: "default" });
    expect(res.status).toBe(200);
    expect(res.body.sessionId).toBeTruthy();
    expect(res.body.childId).toBe("default");
    expect(res.body.startedAt).toBeGreaterThan(0);
  });

  it("accepts an empty request body when starting a new epoch", async () => {
    const res = await request(app).post("/api/session/start");
    expect(res.status).toBe(200);
    expect(res.body.sessionId).toBeTruthy();
  });

  it("closes any currently-active session before starting a new one", async () => {
    const r1 = await request(app).post("/api/session/start").send({});
    const firstId = r1.body.sessionId;

    const r2 = await request(app).post("/api/session/start").send({});
    const secondId = r2.body.sessionId;

    expect(firstId).not.toBe(secondId);

    // The first session should now have ended_at set.
    const ended = db.prepare("SELECT ended_at FROM sessions WHERE id = ?").get(firstId) as { ended_at: number | null };
    expect(ended.ended_at).toBeGreaterThan(0);
  });

  it("stores subject when provided", async () => {
    const res = await request(app).post("/api/session/start").send({ subject: "math" });
    const row = db.prepare("SELECT subject FROM sessions WHERE id = ?").get(res.body.sessionId) as { subject: string };
    expect(row.subject).toBe("math");
  });

  it("stores subject as null when omitted", async () => {
    const res = await request(app).post("/api/session/start").send({});
    const row = db.prepare("SELECT subject FROM sessions WHERE id = ?").get(res.body.sessionId) as { subject: string | null };
    expect(row.subject).toBeNull();
  });
});

// --- POST /api/session/end -------------------------------------------

describe("POST /api/session/end", () => {
  it("returns 400 when no active session exists", async () => {
    const res = await request(app).post("/api/session/end").send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/sessionId is required/);
  });

  it("ends the active session and returns aggregate stats", async () => {
    // Start a session.
    const start = await request(app).post("/api/session/start").send({});
    const sessionId = start.body.sessionId;

    // Log a posture event with a focus score, so avgFocusScore is non-zero.
    db.prepare(
      "INSERT INTO posture_events (session_id, score, ts) VALUES (?, ?, ?)"
    ).run(sessionId, 80, Date.now());
    // Log an offtopic chat turn that's been redirected, so recovered=1.
    db.prepare(
      `INSERT INTO chat_turns (session_id, role, topic, redirected, ts)
       VALUES (?, 'child', 'offtopic', 1, ?)`
    ).run(sessionId, Date.now());

    const res = await request(app).post("/api/session/end").send({ sessionId });
    expect(res.status).toBe(200);
    expect(res.body.sessionId).toBe(sessionId);
    expect(res.body.postureWarningCount).toBe(0);
    expect(res.body.offtopicCount).toBe(1);
    expect(res.body.offtopicRecovered).toBe(1);
  });

  it("computes durationMin as max 1 minute (rounded)", async () => {
    const start = await request(app).post("/api/session/start").send({});
    // Session is 0ms old; duration should be clamped to 1.
    const res = await request(app).post("/api/session/end").send({ sessionId: start.body.sessionId });
    expect(res.body.durationMin).toBe(1);
  });

  it("after ending, the session is no longer active", async () => {
    const started = await request(app).post("/api/session/start").send({});
    await request(app).post("/api/session/end").send({ sessionId: started.body.sessionId });
    const res = await request(app).get("/api/session/active");
    expect(res.status).toBe(200);
    expect(res.body.session).toBeNull();
  });
});
