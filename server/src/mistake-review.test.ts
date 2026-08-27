// server/src/mistake-review.test.ts
//
// SB124-T10 #134: deprecation test for the old /api/game/mistake-review
// endpoint. The pre-T1 3-correct cascade-delete contract is replaced
// by the closure loop (mistake_cases + correction_obligations +
// learning_attempts); the old endpoint now returns 410 Gone with the
// replacement path advertised in the JSON body + X-Sunset header.
//
// We keep this test around as a regression guard so the 410 doesn't
// accidentally regress back to a 200. The full closure-loop review
// path is covered by review-workspace.test.ts (T05 #170 PR).

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { createApp } from "./app.js";
import { migrateSchema } from "./db-migrate.js";
import { seedTestDevice } from "./test-device.js";
import { MistakePagePhotoWorkflow } from "./mistake-page-photo-workflow.js";

let db: Database.Database;
let tmpDir: string;
let app: ReturnType<typeof createApp>;
const CHILD = "default";

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "study-buddy-t10-deprecation-"));
  db = new Database(join(tmpDir, "test.db"));
  db.pragma("foreign_keys = ON");
  migrateSchema(db);
  seedTestDevice(db);
  app = createApp({
    db,
    httpsPort: 3000,
    outboxPath: join(tmpDir, "outbox.jsonl"),
    pagePhotoWorkflow: new MistakePagePhotoWorkflow({ db }),
  });
});

afterAll(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("T10 #134: deprecated /api/game/* endpoints return 410", () => {
  it("POST /api/game/mistake returns 410 + replacement path", async () => {
    const res = await request(app)
      .post("/api/game/mistake")
      .send({
        childId: CHILD,
        problem: "3+4=?",
        userAnswer: "6",
        correctAnswer: "7",
        errorType: "compute",
      });
    expect(res.status).toBe(410);
    expect(res.body.replacement).toBe("POST /api/capture/manual");
    expect(res.headers["x-sunset"]).toBe("2026-12-31");
  });

  it("POST /api/game/mistake-review returns 410 + replacement path", async () => {
    const res = await request(app)
      .post("/api/game/mistake-review")
      .send({
        childId: CHILD,
        results: [{ mistakeId: 1, correct: true }],
      });
    expect(res.status).toBe(410);
    expect(res.body.replacement).toBe(
      "POST /api/capture/case/:caseId/attempt",
    );
    expect(res.headers["x-sunset"]).toBe("2026-12-31");
  });
});
