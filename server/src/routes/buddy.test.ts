// server/src/routes/buddy.test.ts
//
// Tests for the buddy route module extracted from app.ts (PR 2 of
// the refactor series). The module owns:
//   - POST /api/buddy/unlock  — 4-digit PIN gate (issue #55)
//   - GET  /api/pair          — first-run pairing info
//   - POST /api/child/rename  — manual rename (issue #29)
//
// We test in isolation with a fresh mini express app + in-memory
// SQLite + a real BuddyLock. That way a future change in chat /
// game / write can't mask a regression here.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import express from "express";
import request from "supertest";
import Database from "better-sqlite3";
import { migrateSchema } from "../db-migrate.js";
import { BuddyLock } from "../buddy-lock.js";
import { registerBuddyRoutes } from "./buddy.js";

let db: Database.Database;
let app: ReturnType<typeof express>;
let lock: BuddyLock;

beforeAll(() => {
  db = new Database(":memory:");
  migrateSchema(db);
});

afterAll(() => db.close());

beforeEach(() => {
  // Re-build the app + lock for each test so per-IP rate-limit state
  // is fresh. Without this, a locked-out test would leak into the
  // next one.
  app = express();
  app.use(express.json());
  lock = new BuddyLock({ pin: "8864" });
  registerBuddyRoutes(app, { db, httpsPort: 3000, lock, chatEnabled: true, logger: silentLogger() });
});

/** A no-op logger that doesn't spam the test output. */
function silentLogger() {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  };
}

// --- POST /api/buddy/unlock -------------------------------------------

describe("POST /api/buddy/unlock", () => {
  it("returns 200 ok=true with the correct PIN", async () => {
    const res = await request(app).post("/api/buddy/unlock").send({ pin: "8864" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it("returns 400 when pin is missing or not a string", async () => {
    const r1 = await request(app).post("/api/buddy/unlock").send({});
    expect(r1.status).toBe(400);
    expect(r1.body.error).toMatch(/pin must be a string/);

    const r2 = await request(app).post("/api/buddy/unlock").send({ pin: 1234 });
    expect(r2.status).toBe(400);
  });

  it("returns 401 with error='wrong' on a bad PIN", async () => {
    const res = await request(app).post("/api/buddy/unlock").send({ pin: "0000" });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("wrong");
  });

  it("returns 429 + Retry-After after 5 wrong attempts (issue #55)", async () => {
    for (let i = 0; i < 5; i++) {
      await request(app).post("/api/buddy/unlock").send({ pin: "0000" });
    }
    const res = await request(app).post("/api/buddy/unlock").send({ pin: "0000" });
    expect(res.status).toBe(429);
    expect(res.body.error).toBe("locked");
    expect(res.body.retryAfterSec).toBeGreaterThan(0);
    expect(res.headers["retry-after"]).toBeDefined();
  });

  it("works with null pin (unlocked mode)", async () => {
    const a = express();
    a.use(express.json());
    const unlockedLock = new BuddyLock({ pin: null });
    registerBuddyRoutes(a, { db, httpsPort: 3000, lock: unlockedLock, chatEnabled: true, logger: silentLogger() });
    const res = await request(a).post("/api/buddy/unlock").send({ pin: "anything" });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});

// --- GET /api/pair ---------------------------------------------------

describe("GET /api/pair", () => {
  it("returns default child + serverUrl with the configured port (regression: was `undefined`)", async () => {
    const res = await request(app).get("/api/pair");
    expect(res.status).toBe(200);
    // Default child is seeded by migrateSchema.
    expect(res.body.childId).toBe("default");
    expect(res.body.name).toBeTruthy();
    expect(res.body.grade).toBeTruthy();
    // Bug regression: serverUrl must include the explicit port,
    // not "undefined". We test by asserting the URL ends with the
    // port we passed in (3000).
    expect(res.body.serverUrl).toMatch(/:3000$/);
    expect(res.body.serverUrl).not.toMatch(/undefined/);
  });

  it("serverUrl uses the request's protocol (defaults to http in supertest)", async () => {
    // The route uses req.protocol verbatim. supertest's default
    // protocol is "http", so we assert http://…; the integration
    // test in app.test.ts checks the full URL shape.
    const res = await request(app).get("/api/pair");
    expect(res.body.serverUrl).toMatch(/^http:\/\//);
  });
});

// --- POST /api/child/rename ------------------------------------------

describe("POST /api/child/rename", () => {
  it("renames the default child and returns 200 with new name", async () => {
    const res = await request(app)
      .post("/api/child/rename")
      .send({ name: "大宝" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ childId: "default", name: "大宝" });

    // Verify it actually changed in the DB.
    const row = db.prepare("SELECT name FROM children WHERE id = 'default'").get() as { name: string };
    expect(row.name).toBe("大宝");
  });

  it("trims whitespace from the name", async () => {
    const res = await request(app)
      .post("/api/child/rename")
      .send({ name: "  小宝  " });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe("小宝");
  });

  it("returns 400 when name is empty or > 10 chars", async () => {
    const r1 = await request(app).post("/api/child/rename").send({ name: "" });
    expect(r1.status).toBe(400);

    const r2 = await request(app).post("/api/child/rename").send({ name: "十一二三四五六七八九十" });
    expect(r2.status).toBe(400);
  });

  it("returns 404 when childId does not exist", async () => {
    const res = await request(app)
      .post("/api/child/rename")
      .send({ childId: "ghost", name: "小宝" });
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/child not found/);
  });

  it("allows renaming a non-default child by id", async () => {
    db.prepare("INSERT INTO children (id, name, grade) VALUES (?, ?, ?)").run("c2", "豆豆", "一年级");
    const res = await request(app)
      .post("/api/child/rename")
      .send({ childId: "c2", name: "豆豆改名" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ childId: "c2", name: "豆豆改名" });
  });
});
