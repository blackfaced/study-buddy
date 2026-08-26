// server/src/candidate-workflow.test.ts
//
// T04C-3 + T04C-4: confirmCandidate and discardCandidate workflows.
// Test the happy path, idempotency, and the cross-status guard
// (re-confirm a discarded candidate → ConflictError).

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { migrateSchema } from "./db-migrate.js";
import {
  confirmCandidate,
  discardCandidate,
  CandidateConflictError,
  CandidateNotFoundError,
} from "./candidate-workflow.js";

let db: Database.Database;
let tmpDir: string;

const CHILD = "default";
const DEVICE = "default";
const SESSION = "sess-cand-test";

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "study-buddy-cand-workflow-"));
  db = new Database(join(tmpDir, "test.db"));
  db.pragma("foreign_keys = ON");
  db.pragma("journal_mode = WAL");
  migrateSchema(db);
  db.prepare(`INSERT OR IGNORE INTO children (id, name, grade) VALUES (?, ?, ?)`)
    .run(CHILD, "小宝", "二年级");
  db.prepare(
    `INSERT OR REPLACE INTO sessions (id, child_id, device_id, started_at, subject)
     VALUES (?, ?, ?, 0, 'math')`,
  ).run(SESSION, CHILD, DEVICE);
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

function insertDraftAndCandidate(
  draftId: string,
  regionIndex: number,
  overrides: { childId?: string; status?: string; problem?: string | null } = {},
): number {
  db.prepare(
    `INSERT INTO mistake_photo_page_drafts
       (id, child_id, session_id, device_id, state,
        layout_model, layout_regions_json, layout_confidence,
        image_bytes, image_extension, created_at, expires_at)
     VALUES (?, ?, ?, ?, 'review', 'm', '[]', 'ok', ?, 'jpg', 0, ?)`,
  ).run(
    draftId,
    overrides.childId ?? CHILD,
    SESSION,
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
     VALUES (?, ?, ?, ?, ?, 'math', ?, NULL, NULL, NULL, 'ok', 'm', '', '', 0, 0, ?, NULL)`,
  ).run(
    draftId,
    overrides.childId ?? CHILD,
    SESSION,
    DEVICE,
    regionIndex,
    overrides.problem ?? "3+4=?",
    overrides.status ?? "pending",
  );
  return Number(r.lastInsertRowid);
}

describe("confirmCandidate (T04-C PR-C)", () => {
  it("T04C-3a: happy path — pending candidate → 1 mistake_case + status='confirmed'", () => {
    const id = insertDraftAndCandidate("d1", 0);
    const r = confirmCandidate(db, id, {
      userAnswer: "7",
      correctAnswer: "7",
    });
    expect(r.idempotent).toBe(false);
    expect(r.caseId).toMatch(/^case:/);

    const row = db
      .prepare(`SELECT status, confirmed_case_id FROM mistake_photo_candidates WHERE id = ?`)
      .get(id) as { status: string; confirmed_case_id: string };
    expect(row.status).toBe("confirmed");
    expect(row.confirmed_case_id).toBe(r.caseId);

    const cases = db
      .prepare(`SELECT case_id, child_id, problem FROM mistake_cases`)
      .all() as Array<{ case_id: string; child_id: string; problem: string }>;
    expect(cases).toHaveLength(1);
    expect(cases[0]).toMatchObject({
      case_id: r.caseId,
      child_id: CHILD,
      problem: "3+4=?",
    });
  });

  it("T04C-3b: re-confirm an already-confirmed candidate returns same caseId, no second mistake", () => {
    const id = insertDraftAndCandidate("d1", 0);
    const first = confirmCandidate(db, id, { userAnswer: "7", correctAnswer: "7" });
    const second = confirmCandidate(db, id, { userAnswer: "7", correctAnswer: "7" });
    expect(second.idempotent).toBe(true);
    expect(second.caseId).toBe(first.caseId);
    expect(second.mistakeId).toBe(first.mistakeId);

    const cases = db
      .prepare(`SELECT count(*) as n FROM mistake_cases`)
      .get() as { n: number };
    expect(cases.n).toBe(1);
  });
});

describe("discardCandidate (T04-C PR-C)", () => {
  it("T04C-4a: happy path — pending candidate → status='discarded'", () => {
    const id = insertDraftAndCandidate("d1", 0);
    const r = discardCandidate(db, id);
    expect(r.discarded).toBe(true);
    expect(r.idempotent).toBe(false);
    const row = db
      .prepare(`SELECT status FROM mistake_photo_candidates WHERE id = ?`)
      .get(id) as { status: string };
    expect(row.status).toBe("discarded");
    // No mistake created
    const cases = db
      .prepare(`SELECT count(*) as n FROM mistake_cases`)
      .get() as { n: number };
    expect(cases.n).toBe(0);
  });

  it("T04C-4b: re-discard an already-discarded candidate is idempotent (200, no-op)", () => {
    const id = insertDraftAndCandidate("d1", 0);
    const first = discardCandidate(db, id);
    const second = discardCandidate(db, id);
    expect(first.idempotent).toBe(false);
    expect(second.idempotent).toBe(true);
    expect(second.discarded).toBe(true);
  });

  it("T04C-5b: confirm a discarded candidate throws CandidateConflictError", () => {
    const id = insertDraftAndCandidate("d1", 0);
    discardCandidate(db, id);
    expect(() =>
      confirmCandidate(db, id, { userAnswer: "7", correctAnswer: "7" }),
    ).toThrow(CandidateConflictError);
  });

  it("T04C-5c: confirm a non-existent candidateId throws CandidateNotFoundError", () => {
    expect(() =>
      confirmCandidate(db, 9999, { userAnswer: "7", correctAnswer: "7" }),
    ).toThrow(CandidateNotFoundError);
  });

  it("cross-status: discard a confirmed candidate throws ConflictError (use mark-correct, not discard)", () => {
    const id = insertDraftAndCandidate("d1", 0);
    confirmCandidate(db, id, { userAnswer: "7", correctAnswer: "7" });
    expect(() => discardCandidate(db, id)).toThrow(CandidateConflictError);
  });

  it("empty problem refuses to promote: confirm throws ConflictError('empty-problem')", () => {
    const id = insertDraftAndCandidate("d1", 0, { problem: "" });
    expect(() =>
      confirmCandidate(db, id, { userAnswer: "7", correctAnswer: "7" }),
    ).toThrow(CandidateConflictError);
  });
});
