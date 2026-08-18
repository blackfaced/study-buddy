// server/src/mistake-review.test.ts
//
// Tests for POST /api/game/mistake-review (#34a-3, issue #100).
// Each correct review increments reviewed_count via CAS; when the count
// reaches 3 the row is cascade-deleted. Wrong answers are no-ops.
// Cross-child isolation: alice can never touch bob's mistakes.

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
let testSessionId: string;

const CHILD = "default";
const OTHER_CHILD = "alice";

/** Insert a fresh mistake with reviewed_count = 0 and a specific child.
 *
 * SB124-T01 PR-D: writes the canonical mistake_case + correction_obligation
 * (with the requested reviewed_count) so the T3 review endpoint can
 * CAS UPDATE correction_obligations.reviewed_count. mistakes is a
 * thin mirror kept for mistake_photo FKs.
 */
function seedMistake(problem: string, childId: string = CHILD, reviewedCount: number = 0): number {
  const now = Date.now();
  const caseId = `case:test-${problem}-${now}`;
  const mistakeResult = db.prepare(
    `INSERT INTO mistakes
       (session_id, child_id, ts, problem, user_answer, correct_answer, error_type, source, reviewed_count)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    testSessionId,
    childId,
    now,
    problem,
    "1",
    "2",
    "compute",
    "candy-math-island",
    reviewedCount,
  );
  const mistakeId = Number(mistakeResult.lastInsertRowid);
  db.prepare(`
    INSERT INTO mistake_cases (
      case_id, original_mistake_id, child_id, source, opened_at,
      session_id, ts, problem, error_type, level, user_answer, correct_answer
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    caseId, mistakeId, childId, "candy-math-island", now,
    testSessionId, now, problem, "compute", 1, "1", "2",
  );
  db.prepare(`
    INSERT INTO learning_attempts (
      attempt_id, case_id, attempt_kind, mistake_id, child_id,
      problem, user_answer, correct_answer, is_correct, occurred_at, source
    ) VALUES (?, ?, 'original', ?, ?, ?, ?, ?, 0, ?, ?)
  `).run(
    `attempt:${caseId}`, caseId, mistakeId, childId,
    problem, "1", "2", now, "candy-math-island",
  );
  db.prepare(`
    INSERT INTO correction_obligations (case_id, status, opened_at, reviewed_count)
    VALUES (?, 'open', ?, ?)
  `).run(caseId, now, reviewedCount);
  return mistakeId;
}

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "study-buddy-mistake-review-"));
  db = new Database(join(tmpDir, "test.db"));
  db.pragma("journal_mode = WAL");
  migrateSchema(db);
  // FK on mistakes.session_id → sessions.id; seed a real session.
  testSessionId = "test-session-1";
  db.prepare("INSERT OR IGNORE INTO children (id, name) VALUES (?, ?)").run(
    "alice",
    "Alice",
  );
  db.prepare(
    "INSERT INTO sessions (id, child_id, subject) VALUES (?, ?, ?)",
  ).run(testSessionId, CHILD, "math");
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

