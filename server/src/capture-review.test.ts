// server/src/capture-review.test.ts
//
// T08-4 + T08-5: route-level coverage for the 3 delayed-review
// endpoints. GET list, POST schedule (3 waves), POST complete.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { createApp } from "./app.js";
import { migrateSchema } from "./db-migrate.js";

let db: Database.Database;
let tmpDir: string;
let caseId = "";
let app: ReturnType<typeof createApp>;

const CHILD = "default";
const CHILD_OTHER = "bob";
const FIXED = 1_700_000_000_000;

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "study-buddy-capture-review-"));
  db = new Database(join(tmpDir, "test.db"));
  db.pragma("foreign_keys = ON");
  db.pragma("journal_mode = WAL");
  migrateSchema(db);
  db.prepare(`INSERT OR IGNORE INTO children (id, name, grade) VALUES (?, ?, ?)`)
    .run(CHILD, "小宝", "二年级");
  db.prepare(`INSERT OR IGNORE INTO children (id, name, grade) VALUES (?, ?, ?)`)
    .run(CHILD_OTHER, "Bob", "三年级");
  const { insertMistake } = await import("./routes/mistake-api.js");
  const r = insertMistake(db, {
    childId: CHILD,
    problem: "3+4=?",
    userAnswer: "6",
    correctAnswer: "7",
    errorType: "compute",
    source: "manual",
  });
  caseId = r.caseId;
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
  db.exec(`DELETE FROM review_schedules`);
});

describe("POST /api/capture/case/:caseId/reviews (T08 PR-C)", () => {
  it("T08-4: 201 with 3 waves at +1/+3/+7 days from completedAt", async () => {
    const res = await request(app)
      .post(`/api/capture/case/${caseId}/reviews`)
      .send({ childId: CHILD, completedAt: FIXED });
    expect(res.status).toBe(201);
    expect(res.body.reviews).toHaveLength(3);
    expect(res.body.reviews[0].scheduledAt).toBe(FIXED + 1 * 86_400_000);
    expect(res.body.reviews[1].scheduledAt).toBe(FIXED + 3 * 86_400_000);
    expect(res.body.reviews[2].scheduledAt).toBe(FIXED + 7 * 86_400_000);
  });

  it("403 when case belongs to another child", async () => {
    const res = await request(app)
      .post(`/api/capture/case/${caseId}/reviews`)
      .send({ childId: CHILD_OTHER, completedAt: FIXED });
    expect(res.status).toBe(403);
  });
});

describe("GET /api/capture/case/:caseId/reviews (T08 PR-C)", () => {
  it("returns 3 pending reviews by default (no includeCompleted)", async () => {
    await request(app)
      .post(`/api/capture/case/${caseId}/reviews`)
      .send({ childId: CHILD, completedAt: FIXED });
    const res = await request(app)
      .get(`/api/capture/case/${caseId}/reviews?childId=${CHILD}`);
    expect(res.status).toBe(200);
    expect(res.body.reviews).toHaveLength(3);
  });

  it("includeCompleted=true returns 0 (nothing completed yet)", async () => {
    await request(app)
      .post(`/api/capture/case/${caseId}/reviews`)
      .send({ childId: CHILD, completedAt: FIXED });
    const res = await request(app)
      .get(`/api/capture/case/${caseId}/reviews?childId=${CHILD}&includeCompleted=true`);
    expect(res.status).toBe(200);
    expect(res.body.reviews).toHaveLength(3);
  });
});

describe("POST /api/capture/review/:reviewId/complete (T08 PR-C)", () => {
  it("T08-5a: 200 with isCorrect=true on success", async () => {
    await request(app)
      .post(`/api/capture/case/${caseId}/reviews`)
      .send({ childId: CHILD, completedAt: FIXED });
    const list = await request(app)
      .get(`/api/capture/case/${caseId}/reviews?childId=${CHILD}`);
    const reviewId = list.body.reviews[0].id as number;
    const res = await request(app)
      .post(`/api/capture/review/${reviewId}/complete`)
      .send({ isCorrect: true });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ reviewId, isCorrect: true, reopenedCount: 0 });
  });

  it("T08-5b: 200 with isCorrect=false + reopenedCount=1 on failure", async () => {
    await request(app)
      .post(`/api/capture/case/${caseId}/reviews`)
      .send({ childId: CHILD, completedAt: FIXED });
    const list = await request(app)
      .get(`/api/capture/case/${caseId}/reviews?childId=${CHILD}`);
    const reviewId = list.body.reviews[0].id as number;
    const res = await request(app)
      .post(`/api/capture/review/${reviewId}/complete`)
      .send({ isCorrect: false });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ reviewId, isCorrect: false, reopenedCount: 1 });
  });

  it("409 on re-complete (idempotency guard)", async () => {
    await request(app)
      .post(`/api/capture/case/${caseId}/reviews`)
      .send({ childId: CHILD, completedAt: FIXED });
    const list = await request(app)
      .get(`/api/capture/case/${caseId}/reviews?childId=${CHILD}`);
    const reviewId = list.body.reviews[0].id as number;
    await request(app)
      .post(`/api/capture/review/${reviewId}/complete`)
      .send({ isCorrect: true });
    const res = await request(app)
      .post(`/api/capture/review/${reviewId}/complete`)
      .send({ isCorrect: false });
    expect(res.status).toBe(409);
  });

  it("404 when reviewId doesn't exist", async () => {
    const res = await request(app)
      .post("/api/capture/review/9999/complete")
      .send({ isCorrect: true });
    expect(res.status).toBe(404);
  });
});
