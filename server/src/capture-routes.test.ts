// server/src/capture-routes.test.ts
//
// Method table lock for /api/capture/* routes (SB124 unified capture
// epic #158). 4 endpoints, each bound to a specific method:
//
//   POST /api/capture/manual
//   GET  /api/capture/inbox
//   GET  /api/capture/case/:caseId
//   POST /api/capture/case/:caseId/attempt
//
// If anyone refactors a route and accidentally swaps GET/POST, the
// wrong-method tests below fail loudly (404 "Cannot <METHOD> <PATH>"
// from Express default, not 405). This locks the method table so
// future schema or middleware changes don't silently break the
// client. Cross-child isolation is verified in manual-mistake.test.ts;
// here we only assert the method table + the happy paths on each route.

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
  tmpDir = mkdtempSync(join(tmpdir(), "study-buddy-capture-routes-"));
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

describe("CR · capture routes method table", () => {
  it("CR1: GET /api/capture/manual is NOT a valid route (only POST is)", async () => {
    const res = await request(app).get("/api/capture/manual");
    expect(res.status).toBe(404);
    expect(res.text).toContain("Cannot GET");
    expect(res.text).toContain("/api/capture/manual");
  });

  it("CR2: POST /api/capture/inbox is NOT a valid route (only GET is)", async () => {
    const res = await request(app).post("/api/capture/inbox");
    expect(res.status).toBe(404);
    expect(res.text).toContain("Cannot POST");
    expect(res.text).toContain("/api/capture/inbox");
  });

  it("CR3: POST /api/capture/case/:caseId is NOT a valid route (only GET is)", async () => {
    const res = await request(app).post("/api/capture/case/case:abc");
    expect(res.status).toBe(404);
    expect(res.text).toContain("Cannot POST");
  });

  it("CR4: GET /api/capture/case/:caseId/attempt is NOT a valid route (only POST is)", async () => {
    const res = await request(app).get("/api/capture/case/case:abc/attempt");
    expect(res.status).toBe(404);
    expect(res.text).toContain("Cannot GET");
  });
});

describe("CR · happy-path on each capture route", () => {
  it("CR5: POST /api/capture/manual with required fields → 201 {id, caseId, created:true}", async () => {
    const res = await request(app)
      .post("/api/capture/manual")
      .send({
        childId: CHILD,
        problem: "5+3",
        userAnswer: "7",
        correctAnswer: "8",
        subject: "math",
      });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ created: true });
    expect(res.body.id).toBeTypeOf("number");
    expect(res.body.caseId).toMatch(/^case:/);
  });

  it("CR6: POST /api/capture/manual missing problem → 400 {error}", async () => {
    const res = await request(app)
      .post("/api/capture/manual")
      .send({
        childId: CHILD,
        userAnswer: "7",
        correctAnswer: "8",
        subject: "math",
      });
    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty("error");
  });

  it("CR7: GET /api/capture/inbox → 200 { cases: [...] }", async () => {
    const res = await request(app).get(`/api/capture/inbox?childId=${CHILD}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.cases)).toBe(true);
  });

  it("CR8: GET /api/capture/case/:caseId with matching childId → 200 with case fields", async () => {
    // Create one to look up
    const created = await request(app)
      .post("/api/capture/manual")
      .send({
        childId: CHILD,
        problem: "9-4",
        userAnswer: "4",
        correctAnswer: "5",
        subject: "math",
      });
    const caseId = created.body.caseId as string;

    const res = await request(app).get(
      `/api/capture/case/${encodeURIComponent(caseId)}?childId=${CHILD}`,
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      caseId,
      childId: CHILD,
      problem: "9-4",
      userAnswer: "4",
      correctAnswer: "5",
      subject: "math",
    });
    expect(Array.isArray(res.body.attempts)).toBe(true);
  });

  it("CR9: GET /api/capture/case/:caseId with WRONG childId → 403 'case belongs to another child'", async () => {
    const created = await request(app)
      .post("/api/capture/manual")
      .send({
        childId: CHILD,
        problem: "6+2",
        userAnswer: "9",
        correctAnswer: "8",
        subject: "math",
      });
    const caseId = created.body.caseId as string;

    const res = await request(app).get(
      `/api/capture/case/${encodeURIComponent(caseId)}?childId=${OTHER_CHILD}`,
    );
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: "case belongs to another child" });
  });

  it("CR10: POST /api/capture/case/:caseId/attempt with correct answer → 200 verified", async () => {
    const created = await request(app)
      .post("/api/capture/manual")
      .send({
        childId: CHILD,
        problem: "12-7",
        userAnswer: "4",
        correctAnswer: "5",
        subject: "math",
      });
    const caseId = created.body.caseId as string;

    const res = await request(app)
      .post(`/api/capture/case/${encodeURIComponent(caseId)}/attempt`)
      .send({ childId: CHILD, answer: "5" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      caseId,
      isCorrect: true,
      obligationStatus: "verified",
    });
  });
});
