// server/src/capture-parent-summary.test.ts
//
// T09-2/3/4/5: route-level coverage for the parent summary endpoint.
// Verifies the shape, the safety constraints (no raw/OCR/credential
// fields in the response), and the cross-child isolation.

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
let app: ReturnType<typeof createApp>;
const CHILD = "default";
const CHILD_OTHER = "bob";

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "study-buddy-parent-summary-api-"));
  db = new Database(join(tmpDir, "test.db"));
  db.pragma("foreign_keys = ON");
  db.pragma("journal_mode = WAL");
  migrateSchema(db);
  db.prepare(`INSERT OR IGNORE INTO children (id, name, grade) VALUES (?, ?, ?)`)
    .run(CHILD, "小宝", "二年级");
  db.prepare(`INSERT OR IGNORE INTO children (id, name, grade) VALUES (?, ?, ?)`)
    .run(CHILD_OTHER, "Bob", "三年级");
  const { insertMistake } = await import("./routes/mistake-api.js");
  // Seed default child: 1 case (with original attempt auto-inserted)
  insertMistake(db, {
    childId: CHILD,
    problem: "3+4=?",
    userAnswer: "6",
    correctAnswer: "7",
    errorType: "borrow",
    source: "manual",
  });
  // Seed bob: 1 case
  insertMistake(db, {
    childId: CHILD_OTHER,
    problem: "5+5=?",
    userAnswer: "11",
    correctAnswer: "10",
    errorType: "compute",
    source: "manual",
  });
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
  // No DB cleanup needed — seed is fixed.
});

describe("GET /api/capture/parent-summary (T09 PR-C)", () => {
  it("T09-2: 200 with shape { childId, generatedAt, stats, recurringErrorObservations }", async () => {
    const res = await request(app)
      .get(`/api/capture/parent-summary?childId=${CHILD}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      childId: CHILD,
      generatedAt: expect.any(Number),
    });
    expect(res.body.stats).toMatchObject({
      newMistakes: expect.any(Number),
      pendingReview: expect.any(Number),
      alreadyCorrected: expect.any(Number),
      pendingReplay: expect.any(Number),
      reopened: expect.any(Number),
      evidenceGaps: expect.any(Number),
    });
    expect(Array.isArray(res.body.recurringErrorObservations)).toBe(true);
  });

  it("T09-3: response does NOT contain raw chat / OCR / vision / credential fields", async () => {
    const res = await request(app)
      .get(`/api/capture/parent-summary?childId=${CHILD}`);
    const blob = JSON.stringify(res.body);
    for (const banned of [
      "vision_input",
      "vision_reasoning",
      "image_path",
      "raw_response",
      "ocr_text",
      "BUDDY_PIN",
      "INTEGRATION_API_TOKEN",
      "credential_hash",
      "password",
    ]) {
      expect(blob.toLowerCase()).not.toContain(banned.toLowerCase());
    }
  });

  it("T09-4: cross-child isolation — bob's mistake does NOT appear in default summary", async () => {
    const res = await request(app)
      .get(`/api/capture/parent-summary?childId=${CHILD}`);
    expect(res.status).toBe(200);
    // Default child has 1 case (newMistakes=1). If bob leaked, it'd be 2.
    expect(res.body.stats.newMistakes).toBe(1);
    // Bob's "compute" errorType must not appear in default's recurring list.
    const computeObs = res.body.recurringErrorObservations.find(
      (o: { errorType: string }) => o.errorType === "compute",
    );
    expect(computeObs).toBeUndefined();
  });

  it("400 when childId is missing", async () => {
    const res = await request(app).get("/api/capture/parent-summary");
    expect(res.status).toBe(400);
  });
});
