// server/src/hypothesis-workflow.test.ts
//
// T06-3: state machine for case_hypotheses. Tests cover:
//   - addHypothesis: trim + sensitive flagging at write time
//   - confirmHypothesis: pending → confirmed, idempotent on confirmed
//   - rejectHypothesis: pending → rejected, idempotent, blocked on confirmed
//   - modifyHypothesis: pending → modified + new audit row
//   - sensitive filter: written sensitive=true so kid view can drop it

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { migrateSchema } from "./db-migrate.js";
import {
  addHypothesis,
  confirmHypothesis,
  modifyHypothesis,
  rejectHypothesis,
  HypothesisConflictError,
  HypothesisNotFoundError,
} from "./hypothesis-workflow.js";

let db: Database.Database;
let tmpDir: string;
const CHILD = "default";
const SESSION = "sess-hyp-test";
let caseId = "";

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "study-buddy-hyp-workflow-"));
  db = new Database(join(tmpDir, "test.db"));
  db.pragma("foreign_keys = ON");
  db.pragma("journal_mode = WAL");
  migrateSchema(db);
  db.prepare(`INSERT OR IGNORE INTO children (id, name, grade) VALUES (?, ?, ?)`)
    .run(CHILD, "小宝", "二年级");
  db.prepare(
    `INSERT OR REPLACE INTO sessions (id, child_id, device_id, started_at, subject)
     VALUES (?, ?, ?, 0, 'math')`,
  ).run(SESSION, CHILD, "default");
  // We need a mistake_cases row for the FK. Use insertMistake to get a
  // real case_id, then reuse it across tests.
  const { insertMistake } = await import("./routes/mistake-api.js");
  const r = insertMistake(db, {
    childId: CHILD,
    problem: "9-4",
    userAnswer: "4",
    correctAnswer: "5",
    errorType: "borrow",
    source: "manual",
  });
  caseId = r.caseId;
});

afterAll(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  db.exec(`DELETE FROM case_hypotheses`);
});

describe("addHypothesis (T06 PR-C)", () => {
  it("T06-3a: adds a normal text hypothesis (parent source) with sensitive=false", () => {
    const h = addHypothesis(db, {
      caseId,
      childId: CHILD,
      source: "parent",
      text: "进位的时候忘了加 1",
    });
    expect(h.status).toBe("pending");
    expect(h.sensitive).toBe(0);
    expect(h.source).toBe("parent");
    expect(h.parentHypothesisId).toBeNull();
  });

  it("writes sensitive=1 when text contains 笨蛋 (sensitive at write time, not view time)", () => {
    const h = addHypothesis(db, {
      caseId,
      childId: CHILD,
      source: "parent",
      text: "孩子是笨蛋",
    });
    expect(h.sensitive).toBe(1);
  });
});

describe("confirmHypothesis (T06 PR-C)", () => {
  it("pending → confirmed", () => {
    const h = addHypothesis(db, { caseId, childId: CHILD, source: "parent", text: "粗心" });
    const after = confirmHypothesis(db, h.id);
    expect(after.status).toBe("confirmed");
    expect(after.confirmedAt).not.toBeNull();
  });

  it("re-confirming a confirmed row is idempotent (no 409, returns same row)", () => {
    const h = addHypothesis(db, { caseId, childId: CHILD, source: "parent", text: "粗心" });
    const first = confirmHypothesis(db, h.id);
    const second = confirmHypothesis(db, h.id);
    expect(second.status).toBe("confirmed");
    expect(second.confirmedAt).toBe(first.confirmedAt);
  });

  it("confirming a rejected row throws ConflictError", () => {
    const h = addHypothesis(db, { caseId, childId: CHILD, source: "parent", text: "粗心" });
    rejectHypothesis(db, h.id);
    expect(() => confirmHypothesis(db, h.id)).toThrow(HypothesisConflictError);
  });
});

describe("rejectHypothesis (T06 PR-C)", () => {
  it("pending → rejected", () => {
    const h = addHypothesis(db, { caseId, childId: CHILD, source: "parent", text: "粗心" });
    const after = rejectHypothesis(db, h.id);
    expect(after.status).toBe("rejected");
  });

  it("rejecting a confirmed row throws ConflictError (rejection is irreversible)", () => {
    const h = addHypothesis(db, { caseId, childId: CHILD, source: "parent", text: "粗心" });
    confirmHypothesis(db, h.id);
    expect(() => rejectHypothesis(db, h.id)).toThrow(HypothesisConflictError);
  });

  it("rejecting an already-rejected row is idempotent", () => {
    const h = addHypothesis(db, { caseId, childId: CHILD, source: "parent", text: "粗心" });
    rejectHypothesis(db, h.id);
    const second = rejectHypothesis(db, h.id);
    expect(second.status).toBe("rejected");
  });
});

describe("modifyHypothesis (T06 PR-C)", () => {
  it("pending → modified on the original row + a new audit row", () => {
    const h = addHypothesis(db, { caseId, childId: CHILD, source: "parent", text: "粗心" });
    const replacement = modifyHypothesis(db, h.id, "退位时没借 1", "borrow");
    expect(replacement.status).toBe("modified");
    expect(replacement.parentHypothesisId).toBe(h.id);
    expect(replacement.hypothesis).toBe("退位时没借 1");
    expect(replacement.label).toBe("borrow");

    // Original row now status='modified' (audit), new row is the
    // "current" version
    const all = db
      .prepare(`SELECT id, status, hypothesis, parent_hypothesis_id AS parent
                  FROM case_hypotheses WHERE case_id = ? ORDER BY id`)
      .all(caseId) as Array<{ id: number; status: string; hypothesis: string; parent: number | null }>;
    expect(all).toHaveLength(2);
    expect(all[0]).toMatchObject({ id: h.id, status: "modified" });
    expect(all[1]).toMatchObject({ id: replacement.id, status: "modified", parent: h.id });
  });

  it("modifying a rejected row throws ConflictError", () => {
    const h = addHypothesis(db, { caseId, childId: CHILD, source: "parent", text: "粗心" });
    rejectHypothesis(db, h.id);
    expect(() => modifyHypothesis(db, h.id, "新文本")).toThrow(HypothesisConflictError);
  });
});

describe("not-found (T06 PR-C)", () => {
  it("confirming a missing id throws NotFound", () => {
    expect(() => confirmHypothesis(db, 9999)).toThrow(HypothesisNotFoundError);
  });
  it("rejecting a missing id throws NotFound", () => {
    expect(() => rejectHypothesis(db, 9999)).toThrow(HypothesisNotFoundError);
  });
  it("modifying a missing id throws NotFound", () => {
    expect(() => modifyHypothesis(db, 9999, "x")).toThrow(HypothesisNotFoundError);
  });
});
