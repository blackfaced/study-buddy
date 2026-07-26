// src/db.ts
// SQLite schema + 默认数据初始化
//
// 设计要点：
// 1. 懒加载 singleton：首次调用 initDb()/getDb() 时才打开数据库文件
// 2. 测试可调用 initDb(":memory:") 重置到内存库，然后通过 getDb() 拿到同一个实例
// 3. 兼容老调用：`import { db } from "./db.js"` 通过 Proxy 转发到 getDb()
import Database from "better-sqlite3";
import { mkdirSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
// 解析 <repo>/data/study.db，与部署路径无关（之前硬编码 /Users/mac/study-buddy/...）
const DEFAULT_DB_PATH = process.env.STUDY_DB || resolve(__dirname, "..", "..", "data", "study.db");

let _db: Database.Database | null = null;
let _dbPath: string | null = null;

/** 初始化（重置）数据库连接。重复调用会关闭旧连接再开新连接。 */
export function initDb(path: string = DEFAULT_DB_PATH): Database.Database {
  if (_db) {
    try { _db.close(); } catch { /* ignore */ }
    _db = null;
  }
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const inst = new Database(path);
  inst.pragma("journal_mode = WAL");
  inst.pragma("foreign_keys = ON");
  runMigrations(inst);
  ensureDefaultChild(inst);
  _db = inst;
  _dbPath = path;
  return inst;
}

/** 拿到当前数据库实例。首次调用会走默认路径初始化。 */
export function getDb(): Database.Database {
  if (!_db) initDb();
  return _db!;
}

/** 报告当前 DB 文件路径（测试 / 启动日志用）。 */
export function getDbPath(): string {
  return _dbPath ?? DEFAULT_DB_PATH;
}

// Backward-compat: `import { db } from "./db.js"` 转发到 live instance
export const db = new Proxy({} as Database.Database, {
  get(_t, prop) {
    // @ts-expect-error — forward every property access to the live instance
    return getDb()[prop];
  },
});

// ============ schema 迁移 ============

function runMigrations(inst: Database.Database) {
  // 兼容老 DB：给已有表加新列。每条 ALTER 用 try/catch 忽略「column already exists」。
  // 顺序无所谓：每条 ALTER 是独立的。
  const alters = [
    "ALTER TABLE chat_turns ADD COLUMN state TEXT DEFAULT 'writing'",
    "ALTER TABLE mistakes ADD COLUMN hint TEXT",
    "ALTER TABLE sessions ADD COLUMN writing_turns INTEGER DEFAULT 0",
    // v0.5: vision-mistake columns
    "ALTER TABLE mistakes ADD COLUMN image_path TEXT",
    "ALTER TABLE mistakes ADD COLUMN vision_input TEXT",
    "ALTER TABLE mistakes ADD COLUMN vision_reasoning TEXT",
    "ALTER TABLE mistakes ADD COLUMN vision_model TEXT",
    "ALTER TABLE mistakes ADD COLUMN vision_ts INTEGER",
    // v0.5b: game-sync columns (mirror server/src/db-migrate.ts)
    "ALTER TABLE mistakes ADD COLUMN source TEXT DEFAULT 'study-buddy'",
    "ALTER TABLE mistakes ADD COLUMN user_answer TEXT",
    "ALTER TABLE mistakes ADD COLUMN correct_answer TEXT",
  ];
  for (const sql of alters) {
    try { inst.exec(sql); } catch { /* column already exists */ }
  }

  // 初始化 schema
  inst.exec(`
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

    -- v0.6: per-game-session summary (mirror of server/src/db-migrate.ts)
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

    CREATE INDEX IF NOT EXISTS idx_sessions_child ON sessions(child_id, started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_posture_session ON posture_events(session_id, ts);
    CREATE INDEX IF NOT EXISTS idx_chat_session ON chat_turns(session_id, ts);
    CREATE INDEX IF NOT EXISTS idx_mistakes_session ON mistakes(session_id, ts);
    CREATE INDEX IF NOT EXISTS idx_game_sessions_child ON game_sessions(child_id, started_at DESC);
  `);
}

function ensureDefaultChild(inst: Database.Database) {
  const existing = inst
    .prepare("SELECT id FROM children WHERE id = 'default'")
    .get();
  if (!existing) {
    inst
      .prepare("INSERT INTO children (id, name, grade) VALUES (?, ?, ?)")
      .run("default", "小宝", "二年级");
    inst
      .prepare("INSERT INTO settings (child_id, topic_whitelist) VALUES (?, ?)")
      .run(
        "default",
        JSON.stringify(["作业", "老师", "课本", "同学", "数学", "语文", "英语", "拼音", "生字"])
      );
    console.error("[study-buddy] Created default child '小宝' (id=default, grade=二年级)");
  }
}
