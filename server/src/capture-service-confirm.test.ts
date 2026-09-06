// server/src/capture-service-confirm.test.ts
//
// Multi-item 拍错题 confirm: confirmMistakePhotoDraft() writes one
// Mistake Case per confirmed item, taking subject / userAnswer /
// correctAnswer / errorType from the item, and is idempotent per
// (draftId, itemIndex) — a retried confirm of the same item replays
// the first result instead of double-writing.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { migrateSchema } from "./db-migrate.js";
import { seedTestDevice, TEST_DEVICE } from "./test-device.js";
import {
  confirmMistakePhotoDraft,
  findMistakePhotoConfirmation,
} from "./capture-service.js";

let db: Database.Database;

beforeAll(() => {
  db = new Database(":memory:");
  migrateSchema(db);
  seedTestDevice(db);
});

afterAll(() => {
  db.close();
});

beforeEach(() => {
  db.prepare("DELETE FROM mistake_photo_confirmations").run();
  db.prepare("DELETE FROM learning_attempts").run();
  db.prepare("DELETE FROM correction_obligations").run();
  db.prepare("DELETE FROM mistake_cases").run();
  db.prepare("DELETE FROM mistakes").run();
  db.prepare("DELETE FROM sessions").run();
  db.prepare(
    "INSERT INTO sessions (id, child_id, subject, device_id) VALUES ('sess_1', 'default', 'math', ?)",
  ).run(TEST_DEVICE.deviceId);
});

function confirmInput(overrides: Record<string, unknown> = {}) {
  return {
    draftId: "draft_1",
    problemText: "8 + 5 = ?",
    proposedProblem: "8 + 5 = ?",
    sessionId: "sess_1",
    childId: TEST_DEVICE.childId,
    deviceId: TEST_DEVICE.deviceId,
    ...overrides,
  };
}

function caseRow(caseId: string) {
  return db.prepare(
    "SELECT subject, user_answer, correct_answer, error_type, source FROM mistake_cases WHERE case_id = ?",
  ).get(caseId) as {
    subject: string | null;
    user_answer: string | null;
    correct_answer: string | null;
    error_type: string | null;
    source: string;
  } | undefined;
}

describe("confirmMistakePhotoDraft item fields", () => {
  it("stores the item's subject and answer fields on the case row", () => {
    const result = confirmMistakePhotoDraft(db, confirmInput({
      problemText: "抄写「已」",
      proposedProblem: "抄写「已」",
      subject: "chinese",
      userAnswer: "己",
      correctAnswer: "已",
      errorType: "形近字混淆",
      itemIndex: 1,
    }));
    expect(caseRow(result.caseId)).toEqual({
      subject: "chinese",
      user_answer: "己",
      correct_answer: "已",
      error_type: "形近字混淆",
      source: "vision",
    });
  });

  it("falls back to subject 'math' when the item subject is empty or unknown", () => {
    const empty = confirmMistakePhotoDraft(db, confirmInput({ draftId: "draft_empty", subject: "" }));
    expect(caseRow(empty.caseId)?.subject).toBe("math");
    const bogus = confirmMistakePhotoDraft(db, confirmInput({ draftId: "draft_bogus", subject: "物理" }));
    expect(caseRow(bogus.caseId)?.subject).toBe("math");
  });

  it("keeps the legacy defaults when no item fields are provided", () => {
    const result = confirmMistakePhotoDraft(db, confirmInput({ draftId: "draft_legacy" }));
    expect(caseRow(result.caseId)).toEqual({
      subject: "math",
      user_answer: "",
      correct_answer: "",
      error_type: "confirmed",
      source: "vision",
    });
  });
});

describe("confirmMistakePhotoDraft per-item idempotency", () => {
  it("replays the first result when the same item is confirmed twice", () => {
    const first = confirmMistakePhotoDraft(db, confirmInput({ itemIndex: 0 }));
    const second = confirmMistakePhotoDraft(db, confirmInput({ itemIndex: 0 }));
    expect(second).toEqual(first);
    expect(
      db.prepare("SELECT COUNT(*) AS c FROM mistake_cases WHERE source = 'vision'").get(),
    ).toEqual({ c: 1 });
  });

  it("confirms different items of the same draft as separate cases", () => {
    const item0 = confirmMistakePhotoDraft(db, confirmInput({ itemIndex: 0 }));
    const item1 = confirmMistakePhotoDraft(db, confirmInput({
      itemIndex: 1,
      problemText: "抄写「已」",
      proposedProblem: "抄写「已」",
      subject: "chinese",
    }));
    expect(item1.caseId).not.toBe(item0.caseId);
    expect(
      db.prepare("SELECT COUNT(*) AS c FROM mistake_photo_confirmations").get(),
    ).toEqual({ c: 2 });
    expect(findMistakePhotoConfirmation(db, "draft_1", 0)?.caseId).toBe(item0.caseId);
    expect(findMistakePhotoConfirmation(db, "draft_1", 1)?.caseId).toBe(item1.caseId);
    // itemIndex defaults to 0 — the legacy whole-draft lookup.
    expect(findMistakePhotoConfirmation(db, "draft_1")?.caseId).toBe(item0.caseId);
  });
});
