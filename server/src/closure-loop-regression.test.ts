// server/src/closure-loop-regression.test.ts
//
// T10-4: end-to-end smoke for the closure loop as exercised through
// the legacy game compat adapters (POST /api/game/mistake and
// POST /api/game/mistake-review). SB124-T10 briefly retired those
// endpoints to 410; that was reversed because the only production
// clients still call them and silently drop data on non-2xx. They
// are now long-lived compat adapters delegating to insertMistake()
// and recordCorrectionAttempt().
//
// What's covered:
//   - compat mistake write → case open (visible in the inbox)
//   - compat review (correct) → obligation verified → mirror row
//     deleted on closure → readArchivedMistake returns null
//   - manual capture → 3 correct attempts via /api/capture/case/:caseId/attempt
//     → case is verified → readArchivedMistake returns null after closure
//
// What is NOT covered here (already covered elsewhere):
//   - per-route response shapes (capture-routes.test.ts, review-workspace.test.ts,
//     capture-review.test.ts, capture-reinforcement.test.ts)
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

describe("closure-loop smoke via the game compat adapters", () => {
  it("T10-4a: POST /api/game/mistake opens a case; manual-capture closure path still works end-to-end", async () => {
    // 1. Compat adapter: the game client POSTs a wrong answer and a
    //    case opens.
    const legacy = await request(app)
      .post("/api/game/mistake")
      .send({
        childId: CHILD,
        problem: "smoke-legacy-3+5",
        userAnswer: "7",
        correctAnswer: "8",
        errorType: "compute",
      });
    expect(legacy.status).toBe(201);
    expect(legacy.body.created).toBe(true);

    const inboxLegacy = await request(app)
      .get("/api/capture/inbox")
      .query({ childId: CHILD });
    const legacyProblems = (inboxLegacy.body.cases as Array<{ problem: string }>)
      .map((c) => c.problem);
    expect(legacyProblems).toContain("smoke-legacy-3+5");

    // 2. Manual capture: POST /api/capture/manual creates the case.
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

    // 4. Correct attempts close the obligation (first independent
    //    correct verifies; repeats are idempotent no-ops).
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

    // 6. Closure deleted the legacy mistakes mirror row.
    expect(readArchivedMistake(db, mistakeId)).toBeNull();
  });

  it("T10-4b: POST /api/game/mistake-review (correct) verifies the obligation end-to-end", async () => {
    // 1. Compat adapter: a wrong answer opens a case.
    const create = await request(app)
      .post("/api/game/mistake")
      .send({
        childId: CHILD,
        problem: "smoke-legacy-9-4",
        userAnswer: "4",
        correctAnswer: "5",
        errorType: "compute",
      });
    expect(create.status).toBe(201);
    const mistakeId = create.body.id as number;
    const caseId = create.body.caseId as string;

    // 2. Compat adapter: the in-quiz re-attempt was correct → the
    //    obligation is verified.
    const review = await request(app)
      .post("/api/game/mistake-review")
      .send({
        childId: CHILD,
        results: [{ mistakeId, correct: true, userAnswer: "5" }],
      });
    expect(review.status).toBe(200);
    expect(review.body.results).toEqual([{ mistakeId, status: "recorded" }]);

    const obligation = db
      .prepare(
        "SELECT status, verified_at AS verifiedAt FROM correction_obligations WHERE case_id = ?",
      )
      .get(caseId) as { status: string; verifiedAt: number | null };
    expect(obligation.status).toBe("verified");
    expect(obligation.verifiedAt).not.toBeNull();

    // 3. The verified case drops out of the inbox and the legacy
    //    mistakes mirror row is deleted on closure.
    const inboxAfter = await request(app)
      .get("/api/capture/inbox")
      .query({ childId: CHILD });
    const problemsAfter = (inboxAfter.body.cases as Array<{ problem: string }>)
      .map((c) => c.problem);
    expect(problemsAfter).not.toContain("smoke-legacy-9-4");
    expect(readArchivedMistake(db, mistakeId)).toBeNull();
  });
});
