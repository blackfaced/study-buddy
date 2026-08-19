// server/src/manual-mistake.test.ts
//
// Tests for SB124-T03 (#127) manual mistake capture. The endpoint
// lets a kid or parent type a problem directly (no VLM, no photo) and
// still get the same closure-loop treatment as game mistakes.
//
// POST /api/capture/manual — manual mistake entry
// GET  /api/capture/inbox  — open correction obligations per child
//
// Both endpoints share the source-of-truth schema (mistake_cases +
// learning_attempts + correction_obligations, post SB124-T01). The only
// difference vs /api/game/mistake is: source='manual' (so dedupe is
// scoped per capture mode), subject is a required field, userAnswer is
// required (the parent must commit a typed answer).

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

const CHILD = "default";
const OTHER_CHILD = "bob";

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "study-buddy-manual-mistake-"));
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

describe("POST /api/capture/manual (SB124-T03 #127: 手动录入进收件箱)", () => {
  it("MM1: 201 with caseId when all required fields present", async () => {
    const res = await request(app)
      .post("/api/capture/manual")
      .send({
        childId: CHILD,
        problem: "8+5",
        userAnswer: "12",
        correctAnswer: "13",
        subject: "math",
      });
    expect(res.status).toBe(201);
    expect(typeof res.body.id).toBe("number");
    expect(typeof res.body.caseId).toBe("string");
    expect(res.body.created).toBe(true);
    // subject is persisted on the case row
    const row = db.prepare(
      "SELECT subject FROM mistake_cases WHERE case_id = ?",
    ).get(res.body.caseId) as { subject: string | null };
    expect(row.subject).toBe("math");
  });

  it("MM2: 400 when problem is missing", async () => {
    const res = await request(app)
      .post("/api/capture/manual")
      .send({ childId: CHILD, userAnswer: "x", correctAnswer: "y", subject: "math" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/problem/i);
  });

  it("MM3: 400 when userAnswer is empty (parent must commit a typed answer)", async () => {
    const res = await request(app)
      .post("/api/capture/manual")
      .send({ childId: CHILD, problem: "1+1", userAnswer: "", correctAnswer: "2", subject: "math" });
    expect(res.status).toBe(400);
  });

  it("MM4: 400 when correctAnswer is missing (no 'I don't know' path — keep it actionable)", async () => {
    const res = await request(app)
      .post("/api/capture/manual")
      .send({ childId: CHILD, problem: "1+1", userAnswer: "3", subject: "math" });
    expect(res.status).toBe(400);
  });

  it("MM5: 400 when subject is missing", async () => {
    const res = await request(app)
      .post("/api/capture/manual")
      .send({ childId: CHILD, problem: "1+1", userAnswer: "3", correctAnswer: "2" });
    expect(res.status).toBe(400);
  });

  it("MM6: optional errorType is accepted but not required", async () => {
    const res = await request(app)
      .post("/api/capture/manual")
      .send({
        childId: CHILD,
        problem: "err-type-optional",
        userAnswer: "12",
        correctAnswer: "13",
        subject: "math",
        errorType: "compute",
      });
    expect(res.status).toBe(201);
  });

  it("MM7: idempotent — same (child, problem) twice returns 200 with created=false", async () => {
    const first = await request(app)
      .post("/api/capture/manual")
      .send({
        childId: CHILD,
        problem: "idempotent-1",
        userAnswer: "12",
        correctAnswer: "13",
        subject: "math",
      });
    expect(first.status).toBe(201);
    const dup = await request(app)
      .post("/api/capture/manual")
      .send({
        childId: CHILD,
        problem: "idempotent-1",
        userAnswer: "12",
        correctAnswer: "13",
        subject: "math",
      });
    expect(dup.status).toBe(200);
    expect(dup.body.created).toBe(false);
    expect(dup.body.id).toBe(first.body.id);
    expect(dup.body.caseId).toBe(first.body.caseId);
  });

  it("MM8: cross-child isolation — bob's manual entry is separate from default's", async () => {
    const a = await request(app)
      .post("/api/capture/manual")
      .send({
        childId: CHILD,
        problem: "cross-child-manual",
        userAnswer: "11",
        correctAnswer: "12",
        subject: "math",
      });
    const b = await request(app)
      .post("/api/capture/manual")
      .send({
        childId: OTHER_CHILD,
        problem: "cross-child-manual",
        userAnswer: "11",
        correctAnswer: "12",
        subject: "math",
      });
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(a.body.id).not.toBe(b.body.id);
    expect(a.body.caseId).not.toBe(b.body.caseId);
  });

  it("MM9: manual source doesn't collide with game source for the same (child, problem)", async () => {
    // PR #146/148 source-of-truth dedupe uses (child_id, problem, source).
    // So a manual entry and a game entry with the same problem coexist
    // as separate cases — the parent is allowed to log the same problem
    // through different capture paths.
    const game = await request(app)
      .post("/api/game/mistake")
      .send({
        childId: CHILD,
        problem: "shared-problem-source",
        userAnswer: "1",
        correctAnswer: "2",
        errorType: "compute",
      });
    const manual = await request(app)
      .post("/api/capture/manual")
      .send({
        childId: CHILD,
        problem: "shared-problem-source",
        userAnswer: "1",
        correctAnswer: "2",
        subject: "math",
      });
    expect(game.status).toBe(201);
    expect(manual.status).toBe(201);
    expect(game.body.caseId).not.toBe(manual.body.caseId);
  });

  it("MM10: 400 when text fields exceed source contract bounds", async () => {
    const long = "x".repeat(201);
    const res = await request(app)
      .post("/api/capture/manual")
      .send({
        childId: CHILD,
        problem: long,
        userAnswer: "x",
        correctAnswer: "y",
        subject: "math",
      });
    expect(res.status).toBe(400);
  });
});

describe("GET /api/capture/inbox (SB124-T03 #127: 今日收件箱按孩子隔离)", () => {
  it("IN1: returns open correction obligations for the child, across all sources", async () => {
    // Seed one manual case (problem A) and one game case (problem B),
    // then ask the inbox to list both.
    await request(app)
      .post("/api/capture/manual")
      .send({
        childId: CHILD,
        problem: "inbox-A",
        userAnswer: "11",
        correctAnswer: "12",
        subject: "math",
      });
    await request(app)
      .post("/api/game/mistake")
      .send({
        childId: CHILD,
        problem: "inbox-B",
        userAnswer: "1",
        correctAnswer: "2",
        errorType: "compute",
      });
    const res = await request(app)
      .get("/api/capture/inbox")
      .query({ childId: CHILD });
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.cases)).toBe(true);
    const problems = (res.body.cases as Array<{ problem: string }>).map((c) => c.problem);
    expect(problems).toContain("inbox-A");
    expect(problems).toContain("inbox-B");
    // Each entry has the fields the portal needs to render
    for (const c of res.body.cases) {
      expect(typeof c.caseId).toBe("string");
      expect(typeof c.problem).toBe("string");
      expect(typeof c.source).toBe("string");
      expect(c.reviewedCount).toBe(0);
      expect(c.status).toBe("open");
    }
  });

  it("IN2: verified obligations are excluded (kid doesn't see them again)", async () => {
    // Capture a case, then mark it verified via the T3 review path
    // (3 correct reviews = verified + delete mirror).
    const create = await request(app)
      .post("/api/capture/manual")
      .send({
        childId: CHILD,
        problem: "inbox-verified",
        userAnswer: "11",
        correctAnswer: "12",
        subject: "math",
      });
    expect(create.status).toBe(201);
    // Three correct reviews cascade to verified
    for (let i = 0; i < 3; i++) {
      const r = await request(app)
        .post("/api/game/mistake-review")
        .send({
          childId: CHILD,
          results: [{ mistakeId: create.body.id, correct: true }],
        });
      expect(r.status).toBe(200);
    }
    const inbox = await request(app)
      .get("/api/capture/inbox")
      .query({ childId: CHILD });
    const problems = (inbox.body.cases as Array<{ problem: string }>).map((c) => c.problem);
    expect(problems).not.toContain("inbox-verified");
  });

  it("IN3: cross-child isolation — bob's inbox does not include default's manual entries", async () => {
    await request(app)
      .post("/api/capture/manual")
      .send({
        childId: CHILD,
        problem: "inbox-isolated",
        userAnswer: "11",
        correctAnswer: "12",
        subject: "math",
      });
    const bob = await request(app)
      .get("/api/capture/inbox")
      .query({ childId: OTHER_CHILD });
    const problems = (bob.body.cases as Array<{ problem: string }>).map((c) => c.problem);
    expect(problems).not.toContain("inbox-isolated");
  });

  it("IN4: missing childId defaults to 'default' (matches other endpoints)", async () => {
    // No explicit childId — server collapses to "default" same as the
    // other mistake endpoints. The empty-body guard at the top of the
    // handler makes this explicit.
    const res = await request(app).get("/api/capture/inbox");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.cases)).toBe(true);
  });
});
