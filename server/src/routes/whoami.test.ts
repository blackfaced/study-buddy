// server/src/routes/whoami.test.ts
//
// Tests for the /api/whoami endpoint (Phase 4 of the refactor
// series). The endpoint returns the current child profile +
// session context for agent-side introspection. It's a
// non-mutating GET that aggregates state from the children +
// sessions tables.
//
// Why a separate module: it's read-only and orthogonal to the
// existing /api/pair (which is for first-run pairing, not
// "what's the current state"). Keeping whoami isolated makes
// it easy to extend (e.g. add a session-id cookie so the agent
// can ask "which session is the kid in right now?") without
// growing the buddy module.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import express from "express";
import request from "supertest";
import Database from "better-sqlite3";
import { migrateSchema } from "../db-migrate.js";
import { registerWhoamiRoutes } from "./whoami.js";

let db: Database.Database;
let app: ReturnType<typeof express>;

beforeAll(() => {
  db = new Database(":memory:");
  migrateSchema(db);
});

afterAll(() => db.close());

beforeEach(() => {
  db.exec("DELETE FROM chat_turns");
  db.exec("DELETE FROM posture_events");
  db.exec("DELETE FROM mistakes");
  db.exec("DELETE FROM sessions");
  app = express();
  registerWhoamiRoutes(app, { db, version: "0.1.0-test" });
});

// --- GET /api/whoami ------------------------------------------------

describe("GET /api/whoami", () => {
  it("returns 200 with the default child profile", async () => {
    const res = await request(app).get("/api/whoami");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      service: "study-buddy",
      version: "0.1.0-test",
      child: {
        childId: "default",
        name: "小宝",
        grade: "二年级",
      },
    });
  });

  it("returns session: null when no active session", async () => {
    const res = await request(app).get("/api/whoami");
    expect(res.body.session).toBeNull();
  });

  it("returns the active session when one is in flight", async () => {
    // Start a session, then ask.
    db.prepare(
      "INSERT INTO sessions (id, child_id, subject) VALUES (?, ?, ?)"
    ).run("s_test_1", "default", "math");
    const res = await request(app).get("/api/whoami");
    expect(res.body.session).toMatchObject({
      id: "s_test_1",
      childId: "default",
      subject: "math",
    });
    expect(res.body.session.startedAt).toBeGreaterThan(0);
  });

  it("reflects a renamed child (the rename is read fresh from DB)", async () => {
    db.prepare("UPDATE children SET name = ? WHERE id = ?").run("大宝", "default");
    const res = await request(app).get("/api/whoami");
    expect(res.body.child.name).toBe("大宝");
  });

  it("returns the most recent active session (ended ones are skipped)", async () => {
    // Ended session
    db.prepare("INSERT INTO sessions (id, child_id, started_at, ended_at) VALUES (?, ?, ?, ?)")
      .run("s_ended", "default", Date.now() - 60_000, Date.now() - 30_000);
    // Active session
    db.prepare("INSERT INTO sessions (id, child_id, started_at) VALUES (?, ?, ?)")
      .run("s_active", "default", Date.now());
    const res = await request(app).get("/api/whoami");
    expect(res.body.session.id).toBe("s_active");
  });
});
