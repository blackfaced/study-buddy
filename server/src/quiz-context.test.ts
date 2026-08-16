// server/src/quiz-context.test.ts
//
// Tests for POST /api/game/quiz-context (#34a-2, issue #99).
// The endpoint tells the client whether the current session is
// eligible for 30% mistake-mix, and if so which mistakes to draw from.
// The server is the single source of truth for the per-day session
// count (the kid may have 2 devices open).

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
let testSessionId: string;

const CHILD = "default";
const TODAY = "2026-08-10";
const TODAY_START = new Date(`${TODAY}T00:00:00`).getTime();

/** Insert N game_sessions for the child, all on the given day (00:00–24:00). */
function seedGameSessions(n: number, day: string = TODAY): void {
  const start = new Date(`${day}T00:00:00`).getTime();
  for (let i = 0; i < n; i++) {
    db.prepare(
      `INSERT INTO game_sessions
         (child_id, app_id, duration_sec, total_questions, correct_count, started_at, ended_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      CHILD,
      "candy-math-island",
      60,
      10,
      8,
      start + i * 60_000, // 1 minute apart so they're distinct rows
      start + i * 60_000 + 60_000,
    );
  }
}

/** Insert N mistakes for the child, with different problems so dedupe is irrelevant. */
function seedMistakes(n: number): void {
  for (let i = 0; i < n; i++) {
    db.prepare(
      `INSERT INTO mistakes
         (session_id, child_id, problem, user_answer, correct_answer, error_type, source)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      testSessionId,
      CHILD,
      `prob-${i}`,
      String(i),
      String(i + 1),
      "compute",
      "candy-math-island",
    );
  }
}

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "study-buddy-quiz-context-"));
  db = new Database(join(tmpDir, "test.db"));
  db.pragma("journal_mode = WAL");
  migrateSchema(db);
  // The mistakes table has a FOREIGN KEY on session_id → sessions(id),
  // so seed a real session up front. Each test uses this one session_id.
  testSessionId = "test-session-1";
  db.prepare(
    "INSERT INTO sessions (id, child_id, subject) VALUES (?, ?, ?)",
  ).run(testSessionId, CHILD, "math");
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

