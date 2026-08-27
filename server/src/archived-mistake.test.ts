// server/src/archived-mistake.test.ts
//
// T10-5: readArchivedMistake returns the raw legacy mistakes row.
// Diagnostic helper, never used by closure-loop code.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { migrateSchema } from "./db-migrate.js";
import { insertMistake } from "./routes/mistake-api.js";
import { readArchivedMistake } from "./archived-mistake.js";

let db: Database.Database;
let tmpDir: string;

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "study-buddy-archived-mistake-"));
  db = new Database(join(tmpDir, "test.db"));
  db.pragma("foreign_keys = ON");
  migrateSchema(db);
});

afterAll(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("T10 #134: readArchivedMistake (diagnostic helper)", () => {
  it("T10-5a: returns the raw row for an active mistake", () => {
    const r = insertMistake(db, {
      childId: "default",
      problem: "3+5=?",
      userAnswer: "7",
      correctAnswer: "8",
      errorType: "compute",
      source: "game",
    });
    const got = readArchivedMistake(db, r.id);
    expect(got).not.toBeNull();
    expect(got).toMatchObject({
      id: r.id,
      childId: "default",
      problem: "3+5=?",
      userAnswer: "7",
      correctAnswer: "8",
      errorType: "compute",
      source: "game",
      isArchived: 0,
      level: expect.any(Number),
    });
    // sanity: the closure loop's mistake_cases row should also exist
    const caseRow = db
      .prepare("SELECT case_id FROM mistake_cases WHERE original_mistake_id = ?")
      .get(r.id) as { case_id: string } | undefined;
    expect(caseRow).toBeDefined();
  });

  it("T10-5b: still returns the row after it is archived", () => {
    const r = insertMistake(db, {
      childId: "default",
      problem: "9-4=?",
      userAnswer: "4",
      correctAnswer: "5",
      errorType: "compute",
      source: "study-buddy",
    });
    // Simulate the T10 backfill: flip the archive flag.
    db.prepare("UPDATE mistakes SET is_archived = 1 WHERE id = ?").run(r.id);
    const got = readArchivedMistake(db, r.id);
    expect(got).not.toBeNull();
    expect(got?.isArchived).toBe(1);
    expect(got?.problem).toBe("9-4=?");
  });

  it("T10-5c: returns null when the id is not in the mirror", () => {
    expect(readArchivedMistake(db, 999999)).toBeNull();
  });
});
