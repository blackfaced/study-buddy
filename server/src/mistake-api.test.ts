// server/src/mistake-api.test.ts
//
// Tests for POST /api/game/mistake (#34a-1, issue #98).
// The endpoint records a wrong answer as a mistake. UNIQUE (child_id, problem)
// dedupes the same problem for the same child — multiple wrong answers to
// the same problem return the same row, not new rows.

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

describe("T10 #134: deprecated /api/game/mistake returns 410", () => {
  // The pre-T1 /api/game/mistake contract (issue #98) is retired.
  // The closure loop replaces it: insertMistake() directly for
  // game-source mistakes (covered by game-sync.test.ts and the
  // integration tests), POST /api/capture/manual for manual entry,
  // and POST /api/mistake-photo/... for the T04 page-photo flow.
  it("returns 410 with replacement path + X-Sunset header", async () => {
    const res = await request(app)
      .post("/api/game/mistake")
      .send({
        childId: "default",
        problem: "3+4",
        correctAnswer: "7",
        userAnswer: "6",
        errorType: "borrow",
      });
    expect(res.status).toBe(410);
    expect(res.body.replacement).toBe("POST /api/capture/manual");
    expect(res.headers["x-sunset"]).toBe("2026-12-31");
  });
});