describe("POST /api/game/quiz-context (issue #99: 30% mistake-mix window)", () => {
  it("QC1: 0 sessions today + 3 mistakes → eligible:true, mistakes:3", async () => {
    // No sessions, 3 fresh mistakes
    seedMistakes(3);
    const res = await request(app)
      .post("/api/game/quiz-context")
      .send({ childId: CHILD, date: TODAY });
    expect(res.status).toBe(200);
    expect(res.body.eligible).toBe(true);
    expect(Array.isArray(res.body.mistakes)).toBe(true);
    expect(res.body.mistakes).toHaveLength(3);
    // Shape: {id, problem, answer, errorType}
    for (const m of res.body.mistakes) {
      expect(typeof m.id).toBe("number");
      expect(typeof m.problem).toBe("string");
      expect(typeof m.answer).toBe("string");
      expect(typeof m.errorType).toBe("string");
    }
  });

  it("QC2: 4 sessions today → still eligible:true (boundary <5)", async () => {
    // DB persists across tests; this is the 5th session total (1 from QC1
    // is not added by this test — QC1 didn't seed any game_sessions). We
    // start fresh-ish by clearing game_sessions.
    db.exec("DELETE FROM game_sessions");
    seedGameSessions(4);
    const res = await request(app)
      .post("/api/game/quiz-context")
      .send({ childId: CHILD, date: TODAY });
    expect(res.status).toBe(200);
    expect(res.body.eligible).toBe(true);
  });

  it("QC3: 5 sessions today → eligible:false (boundary reached)", async () => {
    db.exec("DELETE FROM game_sessions");
    seedGameSessions(5);
    const res = await request(app)
      .post("/api/game/quiz-context")
      .send({ childId: CHILD, date: TODAY });
    expect(res.status).toBe(200);
    expect(res.body.eligible).toBe(false);
    // Even with mistakes available, eligible:false means client ignores them
    expect(res.body.mistakes).toEqual([]);
  });

  it("QC4: 6 sessions today → eligible:false (over the limit)", async () => {
    db.exec("DELETE FROM game_sessions");
    seedGameSessions(6);
    const res = await request(app)
      .post("/api/game/quiz-context")
      .send({ childId: CHILD, date: TODAY });
    expect(res.status).toBe(200);
    expect(res.body.eligible).toBe(false);
  });

  it("QC5: day boundary — yesterday's sessions don't count for today", async () => {
    db.exec("DELETE FROM game_sessions");
    // 10 sessions on YESTERDAY (over the limit on that day)
    seedGameSessions(10, "2026-08-09");
    // 0 sessions on TODAY
    const res = await request(app)
      .post("/api/game/quiz-context")
      .send({ childId: CHILD, date: TODAY });
    expect(res.status).toBe(200);
    expect(res.body.eligible).toBe(true);
  });

  it("QC6: empty mistakes array → eligible:true but mistakes:[] (5th session day, no review load)", async () => {
    db.exec("DELETE FROM game_sessions");
    db.exec("DELETE FROM mistakes");
    seedGameSessions(2); // eligible
    const res = await request(app)
      .post("/api/game/quiz-context")
      .send({ childId: CHILD, date: TODAY });
    expect(res.status).toBe(200);
    expect(res.body.eligible).toBe(true);
    expect(res.body.mistakes).toEqual([]);
  });

  it("QC7: 100 sessions today but only 4 on a different childId → eligible:true for the quiet child", async () => {
    db.exec("DELETE FROM game_sessions");
    db.exec("DELETE FROM mistakes");
    // alice must exist in children (FK on game_sessions.child_id)
    db.prepare("INSERT OR IGNORE INTO children (id, name) VALUES (?, ?)").run(
      "alice",
      "Alice",
    );
    // 100 sessions for "alice" (way over the limit for alice)
    for (let i = 0; i < 100; i++) {
      db.prepare(
        `INSERT INTO game_sessions
           (child_id, app_id, duration_sec, total_questions, correct_count, started_at, ended_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        "alice",
        "candy-math-island",
        60,
        10,
        8,
        TODAY_START + i * 60_000,
        TODAY_START + i * 60_000 + 60_000,
      );
    }
    // 0 sessions for "default" (the kid using this client)
    const res = await request(app)
      .post("/api/game/quiz-context")
      .send({ childId: CHILD, date: TODAY });
    expect(res.status).toBe(200);
    expect(res.body.eligible).toBe(true);
  });

  it("QC8: missing date field returns 400", async () => {
    const res = await request(app)
      .post("/api/game/quiz-context")
      .send({ childId: CHILD });
    expect(res.status).toBe(400);
  });

  it("QC9: missing childId defaults to 'default' (backwards compat)", async () => {
    db.exec("DELETE FROM game_sessions");
    db.exec("DELETE FROM mistakes");
    const res = await request(app)
      .post("/api/game/quiz-context")
      .send({ date: TODAY });
    expect(res.status).toBe(200);
    // Just check it doesn't 400 and the shape is correct
    expect(typeof res.body.eligible).toBe("boolean");
    expect(Array.isArray(res.body.mistakes)).toBe(true);
  });

  it("QC10: only mistakes with reviewed_count < 3 are returned (3-correct cascade filter)", async () => {
    db.exec("DELETE FROM game_sessions");
    db.exec("DELETE FROM mistakes");
    // Insert 2 fresh mistakes + 1 already-mastered (reviewed_count=3)
    seedMistakes(2);
    db.prepare(
      `INSERT INTO mistakes
         (session_id, child_id, problem, user_answer, correct_answer, error_type, source, reviewed_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      testSessionId,
      CHILD,
      "mastered",
      "99",
      "100",
      "compute",
      "candy-math-island",
      3,
    );
    const res = await request(app)
      .post("/api/game/quiz-context")
      .send({ childId: CHILD, date: TODAY });
    expect(res.status).toBe(200);
    // Only the 2 fresh mistakes, not the mastered one
    expect(res.body.mistakes).toHaveLength(2);
    for (const m of res.body.mistakes) {
      expect(m.problem).not.toBe("mastered");
    }
  });
});

// =====================================================================
// Namespace isolation for mistakes (regression for the test-fixture
// pollution bug, 2026-08-16).
//
// The picker already filters by child_id in the WHERE clause
// (see server/src/routes/quiz-context.ts line 142), so a test
// script that POSTs /api/game/mistake with `childId: "test-..."`
// will write to a different namespace than the production kid. This
// test pins the contract: a mistake recorded under childId "test-x"
// must NOT appear in the production kid's ("default") quiz-context
// pool. Without this, future test scripts could regress to the
// 2026-08-16 pattern of using childId="default" and polluting the
// kid's mistake pool with "nexus-test-7+5" / "live-..." garbage.
//
// The same childId-as-namespace pattern is used in the MN system
// (see mn-observation.test.ts "Same-child binding rotation"). The
// mistakes table doesn't have MN's binding_id, but childId serves
// the same isolation purpose here.
// =====================================================================

describe("POST /api/game/quiz-context (namespace isolation)", () => {
  it("test-fixture mistakes under a non-default childId are NOT served to the production kid", async () => {
    // The production kid (childId="default") has one real mistake.
    db.prepare(`
      INSERT INTO mistakes (session_id, ts, problem, user_answer, correct_answer, error_type, source, child_id)
      VALUES (?, ?, '7+5', '11', '12', 'compute', 'game', 'default')
    `).run(testSessionId, TODAY_START);
    // A test run (childId="test-runner") polluted the DB with garbage.
    db.prepare(`
      INSERT INTO mistakes (session_id, ts, problem, user_answer, correct_answer, error_type, source, child_id)
      VALUES (?, ?, 'nexus-test-7+5', '11', '12', 'compute', 'game', 'test-runner')
    `).run(testSessionId, TODAY_START);
    db.prepare(`
      INSERT INTO mistakes (session_id, ts, problem, user_answer, correct_answer, error_type, source, child_id)
      VALUES (?, ?, 'live-nexus-3+4', '99', '0', 'compute', 'game', 'test-runner')
    `).run(testSessionId, TODAY_START);

    // The production kid asks for their quiz-context.
    const res = await request(app)
      .post("/api/game/quiz-context")
      .send({ childId: "default", date: TODAY });

    expect(res.status).toBe(200);
    expect(res.body.eligible).toBe(true);
    // Namespace isolation: no mistake whose child_id != "default" leaks.
    // (The shared test DB accumulates mistakes from earlier tests, so we
    // assert on the SET of returned problems, not the absolute count.)
    const returnedProblems = (res.body.mistakes as Array<{ problem: string }>).map((m) => m.problem);
    expect(returnedProblems).toContain("7+5");                       // real prod mistake is there
    expect(returnedProblems).not.toContain("nexus-test-7+5");        // test-runner did NOT leak
    expect(returnedProblems).not.toContain("live-nexus-3+4");        // test-runner did NOT leak
    const testFixtureLeak = returnedProblems.some((p) => /nexus|live-|^test-/.test(p));
    expect(testFixtureLeak).toBe(false);
  });

  it("a different kid's mistakes are isolated from the production kid", async () => {
    // Two kids, two distinct namespaces — the cross-child test the
    // user reported in 2026-08-16. Picker must filter by child_id.
    db.prepare(`
      INSERT INTO mistakes (session_id, ts, problem, user_answer, correct_answer, error_type, source, child_id)
      VALUES (?, ?, 'iso-4+3', '6', '7', 'compute', 'game', 'alice')
    `).run(testSessionId, TODAY_START);
    db.prepare(`
      INSERT INTO mistakes (session_id, ts, problem, user_answer, correct_answer, error_type, source, child_id)
      VALUES (?, ?, 'iso-5+2', '6', '7', 'compute', 'game', 'bob')
    `).run(testSessionId, TODAY_START);

    const aliceRes = await request(app)
      .post("/api/game/quiz-context")
      .send({ childId: "alice", date: TODAY });
    const aliceProblems = (aliceRes.body.mistakes as Array<{ problem: string }>).map((m) => m.problem);
    expect(aliceProblems).toContain("iso-4+3");
    expect(aliceProblems).not.toContain("iso-5+2"); // bob's did NOT leak

    const bobRes = await request(app)
      .post("/api/game/quiz-context")
      .send({ childId: "bob", date: TODAY });
    const bobProblems = (bobRes.body.mistakes as Array<{ problem: string }>).map((m) => m.problem);
    expect(bobProblems).toContain("iso-5+2");
    expect(bobProblems).not.toContain("iso-4+3"); // alice's did NOT leak
  });
});
