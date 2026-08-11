// server/src/mistake-api.test.ts
//
// Tests for POST /api/game/mistake (#34a-1, issue #98).
// The endpoint records a wrong answer as a mistake. UNIQUE (child_id, problem)
// dedupes the same problem for the same child — multiple wrong answers to
// the same problem return the same row, not new rows.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { createApp } from "./app.js";
import { migrateSchema } from "./db-migrate.js";

let db: Database.Database;
let app: ReturnType<typeof createApp>;
let tmpDir: string;

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "study-buddy-mistake-api-"));
  db = new Database(join(tmpDir, "test.db"));
  db.pragma("journal_mode = WAL");
  migrateSchema(db);
  app = createApp({
    db,
    httpsPort: 3000,
    outboxPath: join(tmpDir, "outbox.jsonl"),
  });
});

afterAll(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("POST /api/game/mistake (issue #98: auto-record wrong answers)", () => {
  // AT1: UNIQUE (child_id, problem) dedupes — same problem wrong 5 times = 1 row
  it("AT1: same child answering the same problem wrong 5 times still produces only 1 row, all calls return the same id", async () => {
    const ids: number[] = [];
    for (let i = 0; i < 5; i++) {
      const res = await request(app)
        .post("/api/game/mistake")
        .send({
          childId: "default",
          problem: "7+5",
          correctAnswer: "12",
          userAnswer: "11",
          errorType: "compute",
          source: "candy-math-island",
        });
      expect(res.status).toBeGreaterThanOrEqual(200);
      expect(res.status).toBeLessThan(300);
      ids.push(res.body.id);
    }
    // All 5 ids must be equal — UNIQUE constraint dedupes
    expect(new Set(ids).size).toBe(1);
    // DB has exactly 1 row
    const count = (db
      .prepare("SELECT COUNT(*) as c FROM mistakes WHERE child_id = ? AND problem = ?")
      .get("default", "7+5") as { c: number }).c;
    expect(count).toBe(1);
  });

  // AT2: cross-child isolation — two children, same problem, two rows
  it("AT2: two different children answering the same problem get two distinct rows", async () => {
    const resAlice = await request(app)
      .post("/api/game/mistake")
      .send({
        childId: "alice",
        problem: "9-4",
        correctAnswer: "5",
        userAnswer: "6",
        errorType: "borrow",
        source: "candy-math-island",
      });
    expect(resAlice.status).toBeGreaterThanOrEqual(200);
    expect(resAlice.status).toBeLessThan(300);
    const alice = resAlice.body;

    const resBob = await request(app)
      .post("/api/game/mistake")
      .send({
        childId: "bob",
        problem: "9-4",
        correctAnswer: "5",
        userAnswer: "6",
        errorType: "borrow",
        source: "candy-math-island",
      });
    expect(resBob.status).toBeGreaterThanOrEqual(200);
    expect(resBob.status).toBeLessThan(300);
    const bob = resBob.body;

    expect(alice.id).not.toBe(bob.id);
    const count = (db
      .prepare("SELECT COUNT(*) as c FROM mistakes WHERE problem = ?")
      .get("9-4") as { c: number }).c;
    expect(count).toBe(2);
  });

  // AT3: missing childId defaults to "default" (backwards compat with old clients)
  it("AT3: missing childId defaults to 'default'", async () => {
    const res = await request(app)
      .post("/api/game/mistake")
      .send({
        problem: "3*4",
        correctAnswer: "12",
        userAnswer: "10",
        errorType: "multiply",
        source: "candy-math-island",
      });
    // 3*4 is a fresh row (AT1 used 7+5, AT2 used 9-4), so first-time
    // insert → 201 + created:true. (Original TDD red had `200` here
    // which was a typo for the 2xx range — corrected during green
    // implementation to match the actual create/exists contract.)
    expect(res.status).toBe(201);
    expect(res.body.created).toBe(true);
    expect(typeof res.body.id).toBe("number");
    // Row is associated with "default" child
    const row = db
      .prepare("SELECT child_id FROM mistakes WHERE id = ?")
      .get(res.body.id) as { child_id: string };
    expect(row.child_id).toBe("default");
  });

  // AT4: validation — missing required fields returns 400
  it("AT4: missing problem field returns 400", async () => {
    const res = await request(app)
      .post("/api/game/mistake")
      .send({
        childId: "default",
        userAnswer: "11",
        source: "candy-math-island",
      });
    expect(res.status).toBe(400);
  });

  it("AT4b: missing userAnswer field returns 400", async () => {
    const res = await request(app)
      .post("/api/game/mistake")
      .send({
        childId: "default",
        problem: "1+1",
        source: "candy-math-island",
      });
    expect(res.status).toBe(400);
  });

  // AT5: idempotency — same call 2x returns 201 then 200, both with same id
  it("AT5: first call returns 201 + created:true, second call returns 200 + created:false, id is identical", async () => {
    const payload = {
      childId: "default",
      problem: "8+7",
      correctAnswer: "15",
      userAnswer: "14",
      errorType: "compute",
      source: "candy-math-island",
    };
    const res1 = await request(app).post("/api/game/mistake").send(payload);
    expect(res1.status).toBe(201);
    expect(res1.body.created).toBe(true);
    expect(typeof res1.body.id).toBe("number");

    const res2 = await request(app).post("/api/game/mistake").send(payload);
    expect(res2.status).toBe(200);
    expect(res2.body.created).toBe(false);
    expect(res2.body.id).toBe(res1.body.id);
  });

  it("canonicalizes client app labels to the game source category before dedupe", async () => {
    const payload = {
      childId: "default",
      problem: "6+8",
      correctAnswer: "14",
      userAnswer: "13",
      errorType: "compute",
    };

    const first = await request(app)
      .post("/api/game/mistake")
      .send({ ...payload, source: "game" });
    const retryFromNamedApp = await request(app)
      .post("/api/game/mistake")
      .send({ ...payload, source: "candy-math-island" });

    expect(first.status).toBe(201);
    expect(retryFromNamedApp.status).toBe(200);
    expect(retryFromNamedApp.body).toEqual({ id: first.body.id, created: false });

    const rows = db
      .prepare("SELECT id, source FROM mistakes WHERE child_id = ? AND problem = ?")
      .all("default", payload.problem) as Array<{ id: number; source: string }>;
    expect(rows).toEqual([{ id: first.body.id, source: "game" }]);
  });
});
