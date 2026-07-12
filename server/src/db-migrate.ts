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

    CREATE INDEX IF NOT EXISTS idx_sessions_child ON sessions(child_id, started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_posture_session ON posture_events(session_id, ts);
    CREATE INDEX IF NOT EXISTS idx_chat_session ON chat_turns(session_id, ts);
    CREATE INDEX IF NOT EXISTS idx_mistakes_session ON mistakes(session_id, ts);
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
