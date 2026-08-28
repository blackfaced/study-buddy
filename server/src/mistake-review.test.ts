// server/src/mistake-review.test.ts
//
// Tests for POST /api/game/mistake-review — the compat adapter for
// legacy game clients (candy-math-island sync-mistake-reviews.js,
// multiplication-drill). Each result resolves a case via
// mistake_cases.original_mistake_id and records a correction attempt
// through recordCorrectionAttempt():
//
//   correct=true  → correction attempt (is_correct=1) + obligation
//                   verified + legacy mistakes mirror deleted
//   correct=false → correction attempt (is_correct=0), obligation
//                   stays open
//   unknown mistakeId / child mismatch / already-verified → "skipped"
//
// Batch semantics: once the top-level body is well-formed the endpoint
// ALWAYS returns 200 with per-result statuses — clients drop their
// whole queue on any non-2xx, so a single bad row must not fail the
// batch. 400 is reserved for a malformed top-level body.
//
// SB124-T10 briefly retired this route to 410; that was reversed
// because the only production clients still call it and silently drop
// data on non-2xx.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { createApp } from "./app.js";
import { migrateSchema } from "./db-migrate.js";
import { seedTestDevice } from "./test-device.js";
import { MistakePagePhotoWorkflow } from "./mistake-page-photo-workflow.js";

let db: Database.Database;
let tmpDir: string;
let app: ReturnType<typeof createApp>;
const CHILD = "default";

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "study-buddy-mistake-review-"));
  db = new Database(join(tmpDir, "test.db"));
  db.pragma("foreign_keys = ON");
  migrateSchema(db);
  seedTestDevice(db);
  app = createApp({
    db,
    httpsPort: 3000,
    outboxPath: join(tmpDir, "outbox.jsonl"),
    pagePhotoWorkflow: new MistakePagePhotoWorkflow({ db }),
  });
});

afterAll(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

/** Seed a game mistake via the compat adapter; returns {id, caseId}. */
async function seedMistake(
  problem: string,
  childId = CHILD,
): Promise<{ id: number; caseId: string }> {
  const res = await request(app)
    .post("/api/game/mistake")
    .send({
      childId,
      problem,
      userAnswer: "6",
      correctAnswer: "7",
      errorType: "compute",
    });
  expect(res.status).toBe(201);
  return { id: res.body.id as number, caseId: res.body.caseId as string };
}

function obligationStatus(caseId: string): string {
  const row = db
    .prepare("SELECT status FROM correction_obligations WHERE case_id = ?")
    .get(caseId) as { status: string };
  return row.status;
}

function correctionAttempts(caseId: string): Array<{
  attempt_kind: string;
  is_correct: number;
  user_answer: string | null;
}> {
  return db
    .prepare(
      "SELECT attempt_kind, is_correct, user_answer FROM learning_attempts WHERE case_id = ? AND attempt_kind = 'correction'",
    )
    .all(caseId) as Array<{
    attempt_kind: string;
    is_correct: number;
    user_answer: string | null;
  }>;
}

describe("POST /api/game/mistake-review (compat adapter)", () => {
  it("correct review on an open case → 200 recorded + obligation verified + correction attempt is_correct=1", async () => {
    const { id, caseId } = await seedMistake("review-3+4");
    const res = await request(app)
      .post("/api/game/mistake-review")
      .send({
        childId: CHILD,
        results: [{ mistakeId: id, correct: true, userAnswer: "7" }],
      });
    expect(res.status).toBe(200);
    expect(res.body.results).toEqual([{ mistakeId: id, status: "recorded" }]);

    expect(obligationStatus(caseId)).toBe("verified");
    const attempts = correctionAttempts(caseId);
    expect(attempts).toHaveLength(1);
    expect(attempts[0].is_correct).toBe(1);
    expect(attempts[0].user_answer).toBe("7");
  });

  it("correct:false → attempt recorded is_correct=0, obligation stays open", async () => {
    const { id, caseId } = await seedMistake("review-8-5");
    const res = await request(app)
      .post("/api/game/mistake-review")
      .send({ childId: CHILD, results: [{ mistakeId: id, correct: false }] });
    expect(res.status).toBe(200);
    expect(res.body.results).toEqual([{ mistakeId: id, status: "recorded" }]);

    expect(obligationStatus(caseId)).toBe("open");
    const attempts = correctionAttempts(caseId);
    expect(attempts).toHaveLength(1);
    expect(attempts[0].is_correct).toBe(0);
    expect(attempts[0].user_answer).toBeNull();
  });

  it("unknown mistakeId → 200 with status skipped", async () => {
    const res = await request(app)
      .post("/api/game/mistake-review")
      .send({ childId: CHILD, results: [{ mistakeId: 999999, correct: true }] });
    expect(res.status).toBe(200);
    expect(res.body.results).toEqual([
      { mistakeId: 999999, status: "skipped" },
    ]);
  });

  it("childId mismatch → skipped (no attempt written)", async () => {
    const { id, caseId } = await seedMistake("review-2+2");
    const res = await request(app)
      .post("/api/game/mistake-review")
      .send({ childId: "other-kid", results: [{ mistakeId: id, correct: true }] });
    expect(res.status).toBe(200);
    expect(res.body.results).toEqual([{ mistakeId: id, status: "skipped" }]);

    expect(obligationStatus(caseId)).toBe("open");
    expect(correctionAttempts(caseId)).toHaveLength(0);
  });

  it("repeat correct review → skipped (idempotent, no duplicate attempt)", async () => {
    const { id, caseId } = await seedMistake("review-6+1");
    const first = await request(app)
      .post("/api/game/mistake-review")
      .send({ childId: CHILD, results: [{ mistakeId: id, correct: true }] });
    expect(first.body.results).toEqual([{ mistakeId: id, status: "recorded" }]);

    const second = await request(app)
      .post("/api/game/mistake-review")
      .send({ childId: CHILD, results: [{ mistakeId: id, correct: true }] });
    expect(second.status).toBe(200);
    expect(second.body.results).toEqual([{ mistakeId: id, status: "skipped" }]);

    expect(obligationStatus(caseId)).toBe("verified");
    expect(correctionAttempts(caseId)).toHaveLength(1);
  });

  it("malformed top-level body → 400", async () => {
    const res = await request(app)
      .post("/api/game/mistake-review")
      .send({ childId: CHILD });
    expect(res.status).toBe(400);
  });

  it("malformed entries are reported as skipped, not silently dropped", async () => {
    const { id } = await seedMistake("review-9+1");
    const res = await request(app)
      .post("/api/game/mistake-review")
      .send({
        childId: CHILD,
        results: [
          { mistakeId: "not-a-number", correct: true }, // non-number id
          { mistakeId: id, correct: "yes" }, // non-boolean correct
          { mistakeId: id, correct: true }, // valid
        ],
      });
    expect(res.status).toBe(200);
    expect(res.body.results).toEqual([
      { mistakeId: null, status: "skipped" },
      { mistakeId: id, status: "skipped" },
      { mistakeId: id, status: "recorded" },
    ]);
  });
});
