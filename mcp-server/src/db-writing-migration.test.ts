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
});
