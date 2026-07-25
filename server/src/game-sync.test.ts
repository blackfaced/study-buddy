import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { migrateSchema } from "./db-migrate.js";
import { appendOutbox, readPendingOutbox } from "./outbox.js";
import { recordGameMistake, getGameWeakTopics } from "./game-sync.js";

let db: Database.Database;
let outboxPath: string;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  migrateSchema(db);
  // default child is created by migrateSchema
  outboxPath = join(mkdtempSync(join(tmpdir(), "gamesync-")), "outbox.jsonl");
});

afterEach(() => {
  db.close();
});

describe("recordGameMistake", () => {
  it("inserts a row into mistakes with source='game' and the user/correct answers", async () => {
    const id = await recordGameMistake(db, outboxPath, {
      childId: "default",
      subject: "math",
      problem: "5 + 7 = ?",
      errorType: "carry",
      userAnswer: 11,
      correctAnswer: 12,
      level: 1,
    });
    expect(id).toBeGreaterThan(0);
    const row = db
      .prepare(
        "SELECT subject, problem, error_type, user_answer, correct_answer, source FROM mistakes WHERE id = ?"
      )
      .get(id) as any;
    expect(row.subject).toBe("math");
    expect(row.problem).toBe("5 + 7 = ?");
    expect(row.error_type).toBe("carry");
    // user_answer and correct_answer are stored as TEXT so they round-trip
    // through the SQL driver as strings; we still treat them numerically in
    // the API. Verify both as numbers (parseInt handles the round-trip).
    expect(parseInt(row.user_answer, 10)).toBe(11);
    expect(parseInt(row.correct_answer, 10)).toBe(12);
    expect(row.source).toBe("game");
  });

  it("auto-creates a session when none is active", async () => {
    // No start_session call; recordGameMistake should create one transparently.
    const id = await recordGameMistake(db, outboxPath, {
      childId: "default",
      subject: "math",
      problem: "5 + 7 = ?",
      errorType: "carry",
      userAnswer: 11,
      correctAnswer: 12,
      level: 1,
    });
    const row = db.prepare("SELECT session_id FROM mistakes WHERE id = ?").get(id) as any;
    expect(row.session_id).toBeTruthy();
    const sess = db
      .prepare("SELECT id, child_id, ended_at FROM sessions WHERE id = ?")
      .get(row.session_id) as any;
    expect(sess.child_id).toBe("default");
    // Auto-created sessions are still open (no ended_at) so the next mistake
    // can ride the same one.
    expect(sess.ended_at).toBeNull();
  });

  it("appends an outbox entry tagged kind='math_mistake' with the same payload", async () => {
    await recordGameMistake(db, outboxPath, {
      childId: "default",
      subject: "math",
      problem: "5 + 7 = ?",
      errorType: "carry",
      userAnswer: 11,
      correctAnswer: 12,
      level: 1,
    });
    const entries = await readPendingOutbox(outboxPath);
    expect(entries).toHaveLength(1);
    const e = entries[0];
    expect(e.kind).toBe("math_mistake");
    expect(e.entityId).toBe("child:default");
    expect(e.payload).toMatchObject({
      subject: "math",
      problem: "5 + 7 = ?",
      errorType: "carry",
      userAnswer: 11,
      correctAnswer: 12,
      level: 1,
      source: "game",
    });
    expect(typeof e.ts).toBe("number");
    expect(e.id).toMatch(/^e_/);
  });
});

describe("getGameWeakTopics", () => {
  async function seedMistakes() {
    // 3 carry, 1 borrow, 2 compute
    await recordGameMistake(db, outboxPath, mk("5+7", "carry", 1));
    await recordGameMistake(db, outboxPath, mk("8+6", "carry", 1));
    await recordGameMistake(db, outboxPath, mk("9+4", "carry", 1));
    await recordGameMistake(db, outboxPath, mk("15-8", "borrow", 1));
    await recordGameMistake(db, outboxPath, mk("11-3", "compute", 1));
    await recordGameMistake(db, outboxPath, mk("12-5", "compute", 1));
    function mk(problem: string, errorType: string, level: number) {
      return {
        childId: "default",
        subject: "math",
        problem,
        errorType,
        userAnswer: 0,
        correctAnswer: 1,
        level,
      };
    }
  }

  it("only counts mistakes with source='game' (not vision or study-buddy)", async () => {
    // 1 game mistake
    await recordGameMistake(db, outboxPath, {
      childId: "default",
      subject: "math",
      problem: "5+7",
      errorType: "carry",
      userAnswer: 11,
      correctAnswer: 12,
      level: 1,
    });
    // 1 vision mistake (inserted directly to bypass the game path)
    db.prepare(
      "INSERT INTO sessions (id, child_id) VALUES (?, ?)"
    ).run("s_v1", "default");
    db.prepare(
      "INSERT INTO mistakes (session_id, subject, problem, error_type, source) VALUES (?, ?, ?, ?, ?)"
    ).run("s_v1", "math", "vision-only", "carry", "vision");

    const weak = await getGameWeakTopics(db, 7);
    expect(weak).toEqual([
      { errorType: "carry", count: 1, subject: "math" },
    ]);
  });

  it("aggregates by (subject, errorType), ordered by count desc", async () => {
    await seedMistakes();
    const weak = await getGameWeakTopics(db, 7);
    expect(weak).toEqual([
      { errorType: "carry", count: 3, subject: "math" },
      { errorType: "compute", count: 2, subject: "math" },
      { errorType: "borrow", count: 1, subject: "math" },
    ]);
  });

  it("respects the days filter (only mistakes within the window)", async () => {
    await seedMistakes();
    // Backdate the oldest mistake (5+7, a carry) beyond the window.
    db.prepare("UPDATE mistakes SET ts = ? WHERE id = (SELECT MIN(id) FROM mistakes)").run(Date.now() - 30 * 24 * 3600 * 1000);
    const weak = await getGameWeakTopics(db, 7);
    // Three carries were seeded; one dropped out, two remain.
    expect(weak).toEqual([
      { errorType: "carry", count: 2, subject: "math" },
      { errorType: "compute", count: 2, subject: "math" },
      { errorType: "borrow", count: 1, subject: "math" },
    ]);
  });

  it("returns [] when no game mistakes exist", async () => {
    expect(await getGameWeakTopics(db, 7)).toEqual([]);
  });
});

// Reference the import so it isn't tree-shaken; the outbox module is used
// by the worker, but having the import visible here documents the dependency.
void appendOutbox;
