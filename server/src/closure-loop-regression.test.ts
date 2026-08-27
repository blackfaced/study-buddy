// server/src/closure-loop-regression.test.ts
//
// T10-4: end-to-end smoke for the closure-loop replacement endpoints
// retired by SB124-T10 #134. Each retired endpoint has a documented
// replacement; this test exercises the replacements and the
// surrounding closure-loop surface so the integration is regression-
// safe.
//
// What's covered:
//   - manual capture → 3 correct attempts via /api/capture/case/:caseId/attempt
//     → case is verified → mirror row deleted by cascade → readArchivedMistake
//     returns null after the closure.
//   - 410 contract on the retired endpoints is re-asserted here so the
//     end-to-end story is "old = 410, new = 200, old = gone".
//
// What is NOT covered here (already covered elsewhere):
//   - per-route response shapes (capture-routes.test.ts, review-workspace.test.ts,
//     capture-review.test.ts, capture-reinforcement.test.ts)
//   - The audited `reviewed_count` scanner (audit-reviewed-count.test.ts)
//   - The diagnostic archived-mistake read (archived-mistake.test.ts)

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { createApp } from "./app.js";
import { migrateSchema } from "./db-migrate.js";
import { seedTestDevice } from "./test-device.js";
import { readArchivedMistake } from "./archived-mistake.js";

let db: Database.Database;
let app: ReturnType<typeof createApp>;
let tmpDir: string;
const CHILD = "default";

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "study-buddy-t10-regression-"));
  db = new Database(join(tmpDir, "test.db"));
  db.pragma("foreign_keys = ON");
  migrateSchema(db);
  seedTestDevice(db);
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

describe("T10 #134: closure-loop replacement smoke", () => {
  it("T10-4a: retired /api/game/mistake returns 410, replacement works end-to-end", async () => {
    // 1. Old endpoint: 410.
    const old = await request(app)
      .post("/api/game/mistake")
      .send({
        childId: CHILD,
        problem: "3+5",
        userAnswer: "7",
        correctAnswer: "8",
        errorType: "compute",
      });
    expect(old.status).toBe(410);
    expect(old.headers["x-sunset"]).toBe("2026-12-31");

    // 2. Replacement: POST /api/capture/manual creates the case.
    const create = await request(app)
      .post("/api/capture/manual")
      .send({
        childId: CHILD,
        problem: "smoke-3+5",
        userAnswer: "7",
        correctAnswer: "8",
        errorType: "compute",
        subject: "math",
      });
    expect(create.status).toBe(201);
    const caseId = create.body.caseId as string;
    const mistakeId = create.body.id as number;

    // 3. The new case is visible in the inbox.
    const inboxBefore = await request(app)
      .get("/api/capture/inbox")
      .query({ childId: CHILD });
    const problemsBefore = (inboxBefore.body.cases as Array<{ problem: string }>)
      .map((c) => c.problem);
    expect(problemsBefore).toContain("smoke-3+5");

    // 4. Three correct attempts close the obligation (T05's 1-correct
    //    path lives elsewhere; this is the original T3 cascade).
    for (let i = 0; i < 3; i++) {
      const r = await request(app)
        .post(`/api/capture/case/${caseId}/attempt`)
        .send({ childId: CHILD, answer: "8" });
      expect(r.status).toBe(200);
    }

    // 5. The case is no longer in the inbox (status='verified' is filtered).
    const inboxAfter = await request(app)
      .get("/api/capture/inbox")
      .query({ childId: CHILD });
    const problemsAfter = (inboxAfter.body.cases as Array<{ problem: string }>)
      .map((c) => c.problem);
    expect(problemsAfter).not.toContain("smoke-3+5");

    // 6. The T3 cascade deleted the legacy mistakes mirror row.
    expect(readArchivedMistake(db, mistakeId)).toBeNull();
  });

  it("T10-4b: retired /api/game/mistake-review returns 410, replacement closes the case", async () => {
    // 1. Old endpoint: 410.
    const old = await request(app)
      .post("/api/game/mistake-review")
      .send({
        childId: CHILD,
        results: [{ mistakeId: 1, correct: true }],
      });
    expect(old.status).toBe(410);
    expect(old.body.replacement).toBe("POST /api/capture/case/:caseId/attempt");

    // 2. Replacement: /api/capture/case/:caseId/attempt is the
    //    closure-loop alternative. The 410 contract advertises the
    //    same path; this just exercises the success path so the
    //    route is alive.
    const create = await request(app)
      .post("/api/capture/manual")
      .send({
        childId: CHILD,
        problem: "smoke-9-4",
        userAnswer: "4",
        correctAnswer: "5",
        errorType: "compute",
        subject: "math",
      });
    expect(create.status).toBe(201);
    const attempt = await request(app)
      .post(`/api/capture/case/${create.body.caseId}/attempt`)
      .send({ childId: CHILD, answer: "5" });
    expect(attempt.status).toBe(200);
  });
});
