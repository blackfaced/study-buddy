// server/src/write-sync.test.ts
//
// Unit tests for the write-app data access layer. Uses in-memory
// SQLite so the tests are fast and isolated.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { migrateSchema } from "./db-migrate.js";
import {
  addWritingWords,
  deleteWritingWord,
  listWritingAttempts,
  listWritingWords,
  recordWritingAttempt,
} from "./write-sync.js";

let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  migrateSchema(db);
});

afterEach(() => {
  db.close();
});

describe("addWritingWords", () => {
  it("adds a single character", () => {
    const r = addWritingWords(db, ["一"]);
    expect(r).toEqual({ added: 1, skipped: 0 });
    expect(listWritingWords(db).map((w) => w.char)).toEqual(["一"]);
  });

  it("adds multiple characters and reports correct counts", () => {
    const r = addWritingWords(db, ["一", "二", "三"]);
    expect(r).toEqual({ added: 3, skipped: 0 });
  });

  it("silently skips duplicates (PRIMARY KEY char)", () => {
    addWritingWords(db, ["一"]);
    const r = addWritingWords(db, ["一", "二", "三"]);
    expect(r).toEqual({ added: 2, skipped: 1 });
    const chars = listWritingWords(db).map((w) => w.char);
    // Set equality — order is by added_at DESC which is well-defined
    // here (Date.now() between calls).
    expect(new Set(chars)).toEqual(new Set(["一", "二", "三"]));
    expect(chars).toHaveLength(3);
  });

  it("strips non-CJK characters (whitespace, ascii, etc.)", () => {
    const r = addWritingWords(db, ["一", " ", "a", "二", "？"]);
    expect(r.added).toBe(2);
    expect(r.skipped).toBe(3);
  });

  it("returns { added: 0, skipped: 0 } on empty input", () => {
    const r = addWritingWords(db, []);
    expect(r).toEqual({ added: 0, skipped: 0 });
  });

  it("attaches added_by to the row", () => {
    addWritingWords(db, ["一"], "agent-vision");
    const w = listWritingWords(db)[0];
    expect(w.addedBy).toBe("agent-vision");
  });
});

describe("deleteWritingWord", () => {
  it("removes an existing word and returns true", () => {
    addWritingWords(db, ["一", "二"]);
    expect(deleteWritingWord(db, "一")).toBe(true);
    expect(listWritingWords(db).map((w) => w.char)).toEqual(["二"]);
  });

  it("returns false when the char does not exist", () => {
    addWritingWords(db, ["一"]);
    expect(deleteWritingWord(db, "X")).toBe(false);
  });

  it("cascades to writing_attempts via FK", () => {
    addWritingWords(db, ["一"]);
    recordWritingAttempt(db, { char: "一", level: 1.0, strokePath: "M 0 0" });
    recordWritingAttempt(db, { char: "一", level: 0.5, strokePath: "M 1 1" });
    expect(listWritingAttempts(db, "一")).toHaveLength(2);
    deleteWritingWord(db, "一");
    expect(listWritingAttempts(db, "一")).toHaveLength(0);
  });
});

describe("listWritingWords", () => {
  it("returns empty list on fresh db", () => {
    expect(listWritingWords(db)).toEqual([]);
  });

  it("orders newest first", async () => {
    addWritingWords(db, ["一"]);
    await new Promise((r) => setTimeout(r, 5));
    addWritingWords(db, ["二"]);
    await new Promise((r) => setTimeout(r, 5));
    addWritingWords(db, ["三"]);
    const chars = listWritingWords(db).map((w) => w.char);
    expect(chars).toEqual(["三", "二", "一"]);
  });

  it("includes attempt count per word", () => {
    addWritingWords(db, ["一", "二"]);
    recordWritingAttempt(db, { char: "一", level: 1.0, strokePath: "M 0 0" });
    recordWritingAttempt(db, { char: "一", level: 0.5, strokePath: "M 1 1" });
    const counts = Object.fromEntries(
      listWritingWords(db).map((w) => [w.char, w.attemptCount]),
    );
    expect(counts["一"]).toBe(2);
    expect(counts["二"]).toBe(0);
  });
});

