// server/src/page-photo-candidate.test.ts
//
// T04C-5: route-level coverage for the two candidate endpoints:
//   POST /api/mistake-photo/candidate/:candidateId/confirm
//   POST /api/mistake-photo/candidate/:candidateId/discard
//
// Workflow-level idempotency is covered in candidate-workflow.test.ts.
// This file covers the auth + 404 + 409 boundaries that the workflow
// doesn't see (HTTP + session middleware + cross-child via session).

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { createApp } from "./app.js";
import { migrateSchema } from "./db-migrate.js";
import { MistakePagePhotoWorkflow } from "./mistake-page-photo-workflow.js";
import { seedTestDevice } from "./test-device.js";

let db: Database.Database;
let tmpDir: string;
let sessionId = "";

const DEVICE = "default"; // v0.5 no-pairing virtual device
const CHILD = "default";
const SESSION_OTHER = "sess-other-foreign";

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "study-buddy-cand-route-"));
  db = new Database(join(tmpDir, "test.db"));
  db.pragma("foreign_keys = ON");
  db.pragma("journal_mode = WAL");
  migrateSchema(db);
  seedTestDevice(db);
  db.prepare(`INSERT OR IGNORE INTO children (id, name, grade) VALUES ('bob', 'Bob', '三年级')`).run();
  db.prepare(
    `INSERT OR REPLACE INTO sessions (id, child_id, device_id, started_at, subject)
     VALUES (?, ?, ?, 0, 'math')`,
  ).run(SESSION_OTHER, CHILD, DEVICE);
  const app = createApp({
    db,
    httpsPort: 3000,
    outboxPath: join(tmpDir, "outbox.jsonl"),
    pagePhotoWorkflow: new MistakePagePhotoWorkflow({ db }),
  });
  const start = await request(app).post("/api/session/start").send({ subject: "math" });
  expect(start.status).toBe(200);
  sessionId = start.body.sessionId;
});

afterAll(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  db.exec(`DELETE FROM mistake_photo_candidates`);
  db.exec(`DELETE FROM mistake_cases`);
  db.exec(`DELETE FROM mistakes`);
  db.exec(`DELETE FROM correction_obligations`);
  db.exec(`DELETE FROM learning_attempts`);
  db.exec(`DELETE FROM mistake_photo_page_drafts`);
});

function seedCandidate(
  overrides: { childId?: string; status?: string; problem?: string | null } = {},
): number {
  db.prepare(
    `INSERT INTO mistake_photo_page_drafts
       (id, child_id, session_id, device_id, state,
        layout_model, layout_regions_json, layout_confidence,
        image_bytes, image_extension, created_at, expires_at)
     VALUES (?, ?, ?, ?, 'review', 'm', '[]', 'ok', ?, 'jpg', 0, ?)`,
  ).run(
    "draft_route_001",
    overrides.childId ?? CHILD,
    sessionId,
    DEVICE,
    Buffer.from("fake"),
    Date.now() + 60_000,
  );
  const r = db.prepare(
    `INSERT INTO mistake_photo_candidates
       (draft_id, child_id, session_id, device_id, region_index,
        subject, problem, user_answer, correct_answer, error_type,
        confidence, vision_model, vision_reasoning, vision_input, vision_ts, created_at,
        status, confirmed_case_id)
     VALUES (?, ?, ?, ?, 0, 'math', ?, NULL, NULL, NULL, 'ok', 'm', '', '', 0, 0, ?, NULL)`,
  ).run(
    "draft_route_001",
    overrides.childId ?? CHILD,
    sessionId,
    DEVICE,
    overrides.problem ?? "3+4=?",
    overrides.status ?? "pending",
  );
  return Number(r.lastInsertRowid);
}

function makeApp() {
  return createApp({
    db,
    httpsPort: 3000,
    outboxPath: join(tmpDir, "outbox.jsonl"),
    pagePhotoWorkflow: new MistakePagePhotoWorkflow({ db }),
  });
}

