// server/src/capture-reinforcement.test.ts
//
// T07-5: route-level coverage for the 2 reinforcement endpoints.
// POST .../reinforcement starts an attempt (server generates a
// similar problem if the caller didn't supply one). POST
// /reinforcement/:id/answer submits the kid's answer.

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
let caseIdNonMath = "";
let app: ReturnType<typeof createApp>;

const CHILD = "default";
const CHILD_OTHER = "bob";

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "study-buddy-capture-reinforce-"));
  db = new Database(join(tmpDir, "test.db"));
  db.pragma("foreign_keys = ON");
  db.pragma("journal_mode = WAL");
  migrateSchema(db);
  db.prepare(`INSERT OR IGNORE INTO children (id, name, grade) VALUES (?, ?, ?)`)
    .run(CHILD, "小宝", "二年级");
  db.prepare(`INSERT OR IGNORE INTO children (id, name, grade) VALUES (?, ?, ?)`)
    .run(CHILD_OTHER, "Bob", "三年级");
  const { insertMistake } = await import("./capture-service.js");
  const math = insertMistake(db, {
    childId: CHILD,
    problem: "3+4=?",
    userAnswer: "6",
    correctAnswer: "7",
    errorType: "compute",
    source: "manual",
  });
  caseId = math.caseId;
  const nonMath = insertMistake(db, {
    childId: CHILD,
    problem: "鸡兔同笼 共35头94脚",
    userAnswer: "鸡23只兔12只",
    correctAnswer: "鸡23只兔12只",
    errorType: null,
    source: "manual",
  });
  caseIdNonMath = nonMath.caseId;
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
  db.exec(`DELETE FROM reinforcement_attempts`);
  db.exec(`DELETE FROM case_reinforcement_state`);
});

describe("POST /api/capture/case/:caseId/reinforcement (T07 PR-C)", () => {
  it("T07-5a: 201 with server-generated similar problem", async () => {
    const res = await request(app)
      .post(`/api/capture/case/${caseId}/reinforcement`)
      .send({ childId: CHILD });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      attemptIndex: 1,
      attemptsRemaining: 2,
    });
    expect(res.body.problem).toMatch(/^\d+\s*[+-]\s*\d+$/);
    expect(res.body.problem).not.toBe("3+4=?");
  });

  it("422 when case problem type isn't supported (e.g. word problem)", async () => {
    const res = await request(app)
      .post(`/api/capture/case/${caseIdNonMath}/reinforcement`)
      .send({ childId: CHILD });
    expect(res.status).toBe(422);
  });

  it("404 when case belongs to another child", async () => {
    const res = await request(app)
      .post(`/api/capture/case/${caseId}/reinforcement`)
      .send({ childId: CHILD_OTHER });
    expect(res.status).toBe(404);
  });

  it("409 after max attempts (default 3) reached", async () => {
    for (let i = 0; i < 3; i++) {
      await request(app)
        .post(`/api/capture/case/${caseId}/reinforcement`)
        .send({ childId: CHILD });
    }
    const res = await request(app)
      .post(`/api/capture/case/${caseId}/reinforcement`)
      .send({ childId: CHILD });
    expect(res.status).toBe(409);
    expect(res.body.attemptsRemaining).toBe(0);
  });
});

describe("POST /api/capture/reinforcement/:attemptId/answer (T07 PR-C)", () => {
  it("T07-5b: 200 with isCorrect=true on a correct answer", async () => {
    // For 2-operand add "a + b", the correct answer is a+b; we don't
    // echo the answer back, so we have to read from the workflow.
    // Quick path: ask the server to start another with a custom
    // problem where we DO know the answer.
    const custom = await request(app)
      .post(`/api/capture/case/${caseId}/reinforcement`)
      .send({ childId: CHILD, problem: "5+3=?", correctAnswer: "8" });
    const res = await request(app)
      .post(`/api/capture/reinforcement/${custom.body.attemptId}/answer`)
      .send({ userAnswer: "8" });
    expect(res.status).toBe(200);
    expect(res.body.isCorrect).toBe(true);
  });

  it("200 with isCorrect=false on a wrong answer", async () => {
    const custom = await request(app)
      .post(`/api/capture/case/${caseId}/reinforcement`)
      .send({ childId: CHILD, problem: "5+3=?", correctAnswer: "8" });
    const res = await request(app)
      .post(`/api/capture/reinforcement/${custom.body.attemptId}/answer`)
      .send({ userAnswer: "9" });
    expect(res.status).toBe(200);
    expect(res.body.isCorrect).toBe(false);
  });

  it("409 on re-submit (idempotency)", async () => {
    const custom = await request(app)
      .post(`/api/capture/case/${caseId}/reinforcement`)
      .send({ childId: CHILD, problem: "5+3=?", correctAnswer: "8" });
    await request(app)
      .post(`/api/capture/reinforcement/${custom.body.attemptId}/answer`)
      .send({ userAnswer: "8" });
    const res = await request(app)
      .post(`/api/capture/reinforcement/${custom.body.attemptId}/answer`)
      .send({ userAnswer: "9" });
    expect(res.status).toBe(409);
  });

  it("404 when attemptId doesn't exist", async () => {
    const res = await request(app)
      .post("/api/capture/reinforcement/9999/answer")
      .send({ userAnswer: "8" });
    expect(res.status).toBe(404);
  });
});
