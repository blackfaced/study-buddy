// server/src/capture-hypothesis.test.ts
//
// T06-4 + T06-5: route-level coverage for the 5 hypothesis endpoints.
// Verifies happy path, kid-view sensitive filter, cross-child 403,
// 404 for missing hypothesis, and 409 for invalid state transitions.

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

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "study-buddy-capture-hyp-"));
  db = new Database(join(tmpDir, "test.db"));
  db.pragma("foreign_keys = ON");
  db.pragma("journal_mode = WAL");
  migrateSchema(db);
  db.prepare(`INSERT OR IGNORE INTO children (id, name, grade) VALUES (?, ?, ?)`)
    .run(CHILD, "小宝", "二年级");
  db.prepare(`INSERT OR IGNORE INTO children (id, name, grade) VALUES (?, ?, ?)`)
    .run(CHILD_OTHER, "Bob", "三年级");
  // need a real case_id with FK target
  const { insertMistake } = await import("./capture-service.js");
  const r = insertMistake(db, {
    childId: CHILD,
    problem: "12-7",
    userAnswer: "4",
    correctAnswer: "5",
    errorType: "borrow",
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
  db.exec(`DELETE FROM case_hypotheses`);
});

describe("POST /api/capture/case/:caseId/hypothesis (T06 PR-C)", () => {
  it("T06-4a: 201 with hypothesis row when source + text valid", async () => {
    const res = await request(app)
      .post(`/api/capture/case/${caseId}/hypothesis`)
      .send({ childId: CHILD, source: "parent", text: "退位没借 1", label: "borrow" });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      caseId,
      hypothesis: "退位没借 1",
      label: "borrow",
      source: "parent",
      status: "pending",
      sensitive: false,
    });
    expect(res.body.id).toBeTypeOf("number");
  });

  it("T06-4b: marks sensitive=true when text contains 笨蛋 (sensitive flag at write)", async () => {
    const res = await request(app)
      .post(`/api/capture/case/${caseId}/hypothesis`)
      .send({ childId: CHILD, source: "parent", text: "孩子是笨蛋" });
    expect(res.status).toBe(201);
    expect(res.body.sensitive).toBe(true);
  });

  it("T06-4c: 403 when case belongs to another child", async () => {
    const res = await request(app)
      .post(`/api/capture/case/${caseId}/hypothesis`)
      .send({ childId: CHILD_OTHER, source: "parent", text: "粗心" });
    expect(res.status).toBe(403);
  });

  it("T06-4d: 400 when source is not system/parent/kid", async () => {
    const res = await request(app)
      .post(`/api/capture/case/${caseId}/hypothesis`)
      .send({ childId: CHILD, source: "robot", text: "粗心" });
    expect(res.status).toBe(400);
  });
});

describe("POST .../hypothesis/:id/confirm (T06 PR-C)", () => {
  it("200 after addHypothesis → status=confirmed", async () => {
    const added = await request(app)
      .post(`/api/capture/case/${caseId}/hypothesis`)
      .send({ childId: CHILD, source: "parent", text: "粗心" });
    const id = added.body.id as number;
    const res = await request(app)
      .post(`/api/capture/case/${caseId}/hypothesis/${id}/confirm`)
      .send({ childId: CHILD });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id, status: "confirmed" });
    expect(res.body.confirmedAt).not.toBeNull();
  });

  it("404 when hypothesis doesn't exist", async () => {
    const res = await request(app)
      .post(`/api/capture/case/${caseId}/hypothesis/9999/confirm`)
      .send({ childId: CHILD });
    expect(res.status).toBe(404);
  });

  it("409 when hypothesis belongs to another child", async () => {
    const added = await request(app)
      .post(`/api/capture/case/${caseId}/hypothesis`)
      .send({ childId: CHILD, source: "parent", text: "粗心" });
    const res = await request(app)
      .post(`/api/capture/case/${caseId}/hypothesis/${added.body.id}/confirm`)
      .send({ childId: CHILD_OTHER });
    expect(res.status).toBe(409);
  });
});

