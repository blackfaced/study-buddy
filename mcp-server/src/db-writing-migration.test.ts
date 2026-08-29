import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getDb, initDb } from "./db.js";

let tempDir: string | null = null;

afterEach(() => {
  try { getDb().close(); } catch {}
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = null;
});

describe("MCP writing schema migration", () => {
  it("creates the explainable attempt fields on a fresh database", () => {
    const db = initDb(":memory:");
    const columns = db.prepare("PRAGMA table_info(writing_attempts)").all() as Array<{ name: string }>;

    expect(columns.map((column) => column.name)).toEqual(
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
    const sessionColumns = db.prepare("PRAGMA table_info(sessions)").all() as Array<{ name: string }>;
    expect(sessionColumns.map((column) => column.name)).toContain("device_id");
    expect(db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'paired_devices'",
    ).get()).toBeDefined();
    expect(db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'mistake_photo_confirmations'",
    ).get()).toBeDefined();
    const mistakeIndex = db.prepare(
      "PRAGMA index_info(idx_mistakes_child_problem_source)",
    ).all() as Array<{ name: string }>;
    expect(mistakeIndex.map((column) => column.name)).toEqual(["child_id", "problem", "source"]);
  });

  it("upgrades a legacy writing_attempts table in place", () => {
    tempDir = mkdtempSync(join(tmpdir(), "study-buddy-mcp-writing-"));
    const path = join(tempDir, "study.db");
    const legacy = new Database(path);
    legacy.exec(`
      CREATE TABLE writing_words (char TEXT PRIMARY KEY, added_at INTEGER NOT NULL, added_by TEXT);
      CREATE TABLE writing_attempts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        char TEXT NOT NULL,
        level REAL NOT NULL,
        stroke_path TEXT,
        ts INTEGER NOT NULL
      );
    `);
    legacy.close();

    const db = initDb(path);
    const columns = db.prepare("PRAGMA table_info(writing_attempts)").all() as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).toContain("algorithm_version");
    expect(columns.map((column) => column.name)).toContain("model_review_json");
  });

  it("enforces device ownership references on an upgraded sessions table", () => {
    tempDir = mkdtempSync(join(tmpdir(), "study-buddy-mcp-device-"));
    const path = join(tempDir, "study.db");
    const legacy = new Database(path);
    legacy.exec(`
      CREATE TABLE children (id TEXT PRIMARY KEY, name TEXT NOT NULL);
      INSERT INTO children (id, name) VALUES ('default', '小宝');
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        child_id TEXT NOT NULL,
        started_at INTEGER NOT NULL DEFAULT 0,
        ended_at INTEGER,
        subject TEXT,
        total_minutes INTEGER DEFAULT 0,
        avg_focus_score REAL DEFAULT 0,
        posture_warning_count INTEGER DEFAULT 0,
        offtopic_count INTEGER DEFAULT 0,
        offtopic_recovered INTEGER DEFAULT 0
      );
      INSERT INTO sessions (id, child_id) VALUES ('legacy', 'default');
    `);
    legacy.close();

    const db = initDb(path);
    expect(() => db.prepare(
      "UPDATE sessions SET device_id = 'missing-device' WHERE id = 'legacy'",
    ).run()).toThrow();
    db.prepare(
      `INSERT INTO paired_devices
         (device_id, child_id, credential_hash, device_name, created_at, last_seen_at)
       VALUES ('device-1', 'default', 'digest', 'iPad', 1, 1)`,
    ).run();
    db.prepare("UPDATE sessions SET device_id = 'device-1' WHERE id = 'legacy'").run();
    expect(() => db.prepare(
      "UPDATE paired_devices SET device_id = 'renamed' WHERE device_id = 'device-1'",
    ).run()).toThrow();
    expect(() => db.prepare(
      "UPDATE paired_devices SET device_id = NULL WHERE device_id = 'device-1'",
    ).run()).toThrow();
  });

  it("preserves legacy mistake evidence while keeping source provenance separate", () => {

    tempDir = mkdtempSync(join(tmpdir(), "study-buddy-mcp-mistakes-"));
    const path = join(tempDir, "study.db");
    const legacy = new Database(path);
    legacy.exec(`
      CREATE TABLE mistakes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        ts INTEGER NOT NULL DEFAULT 0,
        child_id TEXT NOT NULL,
        problem TEXT,
        source TEXT
      );
      INSERT INTO mistakes (session_id, child_id, problem, source) VALUES
        ('legacy', 'default', '1+1', 'game'),
        ('legacy', 'default', '1+1', 'game'),
        ('legacy', 'default', '1+1', 'vision');
    `);
    legacy.close();

    const db = initDb(path);
    const rows = db.prepare(
      "SELECT source, COUNT(*) AS count FROM mistakes GROUP BY source ORDER BY source",
    ).all();
    expect(rows).toEqual([
      { source: "game", count: 2 },
      { source: "vision", count: 1 },
    ]);
    expect(db.prepare("SELECT COUNT(*) AS count FROM mistake_cases").get()).toEqual({ count: 3 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM learning_attempts").get()).toEqual({ count: 3 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM correction_obligations").get()).toEqual({ count: 3 });
  });

  it("drops correction_obligations.reviewed_count on a legacy database, preserving rows", () => {
    // reviewed_count was a dead concept (zero writers, no-op `< 3`
    // readers). The column is physically dropped in BOTH processes;
    // this pins the MCP-side idempotent drop.
    tempDir = mkdtempSync(join(tmpdir(), "study-buddy-mcp-obligations-"));
    const path = join(tempDir, "study.db");
    const legacy = new Database(path);
    legacy.exec(`
      CREATE TABLE correction_obligations (
        case_id TEXT PRIMARY KEY,
        status TEXT NOT NULL DEFAULT 'open',
        opened_at INTEGER NOT NULL,
        verified_at INTEGER,
        reviewed_count INTEGER NOT NULL DEFAULT 0
      );
      INSERT INTO correction_obligations (case_id, status, opened_at, reviewed_count)
        VALUES ('case:legacy', 'open', 1000, 2);
    `);
    legacy.close();

    const db = initDb(path);
    const columns = db.prepare("PRAGMA table_info(correction_obligations)").all() as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).not.toContain("reviewed_count");
    const row = db.prepare(
      "SELECT case_id, status, opened_at FROM correction_obligations WHERE case_id = 'case:legacy'",
    ).get();
    expect(row).toEqual({ case_id: "case:legacy", status: "open", opened_at: 1000 });

    // Idempotent: re-init on the already-migrated DB stays clean.
    const again = initDb(path);
    const columnsAgain = again.prepare("PRAGMA table_info(correction_obligations)").all() as Array<{ name: string }>;
    expect(columnsAgain.map((column) => column.name)).not.toContain("reviewed_count");
  });
});
