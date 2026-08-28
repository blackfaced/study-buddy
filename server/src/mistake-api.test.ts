// server/src/mistake-api.test.ts
//
// Tests for POST /api/game/mistake (#34a-1, issue #98) — the compat
// adapter for legacy game clients (candy-math-island, multiplication-
// drill). The endpoint records a wrong answer via insertMistake():
// deduped per (child_id, problem, source='game') via mistake_cases —
// multiple wrong answers to the same problem return the same row, not
// new rows.
//
// SB124-T10 briefly retired this route to 410; that was reversed
// because the only production clients still call it and silently drop
// data on non-2xx. The adapter is the long-lived contract.

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

describe("POST /api/game/mistake (compat adapter over insertMistake)", () => {
  it("records a wrong answer: 201 + mistake_cases row + open obligation + original attempt", async () => {
    const res = await request(app)
      .post("/api/game/mistake")
      .send({
        childId: "default",
        problem: "adapter-3+4",
        correctAnswer: "7",
        userAnswer: "6",
        errorType: "borrow",
      });
    expect(res.status).toBe(201);
    expect(res.body.created).toBe(true);
    expect(typeof res.body.id).toBe("number");
    expect(typeof res.body.caseId).toBe("string");

    const caseRow = db
      .prepare(
        "SELECT child_id, problem, user_answer, correct_answer, error_type, source FROM mistake_cases WHERE case_id = ?",
      )
      .get(res.body.caseId) as
      | {
          child_id: string;
          problem: string;
          user_answer: string;
          correct_answer: string;
          error_type: string;
          source: string;
        }
      | undefined;
    expect(caseRow).toMatchObject({
      child_id: "default",
      problem: "adapter-3+4",
      user_answer: "6",
      correct_answer: "7",
      error_type: "borrow",
      source: "game",
    });

    const obligation = db
      .prepare("SELECT status FROM correction_obligations WHERE case_id = ?")
      .get(res.body.caseId) as { status: string } | undefined;
    expect(obligation?.status).toBe("open");

    const attempt = db
      .prepare(
        "SELECT attempt_kind, is_correct, user_answer FROM learning_attempts WHERE case_id = ?",
      )
      .get(res.body.caseId) as
      | { attempt_kind: string; is_correct: number; user_answer: string }
      | undefined;
    expect(attempt).toMatchObject({
      attempt_kind: "original",
      is_correct: 0,
      user_answer: "6",
    });
  });

  it("same problem again → 200 created:false (idempotent retry)", async () => {
    const res = await request(app)
      .post("/api/game/mistake")
      .send({
        childId: "default",
        problem: "adapter-3+4",
        correctAnswer: "7",
        userAnswer: "6",
        errorType: "borrow",
      });
    expect(res.status).toBe(200);
    expect(res.body.created).toBe(false);
    const first = db
      .prepare("SELECT case_id FROM mistake_cases WHERE problem = ?")
      .get("adapter-3+4") as { case_id: string };
    expect(res.body.caseId).toBe(first.case_id);
    // No second original attempt was written.
    const attempts = db
      .prepare(
        "SELECT COUNT(*) AS n FROM learning_attempts WHERE case_id = ? AND attempt_kind = 'original'",
      )
      .get(first.case_id) as { n: number };
    expect(attempts.n).toBe(1);
  });

  it("missing problem → 400", async () => {
    const res = await request(app)
      .post("/api/game/mistake")
      .send({ childId: "default", userAnswer: "6" });
    expect(res.status).toBe(400);
  });

  it("errorType is optional", async () => {
    const res = await request(app)
      .post("/api/game/mistake")
      .send({
        childId: "default",
        problem: "adapter-9-2",
        userAnswer: "6",
        correctAnswer: "7",
      });
    expect(res.status).toBe(201);
    expect(res.body.created).toBe(true);
    const caseRow = db
      .prepare("SELECT error_type FROM mistake_cases WHERE case_id = ?")
      .get(res.body.caseId) as { error_type: string | null };
    expect(caseRow.error_type).toBeNull();
  });
});