describe("POST /api/game/mistake-review (issue #100: 3-correct cascade delete)", () => {
  it("REV1: 0 → 1 increment on first correct review", async () => {
    const id = seedMistake("rev-1-7+5");
    const res = await request(app)
      .post("/api/game/mistake-review")
      .send({ childId: CHILD, results: [{ mistakeId: id, correct: true }] });
    expect(res.status).toBe(200);
    expect(res.body.reviews).toHaveLength(1);
    expect(res.body.reviews[0].mistakeId).toBe(id);
    expect(res.body.reviews[0].reviewedCount).toBe(1);
    expect(res.body.reviews[0].deleted).toBe(false);
  });

  it("REV2: 1 → 2 increment on second correct review", async () => {
    const id = seedMistake("rev-2-7+5", CHILD, 1);
    const res = await request(app)
      .post("/api/game/mistake-review")
      .send({ childId: CHILD, results: [{ mistakeId: id, correct: true }] });
    expect(res.status).toBe(200);
    expect(res.body.reviews[0].reviewedCount).toBe(2);
    expect(res.body.reviews[0].deleted).toBe(false);
  });

  it("REV3: 2 → 3 + cascade delete on third correct review", async () => {
    const id = seedMistake("rev-3-7+5", CHILD, 2);
    const res = await request(app)
      .post("/api/game/mistake-review")
      .send({ childId: CHILD, results: [{ mistakeId: id, correct: true }] });
    expect(res.status).toBe(200);
    expect(res.body.reviews[0].reviewedCount).toBe(3);
    expect(res.body.reviews[0].deleted).toBe(true);
    // PR-D: mistakes mirror is dropped; canonical case stays in
    // mistake_cases + correction_obligations(status=verified).
    const row = db.prepare("SELECT id FROM mistakes WHERE id = ?").get(id);
    expect(row).toBeUndefined();
    // Find the case_id for this mistake
    const caseRow = db
      .prepare("SELECT case_id FROM mistake_cases WHERE original_mistake_id = ?")
      .get(id) as { case_id: string };
    expect(db.prepare(
      "SELECT status FROM correction_obligations WHERE case_id = ?",
    ).get(caseRow.case_id)).toEqual({ status: "verified" });
    expect(db.prepare(
      "SELECT COUNT(*) AS count FROM learning_attempts WHERE case_id = ?",
    ).get(caseRow.case_id)).toEqual({ count: 2 });
  });

  it("REV4: already-verified obligation → idempotent no-op (status filter)", async () => {
    // PR-D: in the new world, the canonical case is in mistake_cases +
    // correction_obligations. After 3 corrects, status becomes 'verified'
    // and the picker filters it out. A 4th correct review is a no-op
    // because the T3 code path requires status='open' for the CAS UPDATE.
    const id = seedMistake("rev-4-7+5", CHILD, 3);
    // Pre-mark verified (simulates post-cascade state)
    const caseRow = db
      .prepare("SELECT case_id FROM mistake_cases WHERE original_mistake_id = ?")
      .get(id) as { case_id: string };
    db.prepare(
      "UPDATE correction_obligations SET status = 'verified', verified_at = ? WHERE case_id = ?",
    ).run(Date.now(), caseRow.case_id);
    const res = await request(app)
      .post("/api/game/mistake-review")
      .send({ childId: CHILD, results: [{ mistakeId: id, correct: true }] });
    expect(res.status).toBe(200);
    expect(res.body.reviews[0].deleted).toBe(false);
    // Reports the current reviewed_count (not 0 — the case is still there)
    expect(res.body.reviews[0].reviewedCount).toBe(3);
  });

  it("REV5: correct=false → no-op (no count change, no delete)", async () => {
    const id = seedMistake("rev-5-7+5", CHILD, 1);
    const res = await request(app)
      .post("/api/game/mistake-review")
      .send({ childId: CHILD, results: [{ mistakeId: id, correct: false }] });
    expect(res.status).toBe(200);
    expect(res.body.reviews[0].reviewedCount).toBe(1); // unchanged
    expect(res.body.reviews[0].deleted).toBe(false);
    // Row still exists
    const row = db.prepare("SELECT reviewed_count FROM mistakes WHERE id = ?").get(id) as
      | { reviewed_count: number }
      | undefined;
    expect(row?.reviewed_count).toBe(1);
  });

  it("REV6: cross-child isolation — alice cannot increment bob's mistake", async () => {
    const aliceId = seedMistake("rev-6-alice", CHILD, 0); // CHILD owns it
    // default tries to use 'alice' as childId — should be no-op
    const res = await request(app)
      .post("/api/game/mistake-review")
      .send({ childId: OTHER_CHILD, results: [{ mistakeId: aliceId, correct: true }] });
    expect(res.status).toBe(200);
    expect(res.body.reviews[0].reviewedCount).toBe(0);
    expect(res.body.reviews[0].deleted).toBe(false);
    // Row still exists with original count
    const row = db.prepare("SELECT reviewed_count FROM mistakes WHERE id = ?").get(aliceId) as
      | { reviewed_count: number }
      | undefined;
    expect(row?.reviewed_count).toBe(0);
  });

  it("REV7: batch — multiple results in one call, mix of correct/wrong/already-gone", async () => {
    const idCorrect = seedMistake("rev-7a", CHILD, 0);
    const idWrong = seedMistake("rev-7b", CHILD, 1);
    const idMissing = 99999; // never existed
    const res = await request(app)
      .post("/api/game/mistake-review")
      .send({
        childId: CHILD,
        results: [
          { mistakeId: idCorrect, correct: true },
          { mistakeId: idWrong, correct: false },
          { mistakeId: idMissing, correct: true },
        ],
      });
    expect(res.status).toBe(200);
    expect(res.body.reviews).toHaveLength(3);
    expect(res.body.reviews[0]).toMatchObject({ mistakeId: idCorrect, reviewedCount: 1, deleted: false });
    expect(res.body.reviews[1]).toMatchObject({ mistakeId: idWrong, reviewedCount: 1, deleted: false });
    expect(res.body.reviews[2]).toMatchObject({ mistakeId: idMissing, reviewedCount: 0, deleted: false });
  });

  it("REV8: missing childId field defaults to 'default' (backwards compat, matches T1 mistake endpoint)", async () => {
    const res = await request(app)
      .post("/api/game/mistake-review")
      .send({ results: [{ mistakeId: 99999, correct: true }] });
    // Same as /api/game/mistake: missing/empty childId collapses to "default".
    // mistakeId 99999 doesn't exist, so the no-op branch returns reviewedCount:0.
    expect(res.status).toBe(200);
    expect(res.body.reviews).toHaveLength(1);
    expect(res.body.reviews[0].reviewedCount).toBe(0);
  });

  it("REV9: missing results field returns 400", async () => {
    const res = await request(app)
      .post("/api/game/mistake-review")
      .send({ childId: CHILD });
    expect(res.status).toBe(400);
  });

  it("REV10: empty results array returns 200 with empty reviews array", async () => {
    const res = await request(app)
      .post("/api/game/mistake-review")
      .send({ childId: CHILD, results: [] });
    expect(res.status).toBe(200);
    expect(res.body.reviews).toEqual([]);
  });
});
