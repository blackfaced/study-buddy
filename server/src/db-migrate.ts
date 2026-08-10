// src/db-migrate.ts
// Schema migration for the HTTP server's SQLite database.
//
// Bug 4 (v0.1): server/src/index.ts only did `new Database(DB_PATH)` without
// running the migration defined in mcp-server/src/db.ts. When the HTTP
// server tried to write to chat_turns.state, the column didn't exist (in
// the server's view) and the INSERT 500'd.
//
// Fix: extract the schema bootstrap into a function, import it from the
// server, and call it at startup. The function is idempotent — every
// `ALTER TABLE ... ADD COLUMN` is wrapped in try/catch because SQLite
// throws "duplicate column" on the second call.

import type Database from "better-sqlite3";

export function migrateSchema(db: Database.Database): void {
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  // 兼容老 DB：给已有表加新列（try/catch 实现 idempotent）
  try { db.exec(`ALTER TABLE chat_turns ADD COLUMN state TEXT DEFAULT 'writing'`); } catch {}
  try { db.exec(`ALTER TABLE mistakes ADD COLUMN hint TEXT`); } catch {}
  try { db.exec(`ALTER TABLE sessions ADD COLUMN writing_turns INTEGER DEFAULT 0`); } catch {}
  // v0.5: vision-mistake columns
  try { db.exec(`ALTER TABLE mistakes ADD COLUMN image_path TEXT`); } catch {}
  try { db.exec(`ALTER TABLE mistakes ADD COLUMN vision_input TEXT`); } catch {}
  try { db.exec(`ALTER TABLE mistakes ADD COLUMN vision_reasoning TEXT`); } catch {}
  try { db.exec(`ALTER TABLE mistakes ADD COLUMN vision_model TEXT`); } catch {}
  try { db.exec(`ALTER TABLE mistakes ADD COLUMN vision_ts INTEGER`); } catch {}
  // v0.5b: game-sync columns. `source` is one of "study-buddy" | "game" | "vision" — let
  // us split mistake streams when computing weak topics for the agent.
  try { db.exec(`ALTER TABLE mistakes ADD COLUMN source TEXT DEFAULT 'study-buddy'`); } catch {}
  try { db.exec(`ALTER TABLE mistakes ADD COLUMN user_answer TEXT`); } catch {}
  try { db.exec(`ALTER TABLE mistakes ADD COLUMN correct_answer TEXT`); } catch {}
  // v0.8 (#34a-1, issue #98): per-child mistake dedupe. Existing rows are
  // back-filled with child_id = 'default' so the UNIQUE index can be built
  // without conflicts. The endpoint (/api/game/mistake) accepts an explicit
  // childId; missing/empty defaults to 'default' for backwards compat.
  try { db.exec(`ALTER TABLE mistakes ADD COLUMN child_id TEXT NOT NULL DEFAULT 'default'`); } catch {}

  // v0.8 (#34a-1, issue #98): deduplicate existing rows before building
  // the UNIQUE index below. Older versions of the app could insert many
  // mistakes with the same `problem` (e.g. candy-math-island sync fired
  // every wrong answer), and now that child_id is filled with 'default'
  // they would all collide on (default, problem). Keep the earliest row
  // (smallest id) per (child_id, problem) and drop the rest. This is
  // a one-time migration; subsequent inserts go through the new deduped
  // /api/game/mistake endpoint so no further dupes can be created.
  db.exec(`
    DELETE FROM mistakes
    WHERE id NOT IN (
      SELECT MIN(id)
      FROM mistakes
      GROUP BY child_id, problem
    );
  `);

  // 初始化 schema
  db.exec(`
    CREATE TABLE IF NOT EXISTS children (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      birth_year INTEGER,
      grade TEXT,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000)
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      child_id TEXT NOT NULL,
      started_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000),
      ended_at INTEGER,
      subject TEXT,
      total_minutes INTEGER DEFAULT 0,
      avg_focus_score REAL DEFAULT 0,
      posture_warning_count INTEGER DEFAULT 0,
      offtopic_count INTEGER DEFAULT 0,
      offtopic_recovered INTEGER DEFAULT 0,
      writing_turns INTEGER DEFAULT 0,
      FOREIGN KEY (child_id) REFERENCES children(id)
    );

    CREATE TABLE IF NOT EXISTS posture_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      ts INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000),
      score REAL,
      warning TEXT,
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS chat_turns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      ts INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000),
      role TEXT NOT NULL,
      content TEXT,
      topic TEXT,
      redirected INTEGER DEFAULT 0,
      state TEXT DEFAULT 'writing',
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS mistakes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      ts INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000),
      subject TEXT,
      problem TEXT,
      error_type TEXT,
      hint TEXT,
      reviewed_count INTEGER DEFAULT 0,
      image_path TEXT,
      vision_input TEXT,
      vision_reasoning TEXT,
      vision_model TEXT,
      vision_ts INTEGER,
      source TEXT DEFAULT 'study-buddy',
      user_answer TEXT,
      correct_answer TEXT,
      child_id TEXT NOT NULL DEFAULT 'default',
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS settings (
      child_id TEXT PRIMARY KEY,
      topic_whitelist TEXT,
      posture_threshold REAL DEFAULT 0.6,
      session_limit_minutes INTEGER,
      updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000),
      FOREIGN KEY (child_id) REFERENCES children(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS limit_decisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      child_id TEXT NOT NULL,
      decided_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000),
      mode TEXT NOT NULL,
      until_ts INTEGER,
      note TEXT,
      FOREIGN KEY (child_id) REFERENCES children(id)
    );

    -- v0.6: per-game-session summary (one row per finished time-mode run).
    -- Used for daily correct-rate + questions-completed aggregations.
    CREATE TABLE IF NOT EXISTS game_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      child_id TEXT NOT NULL,
      app_id TEXT NOT NULL,
      duration_sec INTEGER NOT NULL,
      total_questions INTEGER NOT NULL,
      correct_count INTEGER NOT NULL,
      started_at INTEGER NOT NULL,
      ended_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000),
      FOREIGN KEY (child_id) REFERENCES children(id)
    );

    -- v0.7 (issue #57): write-app library + attempt history.
    -- writing_words is the kid's per-character word library.
    -- char is the PRIMARY KEY so duplicates are silently rejected on
    -- INSERT OR IGNORE below. writing_attempts stores the SVG stroke
    -- path the kid actually drew, so v0.2+ can analyze patterns.
    CREATE TABLE IF NOT EXISTS writing_words (
      char TEXT PRIMARY KEY,
      added_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000),
      added_by TEXT DEFAULT 'parent'
    );

    CREATE TABLE IF NOT EXISTS writing_attempts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      char TEXT NOT NULL,
      level REAL NOT NULL,
      stroke_path TEXT,
      ts INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000),
      FOREIGN KEY (char) REFERENCES writing_words(char) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_child ON sessions(child_id, started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_posture_session ON posture_events(session_id, ts);
    CREATE INDEX IF NOT EXISTS idx_chat_session ON chat_turns(session_id, ts);
    CREATE INDEX IF NOT EXISTS idx_mistakes_session ON mistakes(session_id, ts);
    CREATE INDEX IF NOT EXISTS idx_game_sessions_child ON game_sessions(child_id, started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_writing_attempts_char ON writing_attempts(char, ts DESC);
    -- v0.8 (#34a-1, issue #98): UNIQUE on (child_id, problem) — the
    -- foundation for "auto-record once, dedupe across multiple wrong
    -- answers" without a SELECT-then-INSERT race. T2 (#99) and T3 (#100)
    -- build on top of this index.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_mistakes_child_problem ON mistakes(child_id, problem);
  `);

  // 首次启动：建一个默认孩子
  const existing = db.prepare("SELECT id FROM children WHERE id = 'default'").get();
  if (!existing) {
    db.prepare("INSERT INTO children (id, name, grade) VALUES (?, ?, ?)").run(
      "default", "小宝", "二年级"
    );
    db.prepare(
      "INSERT INTO settings (child_id, topic_whitelist) VALUES (?, ?)"
    ).run(
      "default",
      JSON.stringify(["作业", "老师", "课本", "同学", "数学", "语文", "英语", "拼音", "生字"])
    );
  }
}