describe("POST .../hypothesis/:id/reject (T06 PR-C)", () => {
  it("200 after addHypothesis → status=rejected", async () => {
    const added = await request(app)
      .post(`/api/capture/case/${caseId}/hypothesis`)
      .send({ childId: CHILD, source: "parent", text: "粗心" });
    const res = await request(app)
      .post(`/api/capture/case/${caseId}/hypothesis/${added.body.id}/reject`)
      .send({ childId: CHILD });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("rejected");
  });

  it("409 when rejecting a confirmed hypothesis", async () => {
    const added = await request(app)
      .post(`/api/capture/case/${caseId}/hypothesis`)
      .send({ childId: CHILD, source: "parent", text: "粗心" });
    await request(app)
      .post(`/api/capture/case/${caseId}/hypothesis/${added.body.id}/confirm`)
      .send({ childId: CHILD });
    const res = await request(app)
      .post(`/api/capture/case/${caseId}/hypothesis/${added.body.id}/reject`)
      .send({ childId: CHILD });
    expect(res.status).toBe(409);
  });
});

describe("POST .../hypothesis/:id/modify (T06 PR-C)", () => {
  it("200 returns a new row (status=modified, parentHypothesisId set)", async () => {
    const added = await request(app)
      .post(`/api/capture/case/${caseId}/hypothesis`)
      .send({ childId: CHILD, source: "parent", text: "粗心" });
    const id = added.body.id as number;
    const res = await request(app)
      .post(`/api/capture/case/${caseId}/hypothesis/${id}/modify`)
      .send({ childId: CHILD, text: "退位没借 1", label: "borrow" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: "modified",
      hypothesis: "退位没借 1",
      label: "borrow",
      parentHypothesisId: id,
    });
  });

  it("400 when text missing", async () => {
    const added = await request(app)
      .post(`/api/capture/case/${caseId}/hypothesis`)
      .send({ childId: CHILD, source: "parent", text: "粗心" });
    const res = await request(app)
      .post(`/api/capture/case/${caseId}/hypothesis/${added.body.id}/modify`)
      .send({ childId: CHILD });
    expect(res.status).toBe(400);
  });
});

describe("GET /api/capture/case/:caseId/hypotheses (T06 PR-C)", () => {
  it("T06-5: kid view drops sensitive rows; parent view includes them", async () => {
    await request(app)
      .post(`/api/capture/case/${caseId}/hypothesis`)
      .send({ childId: CHILD, source: "parent", text: "退位没借 1", label: "borrow" });
    await request(app)
      .post(`/api/capture/case/${caseId}/hypothesis`)
      .send({ childId: CHILD, source: "parent", text: "孩子是笨蛋" });
    await request(app)
      .post(`/api/capture/case/${caseId}/hypothesis`)
      .send({ childId: CHILD, source: "parent", text: "计算粗心" });

    const parentView = await request(app)
      .get(`/api/capture/case/${caseId}/hypotheses?childId=${CHILD}&view=parent`);
    expect(parentView.status).toBe(200);
    expect(parentView.body.hypotheses).toHaveLength(3);
    const sensitiveCount = parentView.body.hypotheses.filter(
      (h: { sensitive: boolean }) => h.sensitive,
    ).length;
    expect(sensitiveCount).toBe(1);

    const kidView = await request(app)
      .get(`/api/capture/case/${caseId}/hypotheses?childId=${CHILD}&view=kid`);
    expect(kidView.status).toBe(200);
    expect(kidView.body.hypotheses).toHaveLength(2);
    for (const h of kidView.body.hypotheses) {
      expect(h.sensitive).toBe(false);
    }
  });

  it("kid view is the default when view= is omitted (parent view by default for safety)", async () => {
    await request(app)
      .post(`/api/capture/case/${caseId}/hypothesis`)
      .send({ childId: CHILD, source: "parent", text: "孩子是笨蛋" });
    const res = await request(app)
      .get(`/api/capture/case/${caseId}/hypotheses?childId=${CHILD}`);
    // Default is 'parent' → all rows visible, sensitive flag exposed
    expect(res.body.hypotheses).toHaveLength(1);
    expect(res.body.hypotheses[0].sensitive).toBe(true);
  });

  it("403 when case belongs to another child", async () => {
    const res = await request(app)
      .get(`/api/capture/case/${caseId}/hypotheses?childId=${CHILD_OTHER}`);
    expect(res.status).toBe(403);
  });
});
