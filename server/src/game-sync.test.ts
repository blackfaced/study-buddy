import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { migrateSchema } from "./db-migrate.js";
import { getGameWeakTopics, recordGameSession, getGameDailyStats } from "./game-sync.js";
import { insertMistake } from "./routes/mistake-api.js";

let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  migrateSchema(db);
});

afterEach(() => {
  db.close();
});

describe("getGameWeakTopics", () => {
  function seedGameMistake(problem: string, errorType: string) {
    const result = insertMistake(db, {
      childId: "default",
      problem,
      userAnswer: "0",
      correctAnswer: "1",
      errorType,
      source: "game",
    });
    db.prepare("UPDATE mistakes SET subject = 'math' WHERE id = ?").run(result.id);
  }

  async function seedMistakes() {
    // 3 carry, 1 borrow, 2 compute
    seedGameMistake("5+7", "carry");
    seedGameMistake("8+6", "carry");
    seedGameMistake("9+4", "carry");
    seedGameMistake("15-8", "borrow");
    seedGameMistake("11-3", "compute");
    seedGameMistake("12-5", "compute");
  }

  it("only counts mistakes with source='game' (not vision or study-buddy)", async () => {
    // 1 game mistake
    seedGameMistake("5+7", "carry");
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

describe("recordGameSession", () => {
  it("inserts a row into game_sessions with the summary stats", async () => {
    const startedAt = Date.now() - 60_000;
    const endedAt = Date.now();
    const id = await recordGameSession(db, {
      childId: "default",
      appId: "candy-math-island",
      durationSec: 60,
      totalQuestions: 12,
      correctCount: 10,
      startedAt,
      endedAt,
    });
    expect(id).toBeGreaterThan(0);
    const row = db
      .prepare(
        "SELECT child_id, app_id, duration_sec, total_questions, correct_count, started_at, ended_at FROM game_sessions WHERE id = ?"
      )
      .get(id) as any;
    expect(row.child_id).toBe("default");
    expect(row.app_id).toBe("candy-math-island");
    expect(row.duration_sec).toBe(60);
    expect(row.total_questions).toBe(12);
    expect(row.correct_count).toBe(10);
    expect(row.started_at).toBe(startedAt);
    expect(row.ended_at).toBe(endedAt);
  });

  it("commits a game learning-session Source Event", async () => {
    await recordGameSession(db, {
      childId: "default",
      appId: "candy-math-island",
      durationSec: 60,
      totalQuestions: 5,
      correctCount: 4,
      startedAt: Date.now() - 60_000,
      endedAt: Date.now(),
    });
    const event = db.prepare(
      "SELECT record_type, record_id, event_type, payload_json FROM source_events",
    ).get() as any;
    expect(event.record_type).toBe("learning_session");
    expect(event.record_id).toMatch(/^game_session:[a-f0-9]{32}$/);
    expect(event.event_type).toBe("learning_session_completed");
    expect(JSON.parse(event.payload_json)).toMatchObject({
      kind: "learning_session",
      sessionKind: "game",
      appId: "candy-math-island",
      totalQuestions: 5,
      correctCount: 4,
    });
  });

  it("returns the same session and Source Record for an identical retry", async () => {
    const input = {
      childId: "default",
      appId: "candy-math-island",
      durationSec: 60,
      totalQuestions: 5,
      correctCount: 4,
      startedAt: Date.now() - 60_000,
      endedAt: Date.now(),
    };
    const first = await recordGameSession(db, input);
    const retry = await recordGameSession(db, input);
    expect(retry).toBe(first);
    expect(db.prepare("SELECT COUNT(*) AS count FROM game_sessions").get())
      .toEqual({ count: 1 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM source_events").get())
      .toEqual({ count: 1 });
  });

  it("rejects a session with totalQuestions=0 (nothing to record)", async () => {
    await expect(
      recordGameSession(db, {
        childId: "default",
        appId: "candy-math-island",
        durationSec: 60,
        totalQuestions: 0,
        correctCount: 0,
        startedAt: Date.now() - 60_000,
        endedAt: Date.now(),
      })
    ).rejects.toThrow(/totalQuestions/);
  });
});

describe("getGameDailyStats", () => {
  function seedSession(daysAgo: number, total: number, correct: number) {
    const startedAt = Date.now() - daysAgo * 24 * 3600 * 1000 - 30_000;
    const endedAt = startedAt + 60_000;
    db.prepare(
      `INSERT INTO game_sessions
         (child_id, app_id, duration_sec, total_questions, correct_count, started_at, ended_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run("default", "candy-math-island", 60, total, correct, startedAt, endedAt);
  }

  it("aggregates by day, returns one row per day with correct rate", async () => {
    seedSession(0, 12, 9);   // today: 9/12 = 75%
    seedSession(0, 8, 8);    // today: +8/8 → 17/20 = 85%
    seedSession(1, 10, 7);   // yesterday: 7/10 = 70%

    const stats = await getGameDailyStats(db, 7);
    expect(stats).toHaveLength(2);
    // Today: 17 correct / 20 total, two sessions.
    const today = stats[0];
    expect(today.sessionCount).toBe(2);
    expect(today.totalQuestions).toBe(20);
    expect(today.correctCount).toBe(17);
    expect(today.correctRate).toBe(85);
    // Yesterday: 1 session, 10 questions, 70%.
    const yesterday = stats[1];
    expect(yesterday.sessionCount).toBe(1);
    expect(yesterday.totalQuestions).toBe(10);
    expect(yesterday.correctCount).toBe(7);
    expect(yesterday.correctRate).toBe(70);
  });

  it("returns [] when no game sessions exist", async () => {
    expect(await getGameDailyStats(db, 7)).toEqual([]);
  });

  it("respects the days filter", async () => {
    seedSession(0, 5, 5);
    seedSession(10, 5, 5); // 10 days ago, out of 7-day window
    const stats = await getGameDailyStats(db, 7);
    expect(stats).toHaveLength(1);
    expect(stats[0].totalQuestions).toBe(5);
  });

  it("can filter by appId", async () => {
    // Two apps on the same day
    const startedAt = Date.now() - 30_000;
    const endedAt = Date.now();
    db.prepare(
      `INSERT INTO game_sessions
         (child_id, app_id, duration_sec, total_questions, correct_count, started_at, ended_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run("default", "candy-math-island", 60, 10, 8, startedAt, endedAt);
    db.prepare(
      `INSERT INTO game_sessions
         (child_id, app_id, duration_sec, total_questions, correct_count, started_at, ended_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run("default", "another-app", 60, 5, 5, startedAt, endedAt);

    const candyStats = await getGameDailyStats(db, 7, "candy-math-island");
    expect(candyStats).toHaveLength(1);
    expect(candyStats[0].totalQuestions).toBe(10);
    expect(candyStats[0].correctCount).toBe(8);
  });
});

// Reference the import so it isn't tree-shaken; the outbox module is used
// by the worker, but having the import visible here documents the dependency.
