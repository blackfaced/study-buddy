// server/src/review-workspace.test.ts
//
// Tests for SB124-T05 (#129) mistake review workspace. The kid opens
// a Mistake Case from the inbox, sees the problem + correct answer +
// attempt timeline, and independently re-solves. First correct closes
// the obligation; wrong attempts stay open.
//
// All endpoints share source-of-truth schema (mistake_cases +
// learning_attempts + correction_obligations, post SB124-T01).
//
// Privacy: the GET response must NOT leak vision_reasoning, image_path,
// or vision_input. Only the kid's own user_answer + is_correct on each
// attempt is exposed. The closure loop audit (parent/analytics) goes
// through source_events, not this endpoint.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { createApp } from "./app.js";
import { migrateSchema } from "./db-migrate.js";
import { insertMistake } from "./routes/mistake-api.js";

let db: Database.Database;
let app: ReturnType<typeof createApp>;
let tmpDir: string;

const CHILD = "default";
const OTHER_CHILD = "bob";

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "study-buddy-review-workspace-"));
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

/**
 * Helper: seed a manual mistake case with full evidence. Returns
 * { id, caseId } for use in subsequent tests.
 */
function seedManualCase(problem = "8+5", correctAnswer = "13", userAnswer = "12"): { id: number; caseId: string } {
  const result = insertMistake(db, {
    childId: CHILD,
    problem,
    userAnswer,
    correctAnswer,
    errorType: "compute",
    source: "manual",
    subject: "math",
  });
  return { id: result.id, caseId: result.caseId };
}

describe("GET /api/capture/case/:caseId (review workspace case detail)", () => {
  it("RC1: returns the case context + attempts timeline for the right child", async () => {
    const { caseId } = seedManualCase("RC1", "13", "12");
    const res = await request(app).get(`/api/capture/case/${caseId}`).query({ childId: CHILD });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      caseId,
      problem: "RC1",
      correctAnswer: "13",
      userAnswer: "12", // original wrong answer
      errorType: "compute",
      source: "manual",
      subject: "math",
      obligationStatus: "open",
      reviewedCount: 0,
    });
    expect(Array.isArray(res.body.attempts)).toBe(true);
    // Initial attempt (original) is always there
    expect(res.body.attempts).toEqual([
      expect.objectContaining({ kind: "original", isCorrect: false, userAnswer: "12" }),
    ]);
  });

  it("RC2: NEVER exposes vision_reasoning, image_path, or vision_input (privacy)", async () => {
    // Insert a vision-source case with a vision_reasoning value, and
    // verify the response shape omits all vision internals.
    const result = insertMistake(db, {
      childId: CHILD,
      problem: "RC2",
      userAnswer: "1",
      correctAnswer: "2",
      errorType: null,
      source: "vision",
      subject: "math",
    });
    db.prepare(
      "UPDATE mistake_cases SET vision_reasoning = ?, image_path = ?, vision_input = ? WHERE case_id = ?",
    ).run("这是模型推理的机密,绝不能泄漏", "/photos/secret.jpg", "base64-image-data", result.caseId);
    const res = await request(app).get(`/api/capture/case/${result.caseId}`).query({ childId: CHILD });
    expect(res.status).toBe(200);
    // The response MUST NOT contain any of these fields, even as undefined
    for (const banned of ["visionReasoning", "imagePath", "visionInput", "vision_reasoning", "image_path", "vision_input"]) {
      expect(res.body).not.toHaveProperty(banned);
    }
  });

  it("RC3: 404 when the case does not exist", async () => {
    const res = await request(app).get("/api/capture/case/case:does-not-exist").query({ childId: CHILD });
    expect(res.status).toBe(404);
  });

  it("RC4: 403 when the case belongs to another child (cross-child isolation)", async () => {
    const { caseId } = seedManualCase("RC4", "13", "12");
    const res = await request(app).get(`/api/capture/case/${caseId}`).query({ childId: OTHER_CHILD });
    expect(res.status).toBe(403);
  });

  it("RC5: 400 when childId is missing", async () => {
    const { caseId } = seedManualCase("RC5", "13", "12");
    const res = await request(app).get(`/api/capture/case/${caseId}`);
    expect(res.status).toBe(400);
  });

  it("RC6: timeline reflects existing correction attempts (sorted chronologically)", async () => {
    const { caseId } = seedManualCase("RC6", "13", "12");
    // Append a correction attempt
    await request(app)
      .post(`/api/capture/case/${caseId}/attempt`)
      .send({ childId: CHILD, answer: "11" }); // wrong
    await new Promise((r) => setTimeout(r, 5));
    await request(app)
      .post(`/api/capture/case/${caseId}/attempt`)
      .send({ childId: CHILD, answer: "13" }); // correct, closes
    const res = await request(app).get(`/api/capture/case/${caseId}`).query({ childId: CHILD });
    expect(res.body.attempts).toHaveLength(3);
    expect(res.body.attempts[0]).toMatchObject({ kind: "original", isCorrect: false });
    expect(res.body.attempts[1]).toMatchObject({ kind: "correction", isCorrect: false, userAnswer: "11" });
    expect(res.body.attempts[2]).toMatchObject({ kind: "correction", isCorrect: true, userAnswer: "13" });
    expect(res.body.obligationStatus).toBe("verified");
  });
});

