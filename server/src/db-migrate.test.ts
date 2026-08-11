import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";

// Bug 4: server/src/index.ts used `new Database(DB_PATH)` without running the
// schema migration, so when chat_turns.state (added by the mcp-server) didn't
// exist in the HTTP server's view, the /api/chat write would 500.
//
// Regression: `migrateSchema(db)` must ensure all v0.1 columns exist and be
// safe to call repeatedly (idempotent).

beforeEach(async () => {
  const { migrateSchema } = await import("./db-migrate.js");
  // stash the imported function on globalThis so individual tests can call it
  (globalThis as any).__migrateSchema = migrateSchema;
});

afterEach(() => {
  delete (globalThis as any).__migrateSchema;
});

function freshDb() {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  return db;
}

describe("migrateSchema", () => {
  it("creates the v0.1 tables on an empty database", () => {
    const db = freshDb();
    (globalThis as any).__migrateSchema(db);
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as Array<{ name: string }>;
    const names = tables.map((t) => t.name);
    expect(names).toContain("children");
    expect(names).toContain("sessions");
    expect(names).toContain("chat_turns");
    expect(names).toContain("posture_events");
    expect(names).toContain("mistakes");
    expect(names).toContain("source_installation");
    expect(names).toContain("source_subjects");
    expect(names).toContain("source_events");
    db.close();
  });

  it("adds the `state` column to chat_turns (Bug 4 root cause)", () => {
    const db = freshDb();
    (globalThis as any).__migrateSchema(db);
    const cols = db.prepare("PRAGMA table_info(chat_turns)").all() as Array<{ name: string }>;
    const colNames = cols.map((c) => c.name);
    expect(colNames).toContain("state");
    db.close();
  });

  it("adds the `writing_turns` column to sessions (denominator for offtopic rate)", () => {
    const db = freshDb();
    (globalThis as any).__migrateSchema(db);
    const cols = db.prepare("PRAGMA table_info(sessions)").all() as Array<{ name: string }>;
    const colNames = cols.map((c) => c.name);
    expect(colNames).toContain("writing_turns");
    db.close();
  });

  it("adds the `source` column to mistakes (study-buddy / game / vision)", () => {
    const db = freshDb();
    (globalThis as any).__migrateSchema(db);
    const cols = db.prepare("PRAGMA table_info(mistakes)").all() as Array<{ name: string }>;
    const colNames = cols.map((c) => c.name);
    expect(colNames).toContain("source");
    db.close();
  });

  it("is idempotent — running it twice does not throw", () => {
    const db = freshDb();
    (globalThis as any).__migrateSchema(db);
    expect(() => (globalThis as any).__migrateSchema(db)).not.toThrow();
    db.close();
  });

  it("keeps one immutable installation identity across migrations", () => {
    const db = freshDb();
    (globalThis as any).__migrateSchema(db);
    const first = db
      .prepare("SELECT installation_id AS id FROM source_installation")
      .get() as { id: string };
    (globalThis as any).__migrateSchema(db);
    const second = db
      .prepare("SELECT installation_id AS id FROM source_installation")
      .get() as { id: string };
    expect(second.id).toBe(first.id);
    expect(first.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(() =>
      db.prepare("UPDATE source_installation SET installation_id = ?").run("replacement"),
    ).toThrow(/immutable/);
    expect(() => db.prepare("DELETE FROM source_installation").run()).toThrow(
      /immutable/,
    );
    db.close();
  });

  it("binds every source event to the persistent source installation", () => {
    const db = freshDb();
    (globalThis as any).__migrateSchema(db);
    const foreignKeys = db.prepare("PRAGMA foreign_key_list(source_events)").all() as Array<{
      from: string;
      table: string;
      to: string;
    }>;
    expect(foreignKeys).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          from: "source_installation_id",
          table: "source_installation",
          to: "installation_id",
        }),
      ]),
    );
    db.close();
  });

  it("after migration, chat_turns accepts INSERT with the `state` column", () => {
    const db = freshDb();
    (globalThis as any).__migrateSchema(db);
    // default child is already seeded by migrateSchema — use it
    db.prepare("INSERT INTO sessions (id, child_id) VALUES (?, ?)").run("s1", "default");
    expect(() => {
      db.prepare(
        "INSERT INTO chat_turns (session_id, role, content, topic, redirected, state) VALUES (?, ?, ?, ?, ?, ?)"
      ).run("s1", "child", "hi", "learning", 0, "writing");
    }).not.toThrow();
    const row = db
      .prepare("SELECT state FROM chat_turns WHERE session_id = ?")
      .get("s1") as { state: string };
    expect(row.state).toBe("writing");
    db.close();
  });

  it("seeds the default child + settings row on first run", () => {
    const db = freshDb();
    (globalThis as any).__migrateSchema(db);
    const child = db.prepare("SELECT * FROM children WHERE id = 'default'").get() as any;
    expect(child).toBeDefined();
    expect(child.name).toBe("小宝");
    const settings = db.prepare("SELECT * FROM settings WHERE child_id = 'default'").get() as any;
    expect(settings).toBeDefined();
    db.close();
  });

  it("creates the game_sessions table for v0.6 time-mode runs", () => {
    const db = freshDb();
    (globalThis as any).__migrateSchema(db);
    const cols = db.prepare("PRAGMA table_info(game_sessions)").all() as Array<{ name: string }>;
    const names = cols.map((c) => c.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "id", "child_id", "app_id", "duration_sec", "total_questions",
        "correct_count", "started_at", "ended_at", "created_at",
      ])
    );
    db.close();
  });

  // v0.7 (issue #57): writing_words + writing_attempts tables
  it("creates the writing_words table (v0.7 write app library)", () => {
    const db = freshDb();
    (globalThis as any).__migrateSchema(db);
    const cols = db.prepare("PRAGMA table_info(writing_words)").all() as Array<{ name: string }>;
    const names = cols.map((c) => c.name);
    expect(names).toEqual(
      expect.arrayContaining(["char", "added_at", "added_by"]),
    );
    db.close();
  });

  it("writing_words.char is the PRIMARY KEY (duplicate INSERT OR IGNORE is a no-op)", () => {
    const db = freshDb();
    (globalThis as any).__migrateSchema(db);
    // Two-step: insert, then try again. The second should fail loudly
    // unless we wrap in INSERT OR IGNORE — confirm the PRIMARY KEY
    // constraint is actually in place.
    db.prepare("INSERT OR IGNORE INTO writing_words (char) VALUES (?)").run("一");
    db.prepare("INSERT OR IGNORE INTO writing_words (char) VALUES (?)").run("一");
    const count = (db.prepare("SELECT COUNT(*) as c FROM writing_words").get() as any).c;
    expect(count).toBe(1);
    db.close();
  });

  it("creates the writing_attempts table (v0.7 stroke history)", () => {
    const db = freshDb();
    (globalThis as any).__migrateSchema(db);
    const cols = db.prepare("PRAGMA table_info(writing_attempts)").all() as Array<{ name: string }>;
    const names = cols.map((c) => c.name);
    expect(names).toEqual(
      expect.arrayContaining(["id", "char", "level", "stroke_path", "ts"]),
    );
    db.close();
  });

  it("adds explainable handwriting assessment fields without replacing legacy attempt columns", () => {
    const db = freshDb();
    (globalThis as any).__migrateSchema(db);
    const cols = db.prepare("PRAGMA table_info(writing_attempts)").all() as Array<{ name: string }>;
    const names = cols.map((c) => c.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "level",
        "stroke_path",
        "score",
        "display_band",
        "status",
        "strokes_json",
        "assessment_json",
        "process_json",
        "algorithm_version",
        "model_review_json",
      ]),
    );
    db.close();
  });

  it("upgrades a legacy writing_attempts table in place", () => {
    const db = freshDb();
    db.exec(`
      CREATE TABLE writing_words (
        char TEXT PRIMARY KEY,
        added_at INTEGER NOT NULL,
        added_by TEXT
      );
      CREATE TABLE writing_attempts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        char TEXT NOT NULL,
        level REAL NOT NULL,
        stroke_path TEXT,
        ts INTEGER NOT NULL
      );
    `);

    expect(() => (globalThis as any).__migrateSchema(db)).not.toThrow();
    const cols = db.prepare("PRAGMA table_info(writing_attempts)").all() as Array<{ name: string }>;
    expect(cols.map((column) => column.name)).toEqual(
      expect.arrayContaining([
        "score",
        "display_band",
        "status",
        "strokes_json",
        "assessment_json",
        "process_json",
        "algorithm_version",
        "model_review_json",
      ]),
    );
    db.close();
  });

  it("writing_attempts cascades on writing_words delete (FK)", () => {
    const db = freshDb();
    (globalThis as any).__migrateSchema(db);
    db.prepare("INSERT INTO writing_words (char) VALUES (?)").run("一");
    db.prepare("INSERT INTO writing_attempts (char, level, stroke_path) VALUES (?, ?, ?)").run("一", 1.0, "M 0 0 L 1 1");
    db.prepare("DELETE FROM writing_words WHERE char = ?").run("一");
    const count = (db.prepare("SELECT COUNT(*) as c FROM writing_attempts").get() as any).c;
    expect(count).toBe(0);
    db.close();
  });
});