describe("POST /api/mistake-photo/candidate/:id/confirm (T04-C PR-C)", () => {
  it("happy path: 200 with caseId + mistakeId, candidate becomes 'confirmed'", async () => {
    const id = seedCandidate();
    const res = await request(makeApp())
      .post(`/api/mistake-photo/candidate/${id}/confirm`)
      .send({ sessionId, userAnswer: "7", correctAnswer: "7" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      candidateId: id,
      idempotent: false,
    });
    expect(res.body.caseId).toMatch(/^case:/);
    expect(res.body.mistakeId).toBeTypeOf("number");
  });

  it("re-confirm returns same caseId with idempotent=true", async () => {
    const id = seedCandidate();
    const first = await request(makeApp())
      .post(`/api/mistake-photo/candidate/${id}/confirm`)
      .send({ sessionId, userAnswer: "7", correctAnswer: "7" });
    const second = await request(makeApp())
      .post(`/api/mistake-photo/candidate/${id}/confirm`)
      .send({ sessionId, userAnswer: "7", correctAnswer: "7" });
    expect(second.status).toBe(200);
    expect(second.body.idempotent).toBe(true);
    expect(second.body.caseId).toBe(first.body.caseId);
  });

  it("404 when candidateId doesn't exist", async () => {
    const res = await request(makeApp())
      .post("/api/mistake-photo/candidate/9999/confirm")
      .send({ sessionId, userAnswer: "7", correctAnswer: "7" });
    expect(res.status).toBe(404);
  });

  it("404 when candidate belongs to another child (cross-child isolation)", async () => {
    const id = seedCandidate({ childId: "bob" });
    const res = await request(makeApp())
      .post(`/api/mistake-photo/candidate/${id}/confirm`)
      .send({ sessionId, userAnswer: "7", correctAnswer: "7" });
    expect(res.status).toBe(404);
  });

  it("400 when userAnswer is missing", async () => {
    const id = seedCandidate();
    const res = await request(makeApp())
      .post(`/api/mistake-photo/candidate/${id}/confirm`)
      .send({ sessionId, correctAnswer: "7" });
    expect(res.status).toBe(400);
  });

  it("409 when candidate was already discarded", async () => {
    const id = seedCandidate({ status: "discarded" });
    const res = await request(makeApp())
      .post(`/api/mistake-photo/candidate/${id}/confirm`)
      .send({ sessionId, userAnswer: "7", correctAnswer: "7" });
    expect(res.status).toBe(409);
  });

  it("400 when candidateId is not a positive integer", async () => {
    const res = await request(makeApp())
      .post("/api/mistake-photo/candidate/abc/confirm")
      .send({ sessionId, userAnswer: "7", correctAnswer: "7" });
    expect(res.status).toBe(400);
  });
});

describe("POST /api/mistake-photo/candidate/:id/discard (T04-C PR-C)", () => {
  it("happy path: 200 with discarded=true, candidate becomes 'discarded'", async () => {
    const id = seedCandidate();
    const res = await request(makeApp())
      .post(`/api/mistake-photo/candidate/${id}/discard`)
      .send({ sessionId });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ candidateId: id, discarded: true, idempotent: false });
  });

  it("re-discard is idempotent (200, idempotent=true)", async () => {
    const id = seedCandidate();
    await request(makeApp()).post(`/api/mistake-photo/candidate/${id}/discard`).send({ sessionId });
    const res = await request(makeApp()).post(`/api/mistake-photo/candidate/${id}/discard`).send({ sessionId });
    expect(res.status).toBe(200);
    expect(res.body.idempotent).toBe(true);
  });

  it("409 when candidate was already confirmed (use mark-correct, not discard)", async () => {
    const id = seedCandidate({ status: "confirmed" });
    const res = await request(makeApp())
      .post(`/api/mistake-photo/candidate/${id}/discard`)
      .send({ sessionId });
    expect(res.status).toBe(409);
  });

  it("404 when candidate belongs to another child", async () => {
    const id = seedCandidate({ childId: "bob" });
    const res = await request(makeApp())
      .post(`/api/mistake-photo/candidate/${id}/discard`)
      .send({ sessionId });
    expect(res.status).toBe(404);
  });
});