describe("recordWritingAttempt", () => {
  it("returns the inserted row id", () => {
    addWritingWords(db, ["一"]);
    const id = recordWritingAttempt(db, { char: "一", level: 1.0, strokePath: "M 0 0" });
    expect(id).toBeGreaterThan(0);
  });

  it("stores level and stroke_path as provided", () => {
    addWritingWords(db, ["一"]);
    const id = recordWritingAttempt(db, {
      char: "一",
      level: 0.5,
      strokePath: "M 100 100 L 200 200",
    });
    const a = listWritingAttempts(db, "一").find((x) => x.id === id);
    expect(a).toBeDefined();
    expect(a?.level).toBe(0.5);
    expect(a?.strokePath).toBe("M 100 100 L 200 200");
  });

  it("accepts null strokePath (defensive — kid closed tab mid-write)", () => {
    addWritingWords(db, ["一"]);
    const id = recordWritingAttempt(db, { char: "一", level: 1.0, strokePath: null });
    const a = listWritingAttempts(db, "一").find((x) => x.id === id);
    expect(a?.strokePath).toBeNull();
  });

  it("round-trips an explainable handwriting assessment", () => {
    addWritingWords(db, ["永"]);
    const assessment = {
      status: "scored",
      score: 82,
      band: "写得规范",
      strokes: [[{ x: 100, y: 120 }, { x: 220, y: 120 }]],
      breakdown: { structure: 0.8, placement: 0.9, strokeQuality: 0.75, shape: 0.8 },
      reasons: [{ code: "stroke_length", message: "第一横再短一点" }],
      process: {
        orderErrors: 1,
        rejectedStrokes: 1,
        hintCounts: [1],
        manualUndos: 1,
        undoEvents: [{ reviewId: 2, atStrokeIndex: 0 }],
      },
      algorithmVersion: "handwriting-coach-v1",
      nextAction: "review_later",
      retryOutcome: "failed",
      reviewNeeded: true,
      modelReview: { status: "skipped" },
    };

    const id = recordWritingAttempt(db, {
      char: "永",
      level: 1,
      strokePath: "M 100 120 L 220 120",
      assessment,
    });

    const saved = listWritingAttempts(db, "永").find((attempt) => attempt.id === id);
    expect(saved).toMatchObject({
      status: "scored",
      score: 82,
      displayBand: "写得规范",
      algorithmVersion: "handwriting-coach-v1",
      strokes: assessment.strokes,
      breakdown: assessment.breakdown,
      reasons: assessment.reasons,
      process: assessment.process,
      nextAction: "review_later",
      retryOutcome: "failed",
      reviewNeeded: true,
      modelReview: assessment.modelReview,
    });
  });
});

describe("listWritingAttempts", () => {
  it("returns empty list for a char with no attempts", () => {
    addWritingWords(db, ["一"]);
    expect(listWritingAttempts(db, "一")).toEqual([]);
  });

  it("orders newest first", async () => {
    addWritingWords(db, ["一"]);
    recordWritingAttempt(db, { char: "一", level: 1.0, strokePath: "old" });
    await new Promise((r) => setTimeout(r, 5));
    recordWritingAttempt(db, { char: "一", level: 0.5, strokePath: "new" });
    const list = listWritingAttempts(db, "一");
    expect(list).toHaveLength(2);
    expect(list[0].strokePath).toBe("new");
    expect(list[1].strokePath).toBe("old");
  });

  it("respects the limit parameter", () => {
    addWritingWords(db, ["一"]);
    for (let i = 0; i < 5; i++) {
      recordWritingAttempt(db, { char: "一", level: 1.0, strokePath: `path-${i}` });
    }
    expect(listWritingAttempts(db, "一", 3)).toHaveLength(3);
  });
});
