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

  it("is idempotent — running it twice does not throw", () => {
    const db = freshDb();
    (globalThis as any).__migrateSchema(db);
    expect(() => (globalThis as any).__migrateSchema(db)).not.toThrow();
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
});
