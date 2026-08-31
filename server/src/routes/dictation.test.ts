// server/src/routes/dictation.test.ts
//
// Dictation task sets (默写任务集, issue #194 — first slice of the
// parent-operated loop #192). A set is pure task data: an ordered
// word list + one school-required sentence + playback counts.
// Creating / editing / retiring a set must NOT produce any Mistake
// Case / Learning Attempt / Correction Obligation (资源≠证据).
//
// Integration tests against the full app (same style as
// capture-routes.test.ts) with an in-memory SQLite db.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createApp } from "../app.js";
import { migrateSchema } from "../db-migrate.js";

let db: Database.Database;
let app: ReturnType<typeof createApp>;
let tmpDir: string;

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "study-buddy-dictation-"));
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

beforeEach(() => {
  db.prepare("DELETE FROM dictation_sets").run();
});

function closureTableCounts() {
  const count = (table: string) =>
    (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
  return {
    mistakeCases: count("mistake_cases"),
    learningAttempts: count("learning_attempts"),
    correctionObligations: count("correction_obligations"),
  };
}

describe("POST /api/dictation/sets + GET /api/dictation/sets (issue #194)", () => {
  it("parent creates a set; the kid list shows it with ordered words and default play counts", async () => {
    const res = await request(app)
      .post("/api/dictation/sets")
      .send({ words: ["苹果", "香蕉", "橘子"], sentence: "我爱吃水果。" });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      childId: "default",
      words: ["苹果", "香蕉", "橘子"],
      sentence: "我爱吃水果。",
      wordPlays: 2,
      sentencePlays: 3,
      status: "active",
    });
    expect(typeof res.body.id).toBe("string");

    // Kid view (default): the set is visible, order preserved.
    const list = await request(app).get("/api/dictation/sets");
    expect(list.status).toBe(200);
    expect(list.body.sets).toHaveLength(1);
    expect(list.body.sets[0].words).toEqual(["苹果", "香蕉", "橘子"]);
    expect(list.body.sets[0].id).toBe(res.body.id);
  });
});

describe("POST /api/dictation/sets/:id/retire (issue #194)", () => {
  it("a retired set disappears from the kid view but stays in the parent view", async () => {
    const created = await request(app)
      .post("/api/dictation/sets")
      .send({ words: ["春风", "夏雨"], sentence: "春风又绿江南岸。" });
    const id = created.body.id;

    const retired = await request(app).post(`/api/dictation/sets/${id}/retire`);
    expect(retired.status).toBe(200);
    expect(retired.body.status).toBe("retired");

    // Kid view: gone.
    const kidList = await request(app).get("/api/dictation/sets");
    expect(kidList.body.sets).toHaveLength(0);

    // Parent view: still there, marked retired.
    const parentList = await request(app).get("/api/dictation/sets?include=all");
    expect(parentList.body.sets).toHaveLength(1);
    expect(parentList.body.sets[0].status).toBe("retired");

    // Retiring again is a no-op, not an error.
    const again = await request(app).post(`/api/dictation/sets/${id}/retire`);
    expect(again.status).toBe(200);
    expect(again.body.status).toBe("retired");
  });

  it("retiring a missing set returns 404", async () => {
    const res = await request(app).post("/api/dictation/sets/dictation:nope/retire");
    expect(res.status).toBe(404);
  });
});

describe("POST /api/dictation/sets idempotency (issue #194)", () => {
  it("a network retry with the same idempotencyKey returns the same set, no duplicate", async () => {
    const payload = {
      words: ["明亮", "月光"],
      sentence: "床前明月光。",
      idempotencyKey: "parent-week-35-abc123",
    };
    const first = await request(app).post("/api/dictation/sets").send(payload);
    expect(first.status).toBe(201);

    // Simulated retry: the first response was lost on the network.
    const retry = await request(app).post("/api/dictation/sets").send(payload);
    expect(retry.status).toBe(200);
    expect(retry.body.id).toBe(first.body.id);

    const list = await request(app).get("/api/dictation/sets?include=all");
    expect(list.body.sets).toHaveLength(1);
  });
});

describe("PATCH /api/dictation/sets/:id (issue #194)", () => {
  it("parent edits words/sentence/play counts; the kid list reflects the change", async () => {
    const created = await request(app)
      .post("/api/dictation/sets")
      .send({ words: ["旧词"], sentence: "旧句子。" });
    const id = created.body.id;

    const edited = await request(app)
      .patch(`/api/dictation/sets/${id}`)
      .send({ words: ["新词一", "新词二"], sentencePlays: 5 });
    expect(edited.status).toBe(200);
    expect(edited.body.words).toEqual(["新词一", "新词二"]);
    expect(edited.body.sentence).toBe("旧句子。"); // untouched field kept
    expect(edited.body.wordPlays).toBe(2);        // default kept
    expect(edited.body.sentencePlays).toBe(5);    // per-set override
    expect(edited.body.updatedAt).toBeGreaterThanOrEqual(edited.body.createdAt);

    const list = await request(app).get("/api/dictation/sets");
    expect(list.body.sets[0].words).toEqual(["新词一", "新词二"]);
  });

  it("editing a missing set returns 404; invalid words returns 400", async () => {
    const missing = await request(app)
      .patch("/api/dictation/sets/dictation:nope")
      .send({ words: ["x"] });
    expect(missing.status).toBe(404);

    const created = await request(app)
      .post("/api/dictation/sets")
      .send({ words: ["词"], sentence: "句。" });
    const bad = await request(app)
      .patch(`/api/dictation/sets/${created.body.id}`)
      .send({ words: [] });
    expect(bad.status).toBe(400);
  });
});

describe("POST /api/dictation/sets validation (issue #194)", () => {
  it("rejects empty words, missing sentence and out-of-range play counts with 400", async () => {
    const cases = [
      { words: [], sentence: "句。" },
      { words: ["词"] },                                  // no sentence
      { words: ["词"], sentence: "" },
      { words: ["词"], sentence: "句。", wordPlays: 0 },
      { words: ["词"], sentence: "句。", sentencePlays: 2.5 },
    ];
    for (const body of cases) {
      const res = await request(app).post("/api/dictation/sets").send(body);
      expect(res.status).toBe(400);
    }
    expect(db.prepare("SELECT COUNT(*) AS n FROM dictation_sets").get()).toEqual({ n: 0 });
  });
});

describe("issue #194 AC3: task sets are pure task data (资源≠证据)", () => {
  it("create + edit + retire never writes a Mistake Case / Learning Attempt / Correction Obligation", async () => {
    const before = closureTableCounts();

    const created = await request(app)
      .post("/api/dictation/sets")
      .send({ words: ["证据", "隔离"], sentence: "资源不是证据。" });
    expect(created.status).toBe(201);
    await request(app)
      .patch(`/api/dictation/sets/${created.body.id}`)
      .send({ sentence: "改过的句子。" });
    await request(app).post(`/api/dictation/sets/${created.body.id}/retire`);

    expect(closureTableCounts()).toEqual(before);
  });
});