describe("POST /api/capture/case/:caseId/attempt (kid review submission)", () => {
  it("RA1: wrong answer → record attempt, keep obligation open", async () => {
    const { caseId } = seedManualCase("RA1", "13", "12");
    const res = await request(app)
      .post(`/api/capture/case/${caseId}/attempt`)
      .send({ childId: CHILD, answer: "11" });
    expect(res.status).toBe(200);
    expect(res.body.isCorrect).toBe(false);
    expect(res.body.obligationStatus).toBe("open");
    // reviewed_count is NOT bumped (T05 doesn't use the 3-correct cascade)
    expect(res.body.reviewedCount).toBe(0);
    // A correction learning_attempt row was appended
    const attempts = db.prepare(
      "SELECT attempt_kind, is_correct, user_answer FROM learning_attempts WHERE case_id = ? ORDER BY occurred_at",
    ).all(caseId) as Array<{ attempt_kind: string; is_correct: number; user_answer: string | null }>;
    expect(attempts).toEqual([
      { attempt_kind: "original", is_correct: 0, user_answer: "12" },
      { attempt_kind: "correction", is_correct: 0, user_answer: "11" },
    ]);
  });

  it("RA2: first correct answer → record attempt, close obligation, preserve history", async () => {
    const { id, caseId } = seedManualCase("RA2", "13", "12");
    const res = await request(app)
      .post(`/api/capture/case/${caseId}/attempt`)
      .send({ childId: CHILD, answer: "13" });
    expect(res.status).toBe(200);
    expect(res.body.isCorrect).toBe(true);
    expect(res.body.obligationStatus).toBe("verified");
    expect(typeof res.body.verifiedAt).toBe("number");
    // History preserved (original + 1 correction)
    const attempts = db.prepare(
      "SELECT COUNT(*) AS count FROM learning_attempts WHERE case_id = ?",
    ).get(caseId) as { count: number };
    expect(attempts.count).toBe(2);
    // mistakes mirror is dropped (same as T3 closeObligation path)
    const row = db.prepare("SELECT id FROM mistakes WHERE id = ?").get(id);
    expect(row).toBeUndefined();
    // But mistake_cases is preserved
    const caseRow = db.prepare("SELECT case_id FROM mistake_cases WHERE case_id = ?").get(caseId);
    expect(caseRow).toBeDefined();
  });

  it("RA3: answer comparison is whitespace + case insensitive (typo tolerance)", async () => {
    const { caseId } = seedManualCase("RA3", "Thirteen", "twelve");
    // Trailing space + uppercase — should be considered correct
    const res = await request(app)
      .post(`/api/capture/case/${caseId}/attempt`)
      .send({ childId: CHILD, answer: "  THIRTEEN  " });
    expect(res.body.isCorrect).toBe(true);
  });

  it("RA4: 400 when the answer is empty or missing", async () => {
    const { caseId } = seedManualCase("RA4", "13", "12");
    const empty = await request(app)
      .post(`/api/capture/case/${caseId}/attempt`)
      .send({ childId: CHILD, answer: "" });
    expect(empty.status).toBe(400);
    const missing = await request(app)
      .post(`/api/capture/case/${caseId}/attempt`)
      .send({ childId: CHILD });
    expect(missing.status).toBe(400);
  });

  it("RA5: 403 when the case belongs to another child", async () => {
    const { caseId } = seedManualCase("RA5", "13", "12");
    const res = await request(app)
      .post(`/api/capture/case/${caseId}/attempt`)
      .send({ childId: OTHER_CHILD, answer: "13" });
    expect(res.status).toBe(403);
    // No learning_attempt row appended
    const count = (db.prepare(
      "SELECT COUNT(*) AS count FROM learning_attempts WHERE case_id = ?",
    ).get(caseId) as { count: number }).count;
    expect(count).toBe(1); // only the original
  });

  it("RA6: 200 no-op when the obligation is already verified (idempotent re-submit)", async () => {
    const { caseId } = seedManualCase("RA6", "13", "12");
    // First correct
    await request(app)
      .post(`/api/capture/case/${caseId}/attempt`)
      .send({ childId: CHILD, answer: "13" });
    // Second submit (race: another device already closed it)
    const res = await request(app)
      .post(`/api/capture/case/${caseId}/attempt`)
      .send({ childId: CHILD, answer: "13" });
    expect(res.status).toBe(200);
    expect(res.body.obligationStatus).toBe("verified");
    expect(res.body.isCorrect).toBe(true);
    // No new learning_attempt row (idempotent retry, current attempt_id is stable)
    const count = (db.prepare(
      "SELECT COUNT(*) AS count FROM learning_attempts WHERE case_id = ?",
    ).get(caseId) as { count: number }).count;
    expect(count).toBe(2); // original + first correct; no extra from second submit
  });

  it("RA7: restart resilience — closing obligation is DB-backed (SELECT on a fresh handle)", async () => {
    // Verify the obligation status is DB-backed by reading it through
    // a fresh Database handle. No need to close the test's connection
    // (that would break the closure-captured db reference in `app`).
    const { caseId } = seedManualCase("RA7", "13", "12");
    await request(app)
      .post(`/api/capture/case/${caseId}/attempt`)
      .send({ childId: CHILD, answer: "13" });
    const fresh = new Database(join(tmpDir, "test.db"), { readonly: true });
    const row = fresh
      .prepare("SELECT status FROM correction_obligations WHERE case_id = ?")
      .get(caseId) as { status: string };
    expect(row.status).toBe("verified");
    fresh.close();
  });

  it("RA8: wrong then correct → second attempt closes, both attempts recorded", async () => {
    const { caseId } = seedManualCase("RA8", "13", "12");
    const wrong = await request(app)
      .post(`/api/capture/case/${caseId}/attempt`)
      .send({ childId: CHILD, answer: "11" });
    expect(wrong.body.isCorrect).toBe(false);
    expect(wrong.body.obligationStatus).toBe("open");
    await new Promise((r) => setTimeout(r, 5));
    const correct = await request(app)
      .post(`/api/capture/case/${caseId}/attempt`)
      .send({ childId: CHILD, answer: "13" });
    expect(correct.body.isCorrect).toBe(true);
    expect(correct.body.obligationStatus).toBe("verified");
    // Timeline: original + wrong correction + correct correction.
    // attempt_id is a stable tiebreaker: `attempt:` < `review-self:`
    // alphabetically, so the original row always sorts first even when
    // both `Date.now()` calls land in the same ms.
    const attempts = db.prepare(
      "SELECT attempt_kind, is_correct FROM learning_attempts WHERE case_id = ? ORDER BY occurred_at, attempt_id",
    ).all(caseId) as Array<{ attempt_kind: string; is_correct: number }>;
    expect(attempts).toEqual([
      { attempt_kind: "original", is_correct: 0 },
      { attempt_kind: "correction", is_correct: 0 },
      { attempt_kind: "correction", is_correct: 1 },
    ]);
  });
});

describe("answersMatch helper (textual comparison)", () => {
  it("trims + collapses whitespace + case-insensitive", async () => {
    // Indirect test through the endpoint: same answer with different
    // formatting should still match
    const { caseId } = seedManualCase("AM1", "1+1=2", "2");
    const res = await request(app)
      .post(`/api/capture/case/${caseId}/attempt`)
      .send({ childId: CHILD, answer: "  1 + 1 = 2  " });
    expect(res.body.isCorrect).toBe(true);
  });
});
