// server/src/routes/system.test.ts
//
// Tests for the system route module extracted from app.ts (PR 1).
// The only endpoint today is /api/health — a liveness probe that
// also surfaces childrenCount + sessionsCount for ops dashboards.
//
// We test in isolation with a fresh mini express app + in-memory
// SQLite, instead of the full createApp(). That way a future
// change to chat / game / write routes can't mask a regression
// here, and we exercise the module's contract directly.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express from "express";
import request from "supertest";
import Database from "better-sqlite3";
import { migrateSchema } from "../db-migrate.js";
import { registerSystemRoutes } from "./system.js";

let db: Database.Database;
let app: ReturnType<typeof express>;

beforeAll(() => {
  db = new Database(":memory:");
  migrateSchema(db);
  app = express();
  registerSystemRoutes(app, db);
});

afterAll(() => db.close());

describe("GET /api/health", () => {
  it("returns 200", async () => {
    const res = await request(app).get("/api/health");
    expect(res.status).toBe(200);
  });

  it("returns ok=true, service=study-buddy, version=0.1.0", async () => {
    const res = await request(app).get("/api/health");
    expect(res.body).toMatchObject({
      ok: true,
      service: "study-buddy",
      version: "0.1.0",
    });
  });

  it("reports childrenCount and sessionsCount from the database", async () => {
    // Seed a child and a session so the counts are non-zero.
    db.prepare("INSERT INTO children (id, name, created_at) VALUES (?, ?, ?)").run("c1", "小宝", Date.now());
    db.prepare(
      "INSERT INTO sessions (id, child_id, started_at, ended_at) VALUES (?, ?, ?, ?)"
    ).run("s1", "c1", Date.now(), Date.now());

    const res = await request(app).get("/api/health");
    expect(res.body.childrenCount).toBeGreaterThanOrEqual(1);
    expect(res.body.sessionsCount).toBeGreaterThanOrEqual(1);
  });

  it("counts the migration-seeded default child (one '小宝' row)", async () => {
    // migrateSchema seeds a default '小宝' child on first run
    // (see db-migrate.ts). The health endpoint should report at
    // least 1 child after migration. sessions stays 0 until the
    // kid starts a session.
    const empty = new Database(":memory:");
    migrateSchema(empty);
    const a = express();
    registerSystemRoutes(a, empty);
    const res = await request(a).get("/api/health");
    expect(res.body.childrenCount).toBe(1);
    expect(res.body.sessionsCount).toBe(0);
    empty.close();
  });
});

describe("GET /api/health env marker (test-instance badge)", () => {
  it("defaults to env=prod", async () => {
    const saved = process.env.STUDY_BUDDY_ENV;
    delete process.env.STUDY_BUDDY_ENV;
    try {
      const res = await request(app).get("/api/health");
      expect(res.body.env).toBe("prod");
    } finally {
      if (saved !== undefined) process.env.STUDY_BUDDY_ENV = saved;
    }
  });

  it("reports env=test when STUDY_BUDDY_ENV=test (the 3002 instance)", async () => {
    const saved = process.env.STUDY_BUDDY_ENV;
    process.env.STUDY_BUDDY_ENV = "test";
    try {
      const res = await request(app).get("/api/health");
      expect(res.body.env).toBe("test");
    } finally {
      if (saved === undefined) delete process.env.STUDY_BUDDY_ENV;
      else process.env.STUDY_BUDDY_ENV = saved;
    }
  });
});
